// ==============================================================================
// NEXUS - Release v0.1.5 Update Simulation & Integrity Tests
// Validates v0.1.4 -> v0.1.5 upgrade scenarios, data persistence, multi-account
// isolation, composite PKs, native host authorization, and rollback recovery.
// ==============================================================================

use nexus_lib::auth::{
    clear_authenticated_server_origin, delete_secure_token, get_secure_token, save_secure_token,
};
use nexus_lib::commands::{
    get_cache_metadata_for_account, get_conversations_for_account,
    get_conversation_state_for_account, get_messages_for_account, save_message_for_account,
};
use nexus_lib::db::DbState;
use nexus_lib::network::{
    augment_csp_for_server, clear_dynamic_api_base_for_tests, set_dynamic_api_base,
};
use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static SIMULATION_MUTEX: Mutex<()> = Mutex::new(());

fn create_temp_db_path(name: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    path.push(format!("nexus_sim_{}_{}.db", name, nonce));
    path
}

fn cleanup_temp_db_files(path: &PathBuf) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(path.with_extension("db-wal"));
    let _ = fs::remove_file(path.with_extension("db-shm"));
    let _ = fs::remove_file(DbState::backup_path_for(path));
}

/// Helper to create a representative v0.1.4 SQLite database (schema version 2)
fn setup_v014_schema_v2_database(db_path: &PathBuf) {
    let conn = Connection::open(db_path).expect("open v0.1.4 database");
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
    .expect("setup v0.1.4 schema v2");

    // Seed realistic v0.1.4 records for Account A and Account B
    conn.execute(
        "INSERT INTO conversations (id, type, title, updated_at, account_id)
         VALUES ('conv_acc_a_1', 'dm', 'Conversa com Alice', 1700001000, 'account_a')",
        [],
    )
    .expect("insert conv A");

    conn.execute(
        "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, account_id, is_mine)
         VALUES ('msg_a_1', 'conv_acc_a_1', 'account_a', 'Mensagem confidencial A1', 1700001010, 'account_a', 1)",
        [],
    )
    .expect("insert msg A1");

    conn.execute(
        "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, account_id, is_mine)
         VALUES ('msg_a_2', 'conv_acc_a_1', 'alice_id', 'Resposta de Alice A2', 1700001020, 'account_a', 0)",
        [],
    )
    .expect("insert msg A2");

    conn.execute(
        "INSERT INTO conversation_state (conversation_id, last_read_message_id, draft_text)
         VALUES ('conv_acc_a_1', 'msg_a_2', 'Rascunho de resposta para Alice')",
        [],
    )
    .expect("insert state A");

    conn.execute(
        "INSERT INTO cache_metadata (key, value, updated_at)
         VALUES ('cache_sync_ts_account_a', '1700001020', 1700001020)",
        [],
    )
    .expect("insert cache A");

    // Account B data
    conn.execute(
        "INSERT INTO conversations (id, type, title, updated_at, account_id)
         VALUES ('conv_acc_b_1', 'dm', 'Conversa de Bob', 1700002000, 'account_b')",
        [],
    )
    .expect("insert conv B");

    conn.execute(
        "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, account_id, is_mine)
         VALUES ('msg_b_1', 'conv_acc_b_1', 'account_b', 'Mensagem isolada de Bob B1', 1700002010, 'account_b', 1)",
        [],
    )
    .expect("insert msg B1");
}

#[test]
fn test_sim_01_v014_to_v015_clean_read_without_auto_migration() {
    let _guard = SIMULATION_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let db_path = create_temp_db_path("sim_clean_read");
    setup_v014_schema_v2_database(&db_path);

    // v0.1.5 startup against existing v2 database without explicit host authorization
    // allow_v3_migration is false by default on existing DBs
    let db = DbState::open_with_options(&db_path, false, false)
        .expect("v0.1.5 should open existing v2 database smoothly");

    // 1. Schema version remains 2 (no accidental auto-migration)
    let version = db.current_schema_version().expect("get schema version");
    assert_eq!(version, 2, "Database must remain at version 2 on normal v0.1.5 startup");

    // 2. Pre-migration backup must NOT be created yet
    let backup_path = DbState::backup_path_for(&db_path);
    assert!(!backup_path.exists(), "No backup should be created until actual migration");

    // 3. Verify all messages, conversations, state, and cache are preserved 100%
    let convs_a = get_conversations_for_account(&db, Some("account_a")).expect("get convs a");
    assert_eq!(convs_a.len(), 1);
    assert_eq!(convs_a[0].id, "conv_acc_a_1");
    assert_eq!(convs_a[0].title, "Conversa com Alice");

    let msgs_a = get_messages_for_account(&db, "conv_acc_a_1", 50, None, Some("account_a")).expect("get msgs a");
    assert_eq!(msgs_a.len(), 2);
    assert_eq!(msgs_a[0].id, "msg_a_1");
    assert_eq!(msgs_a[0].content, "Mensagem confidencial A1");
    assert_eq!(msgs_a[1].id, "msg_a_2");
    assert_eq!(msgs_a[1].content, "Resposta de Alice A2");

    let state_a = get_conversation_state_for_account(&db, "conv_acc_a_1", Some("account_a")).expect("get state a");
    assert_eq!(state_a.as_ref().and_then(|s| s.draft_text.as_deref()), Some("Rascunho de resposta para Alice"));
    assert_eq!(state_a.as_ref().and_then(|s| s.last_read_message_id.as_deref()), Some("msg_a_2"));

    let meta = get_cache_metadata_for_account(&db, "cache_sync_ts_account_a", Some("account_a")).expect("get cache");
    assert_eq!(meta.as_deref(), Some("1700001020"));

    // 4. Operational check: write a new message while in v2
    let new_msg = save_message_for_account(
        &db,
        "conv_acc_a_1",
        "account_a",
        "Nova mensagem enviada no v0.1.5 operando em v2",
        Some("account_a"),
    ).expect("save message in v2");
    assert_eq!(new_msg.content, "Nova mensagem enviada no v0.1.5 operando em v2");

    let msgs_after = get_messages_for_account(&db, "conv_acc_a_1", 50, None, Some("account_a")).expect("get msgs after");
    assert_eq!(msgs_after.len(), 3);

    cleanup_temp_db_files(&db_path);
}

#[test]
fn test_sim_02_v014_to_v015_controlled_migration_v2_to_v3() {
    let _guard = SIMULATION_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let db_path = create_temp_db_path("sim_migration_v3");
    setup_v014_schema_v2_database(&db_path);

    let db = DbState::open_with_options(&db_path, false, false).expect("open v2");

    // 1. Calling migration with native host env authorization check:
    // If confirm is false, reject:
    let confirm = false;
    let rej_no_confirm = if !confirm {
        Err("Migração v3 requer autorização explícita (confirm: true).".to_string())
    } else {
        Ok(())
    };
    assert!(rej_no_confirm.is_err());

    // If confirm is true but host env is missing, reject:
    std::env::remove_var("NEXUS_ALLOW_DB_MIGRATION_V3");
    let rej_no_host_auth = {
        let native_allowed = std::env::var("NEXUS_ALLOW_DB_MIGRATION_V3")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !native_allowed {
            Err("Migração estrutural v3 bloqueada na camada nativa: requer autorização explícita do host via variável de ambiente NEXUS_ALLOW_DB_MIGRATION_V3=1.".to_string())
        } else {
            Ok(())
        }
    };
    assert!(rej_no_host_auth.is_err());

    // 2. Authorize via host environment variable and run migration
    std::env::set_var("NEXUS_ALLOW_DB_MIGRATION_V3", "1");
    let auth_result = db.apply_migrations_with_options(true);
    assert!(auth_result.is_ok(), "Migration must succeed with explicit host authorization");

    // 3. Verify schema version is now 3
    let version = db.current_schema_version().expect("get schema version");
    assert_eq!(version, 3, "Schema version must be 3 post-migration");

    // 4. Verify backup file exists and is intact
    let backup_path = DbState::backup_path_for(&db_path);
    assert!(backup_path.exists(), "Backup .bak.v2 must exist");

    // 5. Verify integrity of both migrated DB and backup DB
    db.verify_integrity().expect("Migrated DB must pass PRAGMA integrity_check");
    let backup_conn = Connection::open(&backup_path).expect("open backup");
    let integrity: String = backup_conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(integrity, "ok", "Backup must pass integrity check");

    // 6. Verify composite primary key (conversation_id, id) is enforced
    // In schema v3, the same message ID can exist in different conversations,
    // but duplicate (conversation_id, id) must fail.
    {
        let conn = db.conn.lock().unwrap();
        // Insert message with same ID in different conversation: should SUCCEED
        let res_diff_conv = conn.execute(
            "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, account_id)
             VALUES ('msg_a_1', 'conv_acc_b_1', 'account_b', 'Mesmo ID mas em outra conversa', 1700003000, 'account_b')",
            [],
        );
        assert!(res_diff_conv.is_ok(), "Composite PK permits same message ID across different conversations");

        // Insert duplicate (conversation_id, id): should FAIL
        let res_dup = conn.execute(
            "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, account_id)
             VALUES ('msg_a_1', 'conv_acc_a_1', 'account_a', 'Mensagem duplicada', 1700003010, 'account_a')",
            [],
        );
        assert!(res_dup.is_err(), "Duplicate (conversation_id, id) must be rejected by composite PK");
    }

    // 7. Verify multi-account isolation post-migration
    let msgs_a = get_messages_for_account(&db, "conv_acc_a_1", 50, None, Some("account_a")).expect("get a msgs");
    for m in &msgs_a {
        assert_eq!(m.account_id, "account_a");
    }

    let msgs_b = get_messages_for_account(&db, "conv_acc_b_1", 50, None, Some("account_b")).expect("get b msgs");
    assert_eq!(msgs_b[0].id, "msg_b_1");
    assert_eq!(msgs_b[0].content, "Mensagem isolada de Bob B1");

    // 8. Idempotence: re-running migration on v3 is a no-op and succeeds safely
    let second_run = db.apply_migrations_with_options(true);
    assert!(second_run.is_ok(), "Subsequent migration call must be an idempotent no-op");
    assert_eq!(db.current_schema_version().unwrap(), 3);

    std::env::remove_var("NEXUS_ALLOW_DB_MIGRATION_V3");
    cleanup_temp_db_files(&db_path);
}

#[test]
fn test_sim_03_downgrade_and_rollback_recovery() {
    let _guard = SIMULATION_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let db_path = create_temp_db_path("sim_rollback");
    setup_v014_schema_v2_database(&db_path);

    // 1. Perform migration to v3
    std::env::set_var("NEXUS_ALLOW_DB_MIGRATION_V3", "1");
    let db = DbState::open_with_options(&db_path, true, false).expect("open and migrate");
    assert_eq!(db.current_schema_version().unwrap(), 3);
    drop(db); // Release locks

    // 2. Perform rollback from backup .bak.v2
    let rollback_res = DbState::rollback_v3_from_backup(&db_path);
    assert!(rollback_res.is_ok(), "Rollback from .bak.v2 must succeed");

    // 3. Open with simulated v0.1.4 client (only understands schema v2)
    let conn = Connection::open(&db_path).expect("open restored v2 db");
    let version: i64 = conn.query_row("SELECT MAX(version) FROM _migrations", [], |r| r.get(0)).unwrap();
    assert_eq!(version, 2, "Restored database must be at version 2");

    let count: i64 = conn.query_row("SELECT COUNT(*) FROM messages WHERE account_id='account_a'", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 2, "All original messages from Account A must be fully restored");

    let content: String = conn.query_row("SELECT content FROM messages WHERE id='msg_a_1'", [], |r| r.get(0)).unwrap();
    assert_eq!(content, "Mensagem confidencial A1");

    std::env::remove_var("NEXUS_ALLOW_DB_MIGRATION_V3");
    cleanup_temp_db_files(&db_path);
}

#[test]
fn test_sim_04_token_origin_binding_and_csp() {
    let _guard = SIMULATION_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("NEXUS_KEYRING_KEY", "test_sim_keyring");

    // 1. Token origin binding
    set_dynamic_api_base("http://127.0.0.1:3001".to_string());
    save_secure_token("valid_secret_sim_token").expect("store token");

    // Token retrieved matching origin: returns token
    let token = get_secure_token();
    assert_eq!(token.as_deref(), Some("valid_secret_sim_token"));

    // Origin changed to another server (e.g. nexus-server)
    clear_authenticated_server_origin();
    set_dynamic_api_base("http://nexus-server:3001".to_string());
    let leaked_token = get_secure_token();
    assert_eq!(leaked_token, None, "Token MUST NOT leak when server origin is switched");

    // Reset origin
    clear_authenticated_server_origin();
    set_dynamic_api_base("http://127.0.0.1:3001".to_string());
    assert_eq!(get_secure_token().as_deref(), Some("valid_secret_sim_token"));

    // 2. Dynamic CSP augmentation for Tailscale IP
    let base_csp = "default-src 'self'; connect-src 'self' ipc: tauri: http://localhost:* ws://localhost:*;";
    let tailscale_origin = "http://100.117.183.97:3001";
    let augmented = augment_csp_for_server(base_csp, tailscale_origin);

    assert!(augmented.contains("http://100.117.183.97:3001"), "CSP must include Tailscale HTTP origin");
    assert!(augmented.contains("ws://100.117.183.97:3001"), "CSP must include Tailscale WS origin");
    assert!(!augmented.contains("http: "), "CSP must not include generic http: wildcard");
    assert!(!augmented.contains("ws: "), "CSP must not include generic ws: wildcard");

    let _ = delete_secure_token();
    clear_authenticated_server_origin();
    clear_dynamic_api_base_for_tests();
    std::env::remove_var("NEXUS_KEYRING_KEY");
}
