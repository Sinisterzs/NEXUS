use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DbConversation {
    pub id: String,
    #[serde(rename = "type")]
    pub conversation_type: String,
    pub title: String,
    pub updated_at: i64,
    #[serde(default = "default_account_id")]
    pub account_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DbMessage {
    pub id: String,
    pub conversation_id: String,
    pub sender_id: String,
    pub content: String,
    pub created_at: i64,
    pub delivery_status: String,
    #[serde(default)]
    pub client_message_id: Option<String>,
    #[serde(default)]
    pub edited_at: Option<i64>,
    #[serde(default)]
    pub deleted_at: Option<i64>,
    #[serde(default)]
    pub delivered_at: Option<i64>,
    #[serde(default)]
    pub read_at: Option<i64>,
    #[serde(default = "default_is_mine")]
    pub is_mine: bool,
    #[serde(default = "default_account_id")]
    pub account_id: String,
}

fn default_account_id() -> String {
    "offline_demo".to_string()
}

fn default_is_mine() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DbConversationState {
    pub conversation_id: String,
    pub last_read_message_id: Option<String>,
    pub draft_text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DbCacheMetadata {
    pub key: String,
    pub value: String,
    pub updated_at: i64,
}

pub struct DbState {
    pub conn: Mutex<Connection>,
}

impl DbState {
    pub fn init(app_handle: &tauri::AppHandle) -> Result<Self, String> {
        let app_dir: PathBuf = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app_data_dir: {}", e))?;

        if !app_dir.exists() {
            fs::create_dir_all(&app_dir)
                .map_err(|e| format!("Failed to create app data dir: {}", e))?;
        }

        let db_path = app_dir.join("nexus.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open SQLite database at {:?}: {}", db_path, e))?;

        // Enable write-ahead logging and foreign keys
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

        let db = DbState {
            conn: Mutex::new(conn),
        };

        db.apply_migrations()?;
        db.seed_if_empty()?;

        Ok(db)
    }

    fn apply_migrations(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // 1. Create migrations tracking table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS _migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );",
            [],
        )
        .map_err(|e| format!("Migration table error: {}", e))?;

        let current_version: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM _migrations",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // Migration 1: Base schema for Conversations, Messages, ConversationState, CacheMetadata
        if current_version < 1 {
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("Transaction error: {}", e))?;

            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_conversations_updated 
                ON conversations(updated_at DESC);

                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    sender_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    delivery_status TEXT NOT NULL DEFAULT 'local_saved',
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_messages_conv_created 
                ON messages(conversation_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS conversation_state (
                    conversation_id TEXT PRIMARY KEY,
                    last_read_message_id TEXT,
                    draft_text TEXT,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS cache_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );",
            )
            .map_err(|e| format!("Migration 1 schema error: {}", e))?;

            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;

            tx.execute(
                "INSERT INTO _migrations (version, applied_at) VALUES (1, ?)",
                params![now],
            )
            .map_err(|e| format!("Migration record error: {}", e))?;

            tx.commit()
                .map_err(|e| format!("Commit migration 1 error: {}", e))?;
        }

        // Migration 2: Multi-account isolation, client message UUIDs, receipts, and pending message sync
        if current_version < 2 {
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("Transaction error: {}", e))?;

            // Add columns to conversations
            let _ = tx.execute(
                "ALTER TABLE conversations ADD COLUMN account_id TEXT NOT NULL DEFAULT 'offline_demo'",
                [],
            );

            // Add columns to messages
            let _ = tx.execute(
                "ALTER TABLE messages ADD COLUMN account_id TEXT NOT NULL DEFAULT 'offline_demo'",
                [],
            );
            let _ = tx.execute("ALTER TABLE messages ADD COLUMN client_message_id TEXT", []);
            let _ = tx.execute("ALTER TABLE messages ADD COLUMN edited_at INTEGER", []);
            let _ = tx.execute("ALTER TABLE messages ADD COLUMN deleted_at INTEGER", []);
            let _ = tx.execute("ALTER TABLE messages ADD COLUMN delivered_at INTEGER", []);
            let _ = tx.execute("ALTER TABLE messages ADD COLUMN read_at INTEGER", []);
            let _ = tx.execute(
                "ALTER TABLE messages ADD COLUMN is_mine INTEGER NOT NULL DEFAULT 1",
                [],
            );

            tx.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(account_id, updated_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_messages_account_conv ON messages(account_id, conversation_id, created_at DESC);

                 CREATE TABLE IF NOT EXISTS pending_messages (
                     id TEXT PRIMARY KEY,
                     account_id TEXT NOT NULL,
                     conversation_id TEXT NOT NULL,
                     client_message_id TEXT NOT NULL,
                     content TEXT NOT NULL,
                     created_at INTEGER NOT NULL,
                     retry_count INTEGER NOT NULL DEFAULT 0,
                     status TEXT NOT NULL DEFAULT 'pending'
                 );
                 CREATE INDEX IF NOT EXISTS idx_pending_account ON pending_messages(account_id, created_at ASC);",
            )
            .map_err(|e| format!("Migration 2 index error: {}", e))?;

            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;

            tx.execute(
                "INSERT INTO _migrations (version, applied_at) VALUES (2, ?)",
                params![now],
            )
            .map_err(|e| format!("Migration 2 record error: {}", e))?;

            tx.commit()
                .map_err(|e| format!("Commit migration 2 error: {}", e))?;
        }

        Ok(())
    }

    fn seed_if_empty(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Seed transaction error: {}", e))?;

        // Seed all 7 mock friend direct messages and channel c2 idempotently
        let default_convs = [
            ("f_01", "dm", "Beatriz Lima", now),
            ("f_02", "dm", "Lucas Rocha", now - 3600),
            ("f_03", "dm", "Helena Santos", now - 7200),
            ("f_04", "dm", "Guilherme Silva", now - 86400),
            ("f_05", "dm", "Mariana Costa", now - 172800),
            ("f_06", "dm", "Thiago Mendes", now - 259200),
            ("f_07", "dm", "Camila Duarte", now - 345600),
            ("c2", "channel", "#geral", now - 1000),
        ];

        for (id, c_type, title, updated) in default_convs {
            tx.execute(
                "INSERT OR IGNORE INTO conversations (id, type, title, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, c_type, title, updated],
            )
            .map_err(|e| format!("Seed conv error: {}", e))?;
        }

        // Seed initial message history for contacts
        let initial_msgs = [
            ("m_01", "f_01", "f_01", "E aí Alex! Conseguiu testar a versão nova do NEXUS?", now - 7200),
            ("m_02", "f_01", "f_01", "Eu vi que você estava rodando no Windows 11 com Tauri 2.", now - 7140),
            ("m_03", "f_01", "usr_me", "Sim! A persistência com SQLite em Rust e tauri-plugin-store está funcionando perfeitamente.", now - 5400),
            ("m_04", "f_01", "usr_me", "Todas as mensagens agora são salvas localmente em banco de dados seguro.", now - 5340),
            ("m_05", "f_01", "f_01", "Sensacional. As conversas não somem mais ao reiniciar o aplicativo!", now - 1800),
            ("m_06", "f_01", "f_01", "Partiu fechar o lobby de CS2 hoje à noite?", now - 300),
            ("m_21", "f_02", "f_02", "Alex, você viu o novo Tailwind CSS 4 rodando com @theme?", now - 3600),
            ("m_22", "f_02", "f_02", "A performance do Tauri 2 com Vite tá impressionante. O HMR atualiza em menos de 50ms.", now - 3540),
            ("m_31", "f_03", "f_03", "Depois me manda o link das configurações de áudio!", now - 7200),
            ("m_32", "f_03", "usr_me", "Claro Helena, estão na aba Configurações > Áudio & Vídeo com sensibilidade e cancelamento de eco.", now - 7100),
            ("m_41", "f_04", "f_04", "O consumo de RAM ficou abaixo de 45MB mesmo.", now - 86400),
            ("m_42", "f_04", "usr_me", "Sim Guilherme, o backend em Rust consome só ~8MB de Private Bytes no Windows 11.", now - 86300),
            ("m_51", "f_05", "f_05", "Oi Alex! Quando puder me ajuda com o setup do build.", now - 172800),
            ("m_61", "f_06", "f_06", "Derrubei o boss em Caelid finalmente!", now - 259200),
            ("m_62", "f_06", "usr_me", "Boa Thiago! Qual build você usou? Destreza ou Sangramento?", now - 259100),
            ("m_71", "f_07", "f_07", "E aí! Testou os atalhos de navegação?", now - 345600),
            ("cm_01", "c2", "f_02", "As migrações SQLite foram aplicadas com sucesso no NEXUS.", now - 1000),
        ];

        for (m_id, conv_id, sender, content, ts) in initial_msgs {
            tx.execute(
                "INSERT OR IGNORE INTO messages (id, conversation_id, sender_id, content, created_at, delivery_status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![m_id, conv_id, sender, content, ts, "local_saved"],
            )
            .map_err(|e| format!("Seed msg error: {}", e))?;
        }

        // Cache metadata initial record
        tx.execute(
            "INSERT OR IGNORE INTO cache_metadata (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params!["schema_version", "1.0", now],
        )
        .map_err(|e| format!("Seed metadata error: {}", e))?;

        tx.commit()
            .map_err(|e| format!("Commit seed error: {}", e))?;

        Ok(())
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Failed to open in-memory SQLite: {}", e))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("Failed to set pragmas: {}", e))?;

        let db = DbState {
            conn: Mutex::new(conn),
        };
        db.apply_migrations()?;
        db.seed_if_empty()?;
        Ok(db)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migrations_and_seeding() {
        let db = DbState::new_in_memory().expect("Should initialize in-memory DB");
        let conn = db.conn.lock().unwrap();

        // Verify migrations table
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 2, "Migration version 2 should be recorded");

        // Verify seeded conversations
        let conv_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))
            .unwrap();
        assert!(conv_count >= 3, "At least 3 seeded conversations expected");

        // Verify seeded messages
        let msg_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert!(msg_count >= 3, "At least 3 seeded messages expected");

        // Verify cache metadata
        let schema_ver: String = conn
            .query_row(
                "SELECT value FROM cache_metadata WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(schema_ver, "1.0");
    }

    #[test]
    fn test_migration_idempotence() {
        let db = DbState::new_in_memory().expect("Should initialize in-memory DB");
        // Run migrations again
        assert!(db.apply_migrations().is_ok());

        let conn = db.conn.lock().unwrap();
        let migration_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            migration_rows, 2,
            "Migration should record 2 versions without duplicates"
        );
    }

    #[test]
    fn test_pagination_and_ordering() {
        let db = DbState::new_in_memory().expect("Should initialize in-memory DB");
        let conn = db.conn.lock().unwrap();

        let conv_id = "test_pagination_conv";
        conn.execute(
            "INSERT INTO conversations (id, type, title, updated_at) VALUES (?1, 'dm', 'Test Pagination', 1000)",
            params![conv_id],
        ).unwrap();

        // Insert 30 messages with incrementing timestamps
        for i in 1..=30 {
            conn.execute(
                "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, delivery_status)
                 VALUES (?1, ?2, 'usr_me', ?3, ?4, 'local_saved')",
                params![
                    format!("msg_{:03}", i),
                    conv_id,
                    format!("Message number {}", i),
                    1000 + i
                ],
            ).unwrap();
        }

        // Query newest 10 messages (descending timestamp)
        let mut stmt = conn
            .prepare(
                "SELECT id, created_at FROM messages WHERE conversation_id = ?1 ORDER BY created_at DESC LIMIT 10",
            )
            .unwrap();
        let page1: Vec<(String, i64)> = stmt
            .query_map(params![conv_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(page1.len(), 10);
        assert_eq!(page1[0].0, "msg_030");
        assert_eq!(page1[9].0, "msg_021");

        // Next page: 10 messages before msg_021's created_at (1021)
        let oldest_ts = page1[9].1;
        let mut stmt2 = conn
            .prepare(
                "SELECT id, created_at FROM messages WHERE conversation_id = ?1 AND created_at < ?2 ORDER BY created_at DESC LIMIT 10",
            )
            .unwrap();
        let page2: Vec<(String, i64)> = stmt2
            .query_map(params![conv_id, oldest_ts], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(page2.len(), 10);
        assert_eq!(page2[0].0, "msg_020");
        assert_eq!(page2[9].0, "msg_011");
    }

    #[test]
    fn test_draft_and_read_state() {
        let db = DbState::new_in_memory().expect("Should initialize in-memory DB");
        let conn = db.conn.lock().unwrap();

        let conv_id = "test_draft_conv";
        conn.execute(
            "INSERT INTO conversations (id, type, title, updated_at) VALUES (?1, 'dm', 'Test Draft', 2000)",
            params![conv_id],
        ).unwrap();

        // Save draft
        conn.execute(
            "INSERT INTO conversation_state (conversation_id, draft_text) VALUES (?1, ?2)
             ON CONFLICT(conversation_id) DO UPDATE SET draft_text = ?2",
            params![conv_id, "Escrevendo um rascunho importante..."],
        )
        .unwrap();

        let draft: String = conn
            .query_row(
                "SELECT draft_text FROM conversation_state WHERE conversation_id = ?1",
                params![conv_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(draft, "Escrevendo um rascunho importante...");

        // Update read marker
        conn.execute(
            "INSERT INTO conversation_state (conversation_id, last_read_message_id) VALUES (?1, ?2)
             ON CONFLICT(conversation_id) DO UPDATE SET last_read_message_id = ?2",
            params![conv_id, "msg_099"],
        )
        .unwrap();

        let (read_id, draft_after): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT last_read_message_id, draft_text FROM conversation_state WHERE conversation_id = ?1",
                params![conv_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(read_id, Some("msg_099".to_string()));
        assert_eq!(
            draft_after,
            Some("Escrevendo um rascunho importante...".to_string())
        );
    }
}
