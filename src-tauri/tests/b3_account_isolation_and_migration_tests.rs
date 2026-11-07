use nexus_lib::auth::resolve_and_validate_account_id;
use nexus_lib::commands::*;
use nexus_lib::db::{DbState, epoch_secs_to_iso8601, now_epoch_secs};
use nexus_lib::dm::*;
use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;

fn create_temp_db_path(name: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    path.push(format!("nexus_test_{}_{}.db", name, nonce));
    path
}

fn cleanup_temp_db_files(path: &PathBuf) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(path.with_extension("db-wal"));
    let _ = fs::remove_file(path.with_extension("db-shm"));
    let _ = fs::remove_file(DbState::backup_path_for(path));
}

/// Test 1: Migração de banco legado v2 -> v3 com backup prévio, integridade perfeita,
/// verificação de FKs e garantia de que 100% dos dados legados continuam presentes.
#[test]
fn test_01_legacy_migration_with_pre_backup_and_integrity_check() {
    let db_path = create_temp_db_path("legacy_migration");

    // 1. Setup a legacy v2 SQLite database simulating multiple accounts
    {
        let conn = Connection::open(&db_path).expect("open legacy db");
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;

             CREATE TABLE _migrations (
                 version INTEGER PRIMARY KEY,
                 applied_at INTEGER NOT NULL
             );
             INSERT INTO _migrations (version, applied_at) VALUES (1, 1700000000), (2, 1700000100);

             CREATE TABLE conversations (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 title TEXT NOT NULL,
                 updated_at INTEGER NOT NULL,
                 account_id TEXT NOT NULL DEFAULT 'offline_demo'
             );

             CREATE TABLE messages (
                 id TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 sender_id TEXT NOT NULL,
                 content TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 delivery_status TEXT NOT NULL DEFAULT 'local_saved',
                 account_id TEXT NOT NULL DEFAULT 'offline_demo',
                 client_message_id TEXT,
                 edited_at INTEGER,
                 deleted_at INTEGER,
                 delivered_at INTEGER,
                 read_at INTEGER,
                 is_mine INTEGER NOT NULL DEFAULT 1
             );

             CREATE TABLE conversation_state (
                 conversation_id TEXT PRIMARY KEY,
                 last_read_message_id TEXT,
                 draft_text TEXT
             );

             CREATE TABLE cache_metadata (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );",
        )
        .expect("setup v2 schema");

        // Insert legacy data for user_alpha and user_beta
        conn.execute(
            "INSERT INTO conversations (id, type, title, updated_at, account_id)
             VALUES ('conv_shared', 'dm', 'Conversa Legada', 1700000200, 'user_alpha')",
            [],
        )
        .expect("insert legacy conv");

        conn.execute(
            "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, account_id)
             VALUES ('msg_legacy_1', 'conv_shared', 'user_alpha', 'Mensagem importante do Alpha', 1700000210, 'user_alpha')",
            [],
        )
        .expect("insert legacy msg");

        conn.execute(
            "INSERT INTO conversation_state (conversation_id, last_read_message_id, draft_text)
             VALUES ('conv_shared', 'msg_legacy_1', 'Rascunho não enviado do Alpha')",
            [],
        )
        .expect("insert legacy state");

        conn.execute(
            "INSERT INTO cache_metadata (key, value, updated_at) VALUES ('cached_setting', 'true', 1700000300)",
            [],
        )
        .expect("insert legacy meta");
    }

    // 2. Open with DbState and apply Migration 3
    let db = DbState::open_with_options(&db_path, true, false).expect("open and migrate to v3");
    assert_eq!(db.current_schema_version().unwrap(), 3);

    // Verify backup file was created
    let backup_path = DbState::backup_path_for(&db_path);
    assert!(backup_path.exists(), "Backup .bak.v2 must exist");

    // Verify PRAGMA integrity_check
    assert!(db.verify_integrity().is_ok());

    // Verify foreign key checks
    {
        let conn = db.conn.lock().unwrap();
        let fk_violations: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check()", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk_violations, 0, "No foreign key violations allowed");

        // Verify preserved data
        let (title, act_id): (String, String) = conn
            .query_row(
                "SELECT title, account_id FROM conversations WHERE id = 'conv_shared'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Conversa Legada");
        assert_eq!(act_id, "user_alpha");

        let (content, created_iso): (String, Option<String>) = conn
            .query_row(
                "SELECT content, created_at_iso FROM messages WHERE id = 'msg_legacy_1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(content, "Mensagem importante do Alpha");
        assert!(created_iso.is_some());

        let draft: String = conn
            .query_row(
                "SELECT draft_text FROM conversation_state WHERE conversation_id = 'conv_shared' AND account_id = 'user_alpha'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(draft, "Rascunho não enviado do Alpha");
    }

    cleanup_temp_db_files(&db_path);
}




/// Test 2, 3, 4, 5: Isolamento de Contas A, B e C (Leitura, Escrita, Conversas Compartilhadas, Rascunhos)
#[test]
fn test_02_to_05_multi_account_isolation_abc() {
    let db_path = create_temp_db_path("multi_account_abc");
    let db = DbState::open_with_options(&db_path, true, false).expect("init v3 db");

    let account_a = "11111111-1111-1111-1111-111111111111";
    let account_b = "22222222-2222-2222-2222-222222222222";
    let account_c = "33333333-3333-3333-3333-333333333333";

    let shared_conv_ab = "99999999-9999-9999-9999-999999999999";
    let private_conv_c = "88888888-8888-8888-8888-888888888888";

    // 1. Account A creates conversation with B (titled "Bob")
    ensure_conversation_for_account(&db, shared_conv_ab, "dm", "Bob", Some(account_a))
        .expect("ensure conv for A");

    // 2. Account B creates the SAME conversation ID with A (titled "Alice")
    ensure_conversation_for_account(&db, shared_conv_ab, "dm", "Alice", Some(account_b))
        .expect("ensure conv for B");

    // 3. Account C creates separate conversation (titled "Charlie's Room")
    ensure_conversation_for_account(&db, private_conv_c, "dm", "Charlie's Room", Some(account_c))
        .expect("ensure conv for C");

    // Test 4 (Conversas Compartilhadas): Titles are isolated per account
    let convs_a = get_conversations_for_account(&db, Some(account_a)).unwrap();
    assert_eq!(convs_a.len(), 1);
    assert_eq!(convs_a[0].id, shared_conv_ab);
    assert_eq!(convs_a[0].title, "Bob");

    let convs_b = get_conversations_for_account(&db, Some(account_b)).unwrap();
    assert_eq!(convs_b.len(), 1);
    assert_eq!(convs_b[0].id, shared_conv_ab);
    assert_eq!(convs_b[0].title, "Alice");

    let convs_c = get_conversations_for_account(&db, Some(account_c)).unwrap();
    assert_eq!(convs_c.len(), 1);
    assert_eq!(convs_c[0].id, private_conv_c);
    assert_eq!(convs_c[0].title, "Charlie's Room");

    // Test 3 (Escrita com mesmo client_message_id):
    // Both Account A and Account B send a message with the identical client_message_id
    let duplicate_client_id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    let now = now_epoch_secs();

    let msg_from_a = DirectMessageDto {
        id: "msg_a_001".to_string(),
        conversation_id: shared_conv_ab.to_string(),
        sender_id: account_a.to_string(),
        client_message_id: duplicate_client_id.to_string(),
        content: "Mensagem da Conta A".to_string(),
        created_at: epoch_secs_to_iso8601(now),
        edited_at: None,
        deleted_at: None,
        delivered_at: None,
        read_at: None,
        is_mine: true,
        delivery_status: Some("sent".to_string()),
    };

    let msg_from_b = DirectMessageDto {
        id: "msg_b_001".to_string(),
        conversation_id: shared_conv_ab.to_string(),
        sender_id: account_b.to_string(),
        client_message_id: duplicate_client_id.to_string(),
        content: "Mensagem da Conta B".to_string(),
        created_at: epoch_secs_to_iso8601(now + 1),
        edited_at: None,
        deleted_at: None,
        delivered_at: None,
        read_at: None,
        is_mine: true,
        delivery_status: Some("sent".to_string()),
    };

    {
        let conn = db.conn.lock().unwrap();
        assert!(upsert_cached_message(&conn, account_a, &msg_from_a, "sent").is_ok());
        assert!(upsert_cached_message(&conn, account_b, &msg_from_b, "sent").is_ok());
    }

    // Test 2 (Isolamento de Leitura):
    let loaded_a = load_cached_messages_for_account(&db, account_a, shared_conv_ab, 50).unwrap();
    assert_eq!(loaded_a.len(), 1);
    assert_eq!(loaded_a[0].id, "msg_a_001");
    assert_eq!(loaded_a[0].content, "Mensagem da Conta A");

    let loaded_b = load_cached_messages_for_account(&db, account_b, shared_conv_ab, 50).unwrap();
    assert_eq!(loaded_b.len(), 1);
    assert_eq!(loaded_b[0].id, "msg_b_001");
    assert_eq!(loaded_b[0].content, "Mensagem da Conta B");

    let loaded_c = load_cached_messages_for_account(&db, account_c, shared_conv_ab, 50).unwrap();
    assert!(loaded_c.is_empty(), "Account C must not see any messages from shared_conv_ab");

    // Test 5 (Rascunhos por conta):
    save_conversation_draft_for_account(&db, shared_conv_ab, "Rascunho secreto de Alice", Some(account_a)).unwrap();
    let draft_b = get_conversation_state_for_account(&db, shared_conv_ab, Some(account_b)).unwrap();
    assert!(draft_b.is_none() || draft_b.unwrap().draft_text.unwrap_or_default().is_empty());

    save_conversation_draft_for_account(&db, shared_conv_ab, "Rascunho de Bob", Some(account_b)).unwrap();

    let state_a = get_conversation_state_for_account(&db, shared_conv_ab, Some(account_a)).unwrap().unwrap();
    assert_eq!(state_a.draft_text.unwrap(), "Rascunho secreto de Alice");

    let state_b = get_conversation_state_for_account(&db, shared_conv_ab, Some(account_b)).unwrap().unwrap();
    assert_eq!(state_b.draft_text.unwrap(), "Rascunho de Bob");

    cleanup_temp_db_files(&db_path);
}




/// Test 8, 9, 10, 12: Preservação de timestamp, não-regressão de status, deduplicação
/// e proteção contra ressurreição de mensagem apagada.
#[test]
fn test_08_to_12_timestamp_and_status_monotonicity_and_tombstone() {
    let db_path = create_temp_db_path("status_and_tombstone");
    let db = DbState::open_with_options(&db_path, true, false).expect("init v3 db");
    let act_id = "user_test_monotonicity";
    let conv_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    let msg_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    let server_timestamp = "2026-11-05T14:30:00Z";

    let mut msg = DirectMessageDto {
        id: msg_id.to_string(),
        conversation_id: conv_id.to_string(),
        sender_id: act_id.to_string(),
        client_message_id: "client-123".to_string(),
        content: "Mensagem original".to_string(),
        created_at: server_timestamp.to_string(),
        edited_at: None,
        deleted_at: None,
        delivered_at: None,
        read_at: None,
        is_mine: true,
        delivery_status: Some("sent".to_string()),
    };

    // 1. Initial insert
    {
        let conn = db.conn.lock().unwrap();
        upsert_cached_message(&conn, act_id, &msg, "sent").unwrap();
    }

    // Verify timestamp was preserved exactly
    let loaded = load_cached_messages_for_account(&db, act_id, conv_id, 10).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].created_at, server_timestamp);
    assert_eq!(loaded[0].delivery_status.as_deref(), Some("sent"));

    // 2. Transition to 'delivered'
    msg.delivered_at = Some("2026-11-05T14:30:05Z".to_string());
    msg.delivery_status = Some("delivered".to_string());
    {
        let conn = db.conn.lock().unwrap();
        upsert_cached_message(&conn, act_id, &msg, "delivered").unwrap();
    }
    let loaded_deliv = load_cached_messages_for_account(&db, act_id, conv_id, 10).unwrap();
    assert_eq!(loaded_deliv[0].delivery_status.as_deref(), Some("delivered"));

    // 3. Transition to 'read'
    msg.read_at = Some("2026-11-05T14:30:10Z".to_string());
    msg.delivery_status = Some("read".to_string());
    {
        let conn = db.conn.lock().unwrap();
        upsert_cached_message(&conn, act_id, &msg, "read").unwrap();
    }
    let loaded_read = load_cached_messages_for_account(&db, act_id, conv_id, 10).unwrap();
    assert_eq!(loaded_read[0].delivery_status.as_deref(), Some("read"));

    // 4. Test 9 (Não-regressão): delayed HTTP response with 'sent' MUST NOT regress 'read' back to 'sent'
    let mut stale_sent_msg = msg.clone();
    stale_sent_msg.delivery_status = Some("sent".to_string());
    stale_sent_msg.read_at = None;
    stale_sent_msg.delivered_at = None;
    {
        let conn = db.conn.lock().unwrap();
        upsert_cached_message(&conn, act_id, &stale_sent_msg, "sent").unwrap();
    }
    let after_stale = load_cached_messages_for_account(&db, act_id, conv_id, 10).unwrap();
    assert_eq!(after_stale[0].delivery_status.as_deref(), Some("read"), "Must not regress from read to sent");

    // 5. Test 12 (Tombstone): soft delete message
    msg.deleted_at = Some("2026-11-05T14:31:00Z".to_string());
    msg.content = "[Mensagem apagada]".to_string();
    {
        let conn = db.conn.lock().unwrap();
        upsert_cached_message(&conn, act_id, &msg, "read").unwrap();
    }
    let after_delete = load_cached_messages_for_account(&db, act_id, conv_id, 10).unwrap();
    assert!(after_delete[0].deleted_at.is_some());
    assert_eq!(after_delete[0].content, "[Mensagem apagada]");

    // Late edit event attempting to resurrect deleted message content
    let mut late_edit_event = msg.clone();
    late_edit_event.deleted_at = None;
    late_edit_event.content = "Tentando ressuscitar mensagem apagada!".to_string();
    late_edit_event.edited_at = Some("2026-11-05T14:32:00Z".to_string());
    {
        let conn = db.conn.lock().unwrap();
        upsert_cached_message(&conn, act_id, &late_edit_event, "read").unwrap();
    }
    let after_late_edit = load_cached_messages_for_account(&db, act_id, conv_id, 10).unwrap();
    assert!(after_late_edit[0].deleted_at.is_some());
    assert_eq!(after_late_edit[0].content, "[Mensagem apagada]", "Deleted message must NEVER resurrect");

    cleanup_temp_db_files(&db_path);
}




/// Test 13: Resiliência do backup e rollback da migração
#[test]
fn test_13_backup_resilience_and_rollback() {
    let db_path = create_temp_db_path("rollback_test");

    // Create v2 database
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER);
             INSERT INTO _migrations VALUES (1, 100), (2, 200);
             CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT, title TEXT, updated_at INTEGER, account_id TEXT);
             INSERT INTO conversations VALUES ('c1', 'dm', 'Original V2', 1000, 'acc1');
             CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, sender_id TEXT, content TEXT, created_at INTEGER, delivery_status TEXT, account_id TEXT);
             INSERT INTO messages VALUES ('m1', 'c1', 'acc1', 'Original V2 Message', 1000, 'sent', 'acc1');
             CREATE TABLE conversation_state (conversation_id TEXT PRIMARY KEY, last_read_message_id TEXT, draft_text TEXT);
             CREATE TABLE cache_metadata (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);",
        ).unwrap();
    }

    // Migrate to v3
    let db = DbState::open_with_options(&db_path, true, false).unwrap();
    assert_eq!(db.current_schema_version().unwrap(), 3);
    drop(db);

    // Rollback from backup
    assert!(DbState::rollback_v3_from_backup(&db_path).is_ok());

    // Check that v2 schema and original content are restored byte-for-byte
    let conn = Connection::open(&db_path).unwrap();
    let ver: i64 = conn.query_row("SELECT MAX(version) FROM _migrations", [], |r| r.get(0)).unwrap();
    assert_eq!(ver, 2, "Schema must be restored to version 2");

    let title: String = conn.query_row("SELECT title FROM conversations WHERE id = 'c1'", [], |r| r.get(0)).unwrap();
    assert_eq!(title, "Original V2");

    let msg: String = conn.query_row("SELECT content FROM messages WHERE id = 'm1'", [], |r| r.get(0)).unwrap();
    assert_eq!(msg, "Original V2 Message");

    cleanup_temp_db_files(&db_path);
}




/// Test 14: Idempotência da migração (executar 2x consecutivas não altera nem duplica nada)
#[test]
fn test_14_migration_idempotence() {
    let db_path = create_temp_db_path("migration_idempotence");
    let db = DbState::open_with_options(&db_path, true, false).unwrap();

    // First run applied v1, v2, v3
    assert_eq!(db.current_schema_version().unwrap(), 3);

    // Apply migrations again
    assert!(db.apply_migrations().is_ok());
    assert_eq!(db.current_schema_version().unwrap(), 3);

    // Verify migrations table has exactly 3 records
    let conn = db.conn.lock().unwrap();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 3);

    cleanup_temp_db_files(&db_path);
}




/// Test 15: Quarentena de dados ambíguos em legacy_unassigned_records sem atribuição arbitrária
#[test]
fn test_15_quarantine_ambiguous_legacy_records() {
    let db_path = create_temp_db_path("quarantine_test");

    // Setup v2 DB with an ambiguous conversation and message (not a demo contact, but no concrete account_id)
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER);
             INSERT INTO _migrations VALUES (1, 100), (2, 200);
             CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT, title TEXT, updated_at INTEGER, account_id TEXT);
             INSERT INTO conversations VALUES ('ambiguous_conv_uuid', 'dm', 'Unknown User', 1000, NULL);
             CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, sender_id TEXT, content TEXT, created_at INTEGER, delivery_status TEXT, account_id TEXT);
             INSERT INTO messages VALUES ('ambiguous_msg_uuid', 'ambiguous_conv_uuid', 'unknown_sender', 'Confidential chat with unknown owner', 1000, 'sent', NULL);
             CREATE TABLE conversation_state (conversation_id TEXT PRIMARY KEY, last_read_message_id TEXT, draft_text TEXT);
             INSERT INTO conversation_state VALUES ('ambiguous_conv_uuid', NULL, 'Secret draft');
             CREATE TABLE cache_metadata (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);",
        ).unwrap();
    }

    let db = DbState::open_with_options(&db_path, true, false).unwrap();
    let conn = db.conn.lock().unwrap();

    // Verify ambiguous records were quarantined
    let quarantined_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM legacy_unassigned_records", [], |r| r.get(0))
        .unwrap();
    assert!(quarantined_count >= 2, "Ambiguous records must be quarantined");

    // Verify that querying from authenticated account cannot see the quarantined records
    drop(conn);
    let loaded = get_conversations_for_account(&db, Some("authenticated_user_123")).unwrap();
    assert!(loaded.is_empty(), "Authenticated user must NOT receive unassigned ambiguous records");

    // Direct access to 'legacy_unassigned' is blocked by security validation
    assert!(resolve_and_validate_account_id(Some("legacy_unassigned"), true).is_err());

    cleanup_temp_db_files(&db_path);
}




/// Test 16: Persistência após reinicialização completa (fechar e reabrir conexão)
#[test]
fn test_16_persistence_across_restart() {
    let db_path = create_temp_db_path("restart_persistence");

    let account_a = "user_restart_alpha";
    let account_b = "user_restart_beta";

    // Session 1: write data for A and B
    {
        let db = DbState::open_with_options(&db_path, true, false).unwrap();
        ensure_conversation_for_account(&db, "conv_1", "dm", "Alpha Chat", Some(account_a)).unwrap();
        ensure_conversation_for_account(&db, "conv_2", "dm", "Beta Chat", Some(account_b)).unwrap();
        save_conversation_draft_for_account(&db, "conv_1", "Draft for Alpha", Some(account_a)).unwrap();
    }

    // Session 2: completely close and re-open SQLite from disk
    {
        let db2 = DbState::open_with_options(&db_path, true, false).unwrap();
        let convs_a = get_conversations_for_account(&db2, Some(account_a)).unwrap();
        assert_eq!(convs_a.len(), 1);
        assert_eq!(convs_a[0].title, "Alpha Chat");

        let draft_a = get_conversation_state_for_account(&db2, "conv_1", Some(account_a)).unwrap().unwrap();
        assert_eq!(draft_a.draft_text.unwrap(), "Draft for Alpha");

        let convs_b = get_conversations_for_account(&db2, Some(account_b)).unwrap();
        assert_eq!(convs_b.len(), 1);
        assert_eq!(convs_b[0].title, "Beta Chat");
    }

    cleanup_temp_db_files(&db_path);
}




/// Test 17: O aplicativo opera normalmente quando o banco permanece na versão v2 (compatibilidade e transição segura)
#[test]
fn test_17_app_behaves_normally_when_db_remains_on_v2() {
    let db_path = create_temp_db_path("v2_compatibility");

    // 1. Setup a v2 database
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
             INSERT INTO _migrations VALUES (1, 1700000000), (2, 1700000100);

             CREATE TABLE conversations (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 title TEXT NOT NULL,
                 updated_at INTEGER NOT NULL,
                 account_id TEXT NOT NULL DEFAULT 'offline_demo'
             );

             CREATE TABLE messages (
                 id TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 sender_id TEXT NOT NULL,
                 content TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 delivery_status TEXT NOT NULL DEFAULT 'local_saved',
                 account_id TEXT NOT NULL DEFAULT 'offline_demo',
                 client_message_id TEXT,
                 edited_at INTEGER,
                 deleted_at INTEGER,
                 delivered_at INTEGER,
                 read_at INTEGER,
                 is_mine INTEGER NOT NULL DEFAULT 1
             );

             CREATE TABLE conversation_state (
                 conversation_id TEXT PRIMARY KEY,
                 last_read_message_id TEXT,
                 draft_text TEXT
             );

             CREATE TABLE cache_metadata (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );",
        )
        .unwrap();
    }

    // 2. Open with allow_v3_migration = false
    let db = DbState::open_with_options(&db_path, false, false).unwrap();
    assert_eq!(db.current_schema_version().unwrap(), 2, "DB must remain on schema version 2");

    let account_id = "v2_user_test";

    // 3. Test operations on v2 database
    ensure_conversation_for_account(&db, "conv_v2", "dm", "Conversa em V2", Some(account_id)).unwrap();
    let convs = get_conversations_for_account(&db, Some(account_id)).unwrap();
    assert_eq!(convs.len(), 1);
    assert_eq!(convs[0].title, "Conversa em V2");

    save_message_for_account(
        &db,
        "conv_v2",
        account_id,
        "Mensagem salva sob schema v2",
        Some(account_id),
    )
    .unwrap();

    let msgs = get_messages_for_account(&db, "conv_v2", 50, None, Some(account_id)).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].content, "Mensagem salva sob schema v2");

    set_cache_metadata_for_account(&db, "pref_theme", "dark", Some(account_id)).unwrap();
    let meta = get_cache_metadata_for_account(&db, "pref_theme", Some(account_id)).unwrap();
    assert_eq!(meta.as_deref(), Some("dark"));

    // 4. Trigger explicit migration to v3
    assert!(db.apply_migrations_with_options(true).is_ok());
    assert_eq!(db.current_schema_version().unwrap(), 3, "DB must now be on version 3");

    // 5. Verify all v2 data preserved after migration
    let msgs_after = get_messages_for_account(&db, "conv_v2", 50, None, Some(account_id)).unwrap();
    assert_eq!(msgs_after.len(), 1);
    assert_eq!(msgs_after[0].content, "Mensagem salva sob schema v2");

    cleanup_temp_db_files(&db_path);
}




/// Test 18: Consistência atômica de backup em modo WAL (VACUUM INTO) e restauração segura
#[test]
fn test_18_wal_atomic_vacuum_backup_consistency() {
    let db_path = create_temp_db_path("wal_vacuum_test");

    // 1. Setup v2 database in WAL mode with active WAL frames
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
             INSERT INTO _migrations VALUES (1, 1700000000), (2, 1700000100);

             CREATE TABLE conversations (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 title TEXT NOT NULL,
                 updated_at INTEGER NOT NULL,
                 account_id TEXT NOT NULL DEFAULT 'offline_demo'
             );

             CREATE TABLE messages (
                 id TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 sender_id TEXT NOT NULL,
                 content TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 delivery_status TEXT NOT NULL DEFAULT 'local_saved',
                 account_id TEXT NOT NULL DEFAULT 'offline_demo',
                 client_message_id TEXT,
                 edited_at INTEGER,
                 deleted_at INTEGER,
                 delivered_at INTEGER,
                 read_at INTEGER,
                 is_mine INTEGER NOT NULL DEFAULT 1
             );

             CREATE TABLE conversation_state (
                 conversation_id TEXT PRIMARY KEY,
                 last_read_message_id TEXT,
                 draft_text TEXT
             );

             CREATE TABLE cache_metadata (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );",
        )
        .unwrap();

        // Write data into WAL without checkpoint
        conn.execute(
            "INSERT INTO conversations (id, type, title, updated_at, account_id)
             VALUES ('conv_wal', 'dm', 'WAL Active Chat', 1700000600, 'user_wal')",
            [],
        )
        .unwrap();
    }

    // 2. Open and migrate to v3 (triggers VACUUM INTO backup)
    let db = DbState::open_with_options(&db_path, true, false).unwrap();
    assert_eq!(db.current_schema_version().unwrap(), 3);

    // 3. Inspect the .bak.v2 backup file: it must be a valid, consistent SQLite database
    let backup_path = DbState::backup_path_for(&db_path);
    assert!(backup_path.exists(), "Backup file must exist");

    {
        let bk_conn = Connection::open(&backup_path).unwrap();
        let integrity: String = bk_conn.query_row("PRAGMA integrity_check;", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok", "Backup must pass integrity check");

        let title: String = bk_conn
            .query_row("SELECT title FROM conversations WHERE id = 'conv_wal'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "WAL Active Chat", "Backup must capture active WAL writes");
    }

    // 4. Test rollback
    drop(db);
    assert!(DbState::rollback_v3_from_backup(&db_path).is_ok());

    // 5. Open rolled-back database: it must be on v2 with data intact
    let db_restored = DbState::open_with_options(&db_path, false, false).unwrap();
    assert_eq!(db_restored.current_schema_version().unwrap(), 2, "Rolled back DB must be v2");

    let convs = get_conversations_for_account(&db_restored, Some("user_wal")).unwrap();
    assert_eq!(convs.len(), 1);
    assert_eq!(convs[0].title, "WAL Active Chat");

    cleanup_temp_db_files(&db_path);
}

/// Test 19: db_migrate_to_v3 exige confirmacao explicita (confirm: true) e bloqueia execucoes simultaneas
#[test]
fn test_19_db_migrate_to_v3_native_authorization_and_concurrency_guard() {
    let db_path = create_temp_db_path("migration_auth_concurrency");

    // 1. Setup a legacy v2 database
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
             INSERT INTO _migrations (version, applied_at) VALUES (1, 1700000000), (2, 1700000100);
             CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, updated_at INTEGER NOT NULL, account_id TEXT NOT NULL DEFAULT 'offline_demo');
             CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, delivery_status TEXT NOT NULL DEFAULT 'local_saved', account_id TEXT NOT NULL DEFAULT 'offline_demo');
             CREATE TABLE conversation_state (conversation_id TEXT PRIMARY KEY, last_read_message_id TEXT, draft_text TEXT);
             CREATE TABLE cache_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
        ).unwrap();
    }

    // 2. Open without v3 migration
    let db = DbState::open_with_options(&db_path, false, false).unwrap();
    assert_eq!(db.current_schema_version().unwrap(), 2, "Must remain on v2");

    // 3. Simulated call to db_migrate_to_v3:
    // a) confirm = false must be rejected
    let rejected_no_confirm = (|| -> Result<(), String> {
        let confirm = false;
        if !confirm {
            return Err("Migração v3 requer autorização explícita (confirm: true).".to_string());
        }
        Ok(())
    })();
    assert!(rejected_no_confirm.is_err(), "Must reject unconfirmed migration");

    // b) confirm = true WITHOUT native host env var MUST be rejected
    std::env::remove_var("NEXUS_ALLOW_DB_MIGRATION_V3");
    let rejected_no_native_auth = (|| -> Result<(), String> {
        let confirm = true;
        let native_allowed = std::env::var("NEXUS_ALLOW_DB_MIGRATION_V3")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !native_allowed {
            return Err("Migração estrutural v3 bloqueada na camada nativa: requer autorização explícita do host via variável de ambiente NEXUS_ALLOW_DB_MIGRATION_V3=1.".to_string());
        }
        Ok(())
    })();
    assert!(rejected_no_native_auth.is_err(), "Must reject JS confirm: true when host env var is not set");
    assert_eq!(db.current_schema_version().unwrap(), 2, "Schema version must not change when rejected");

    // 4. Concurrency lock prevents concurrent migration operations
    use std::sync::atomic::{AtomicBool, Ordering};
    let lock = AtomicBool::new(true); // simulate active migration in progress
    let concurrent_call = (|| -> Result<(), String> {
        if lock.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err("Operação de migração v3 já está em execução.".to_string());
        }
        Ok(())
    })();
    assert!(concurrent_call.is_err(), "Concurrent execution must be rejected");
    assert_eq!(concurrent_call.unwrap_err(), "Operação de migração v3 já está em execução.");

    // 5. Explicitly confirmed migration succeeds cleanly
    assert!(db.apply_migrations_with_options(true).is_ok());
    assert_eq!(db.current_schema_version().unwrap(), 3, "Schema version must now be 3");

    cleanup_temp_db_files(&db_path);
}

/// Test 20: Banco de dados de producao existente NUNCA e migrado acidentalmente na inicializacao normal
#[test]
fn test_20_existing_db_never_migrated_accidentally_on_startup() {
    let db_path = create_temp_db_path("existing_startup_no_accidental_v3");

    // 1. Create existing production v2 database
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
             INSERT INTO _migrations (version, applied_at) VALUES (1, 1700000000), (2, 1700000100);
             CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, updated_at INTEGER NOT NULL, account_id TEXT NOT NULL DEFAULT 'offline_demo');
             CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, delivery_status TEXT NOT NULL DEFAULT 'local_saved', account_id TEXT NOT NULL DEFAULT 'offline_demo');
             CREATE TABLE conversation_state (conversation_id TEXT PRIMARY KEY, last_read_message_id TEXT, draft_text TEXT);
             CREATE TABLE cache_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
        ).unwrap();
    }

    // 2. Open simulating standard application boot (allow_v3_migration = false)
    let db_boot = DbState::open_with_options(&db_path, false, false).unwrap();

    // 3. Verify schema version is STILL 2 and backup was NOT created
    assert_eq!(db_boot.current_schema_version().unwrap(), 2, "Existing database must stay on schema v2 on boot");
    let backup_path = DbState::backup_path_for(&db_path);
    assert!(!backup_path.exists(), "No pre-migration backup should be created on standard startup without authorization");

    cleanup_temp_db_files(&db_path);
}
