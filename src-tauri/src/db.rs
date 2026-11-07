use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
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
    pub edited_at: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub delivered_at: Option<String>,
    #[serde(default)]
    pub read_at: Option<String>,
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
    #[serde(default = "default_account_id")]
    pub account_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DbCacheMetadata {
    pub key: String,
    pub value: String,
    pub updated_at: i64,
    #[serde(default = "default_global_account")]
    pub account_id: String,
}

fn default_global_account() -> String {
    "global".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LegacyUnassignedRecord {
    pub record_type: String,
    pub record_id: String,
    pub original_account_id: Option<String>,
    pub payload_json: String,
    pub reason: String,
    pub quarantined_at: i64,
}

pub const KNOWN_DEMO_CONVERSATION_IDS: &[&str] =
    &["f_01", "f_02", "f_03", "f_04", "f_05", "f_06", "f_07", "c2"];

pub const KNOWN_DEMO_MESSAGE_IDS: &[&str] = &[
    "m_01", "m_02", "m_03", "m_04", "m_05", "m_06", "m_21", "m_22", "m_31", "m_32", "m_41",
    "m_42", "m_51", "m_61", "m_62", "m_71", "cm_01",
];

pub fn is_known_demo_conv_id(id: &str) -> bool {
    KNOWN_DEMO_CONVERSATION_IDS.contains(&id)
}

pub fn is_known_demo_msg_id(id: &str) -> bool {
    KNOWN_DEMO_MESSAGE_IDS.contains(&id)
}

pub fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Converts Unix epoch seconds to RFC3339 / ISO-8601 UTC string (`YYYY-MM-DDTHH:MM:SSZ`).
pub fn epoch_secs_to_iso8601(secs: i64) -> String {
    let s = secs.max(0);
    let days = s.div_euclid(86_400);
    let rem = s.rem_euclid(86_400);
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;

    // Howard Hinnant's civil_from_days algorithm
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, m, d, hour, minute, second
    )
}

/// Parses an ISO-8601 / RFC3339 timestamp string (or integer string) into Unix epoch seconds.
pub fn parse_iso8601_to_epoch_secs(input: &str) -> Option<i64> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(raw_int) = trimmed.parse::<i64>() {
        // Handle milliseconds if > 1e11
        return Some(if raw_int > 100_000_000_000 {
            raw_int / 1000
        } else {
            raw_int
        });
    }
    if trimmed.len() < 19 {
        return None;
    }
    let year: i64 = trimmed.get(0..4)?.parse().ok()?;
    let month: i64 = trimmed.get(5..7)?.parse().ok()?;
    let day: i64 = trimmed.get(8..10)?.parse().ok()?;
    let hour: i64 = trimmed.get(11..13)?.parse().ok()?;
    let minute: i64 = trimmed.get(14..16)?.parse().ok()?;
    let second: i64 = trimmed.get(17..19)?.parse().ok()?;

    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=60).contains(&second)
    {
        return None;
    }

    // Howard Hinnant's days_from_civil algorithm
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = month as u64;
    let d = day as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe as i64 - 719_468;

    let mut total_secs = days * 86_400 + hour * 3600 + minute * 60 + second;

    // Parse optional timezone offset (+HH:MM or -HH:MM at end)
    let rest = &trimmed[19..];
    if let Some(pos) = rest.rfind(['+', '-']) {
        let tz_part = &rest[pos..];
        if tz_part.len() >= 6 {
            let sign = if tz_part.starts_with('+') { -1i64 } else { 1i64 };
            let tz_h: i64 = tz_part.get(1..3).and_then(|s| s.parse().ok()).unwrap_or(0);
            let tz_m: i64 = tz_part.get(4..6).and_then(|s| s.parse().ok()).unwrap_or(0);
            total_secs += sign * (tz_h * 3600 + tz_m * 60);
        }
    }

    Some(total_secs)
}

/// Helper to read a column that may have been stored as TEXT or INTEGER in SQLite.
pub fn get_optional_text_or_int(row: &rusqlite::Row<'_>, idx: usize) -> Option<String> {
    if let Ok(Some(s)) = row.get::<_, Option<String>>(idx) {
        let t = s.trim();
        if !t.is_empty() {
            // If it looks like a raw epoch integer, convert to ISO-8601
            if let Ok(epoch) = t.parse::<i64>() {
                if epoch > 1_000_000_000 && epoch < 10_000_000_000 {
                    return Some(epoch_secs_to_iso8601(epoch));
                }
            }
            return Some(s);
        }
    }
    if let Ok(Some(n)) = row.get::<_, Option<i64>>(idx) {
        if n > 0 {
            return Some(epoch_secs_to_iso8601(n));
        }
    }
    None
}

pub struct DbState {
    pub conn: Mutex<Connection>,
    pub db_path: Option<PathBuf>,
}

impl DbState {
    pub fn init(app_handle: &tauri::AppHandle) -> Result<Self, String> {
        let app_dir: PathBuf = if let Ok(custom) = std::env::var("NEXUS_APP_DATA_DIR") {
            let p = PathBuf::from(custom.trim());
            if !p.as_os_str().is_empty() {
                p
            } else {
                app_handle
                    .path()
                    .app_data_dir()
                    .map_err(|e| format!("Failed to get app_data_dir: {}", e))?
            }
        } else {
            app_handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to get app_data_dir: {}", e))?
        };

        if !app_dir.exists() {
            fs::create_dir_all(&app_dir)
                .map_err(|e| format!("Failed to create app data dir: {}", e))?;
        }

        let db_path = app_dir.join("nexus.db");
        let is_new_db_file = !db_path.exists();

        // Check if explicit authorization to migrate an existing production DB to v3 is set.
        // Brand-new database files initialize directly to v3; existing production v2 databases
        // require explicit authorization (`NEXUS_ALLOW_DB_MIGRATION_V3=1`) before structural migration.
        let allow_v3_on_existing = std::env::var("NEXUS_ALLOW_DB_MIGRATION_V3")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        // Production never seeds mock data into nexus.db
        Self::open_with_options(
            &db_path,
            is_new_db_file || allow_v3_on_existing,
            false,
        )
    }

    /// Opens an isolated SQLite database file with explicit migration and demo-seeding controls.
    pub fn open_with_options(
        db_path: &Path,
        allow_v3_migration: bool,
        seed_demo: bool,
    ) -> Result<Self, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open SQLite database at {:?}: {}", db_path, e))?;

        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

        let db = DbState {
            conn: Mutex::new(conn),
            db_path: Some(db_path.to_path_buf()),
        };

        db.apply_migrations_with_options(allow_v3_migration)?;
        if seed_demo {
            db.seed_if_empty()?;
        }

        Ok(db)
    }

    /// Runs `PRAGMA integrity_check` and returns `Ok(())` if result is `"ok"`.
    pub fn verify_integrity(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::verify_conn_integrity(&conn)
    }

    fn verify_conn_integrity(conn: &Connection) -> Result<(), String> {
        let res: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| format!("PRAGMA integrity_check failed: {}", e))?;
        if res.eq_ignore_ascii_case("ok") {
            Ok(())
        } else {
            Err(format!("SQLite integrity check failed: {}", res))
        }
    }

    pub fn current_schema_version(&self) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::query_schema_version(&conn)
    }

    pub(crate) fn query_schema_version(conn: &Connection) -> Result<i64, String> {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_migrations'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if exists == 0 {
            return Ok(0);
        }
        Ok(conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM _migrations",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0))
    }

    /// Restores the database file from its `.bak.v2` pre-migration backup.
    pub fn rollback_v3_from_backup(db_path: &Path) -> Result<(), String> {
        let backup_path = Self::backup_path_for(db_path);
        if !backup_path.exists() {
            return Err(format!(
                "Backup file {:?} does not exist for rollback",
                backup_path
            ));
        }
        // Remove exact WAL/SHM sidecars if present before restoring backup
        let mut wal_os = db_path.as_os_str().to_os_string();
        wal_os.push("-wal");
        let wal_path = PathBuf::from(wal_os);

        let mut shm_os = db_path.as_os_str().to_os_string();
        shm_os.push("-shm");
        let shm_path = PathBuf::from(shm_os);

        let _ = fs::remove_file(&wal_path);
        let _ = fs::remove_file(&shm_path);

        fs::copy(&backup_path, db_path)
            .map_err(|e| format!("Failed to restore backup {:?} -> {:?}: {}", backup_path, db_path, e))?;
        Ok(())
    }

    pub fn backup_path_for(db_path: &Path) -> PathBuf {
        let mut os = db_path.as_os_str().to_os_string();
        os.push(".bak.v2");
        PathBuf::from(os)
    }

    pub fn apply_migrations(&self) -> Result<(), String> {
        self.apply_migrations_with_options(true)
    }

    pub fn apply_migrations_with_options(&self, allow_v3_migration: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // Pre-migration integrity verification
        Self::verify_conn_integrity(&conn)?;

        // 1. Create migrations tracking table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS _migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );",
            [],
        )
        .map_err(|e| format!("Migration table error: {}", e))?;

        let current_version = Self::query_schema_version(&conn)?;

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

            let now = now_epoch_secs();
            tx.execute(
                "INSERT INTO _migrations (version, applied_at) VALUES (1, ?)",
                params![now],
            )
            .map_err(|e| format!("Migration record error: {}", e))?;

            tx.commit()
                .map_err(|e| format!("Commit migration 1 error: {}", e))?;
        }

        // Migration 2: Multi-account columns, client message UUIDs, receipts, and pending message sync
        if current_version < 2 {
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("Transaction error: {}", e))?;

            let _ = tx.execute(
                "ALTER TABLE conversations ADD COLUMN account_id TEXT NOT NULL DEFAULT 'offline_demo'",
                [],
            );

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

            let now = now_epoch_secs();
            tx.execute(
                "INSERT INTO _migrations (version, applied_at) VALUES (2, ?)",
                params![now],
            )
            .map_err(|e| format!("Migration 2 record error: {}", e))?;

            tx.commit()
                .map_err(|e| format!("Commit migration 2 error: {}", e))?;
        }

        // Migration 3: Composite Primary Keys `(account_id, id)`, `conversation_state` account isolation,
        // `cache_metadata` account isolation, ISO-8601 timestamp preservation, and non-destructive
        // quarantine of ambiguous legacy records (`legacy_unassigned_records`).
        let version_after_v2 = Self::query_schema_version(&conn)?;
        if version_after_v2 < 3 && allow_v3_migration {
            // If migrating an existing file-backed v1/v2 database, create a WAL-consistent `.bak.v2` backup
            if current_version >= 1 {
                if let Some(ref path) = self.db_path {
                    let backup_path = Self::backup_path_for(path);
                    if path.exists() && !backup_path.exists() {
                        let backup_path_str = backup_path.to_string_lossy().to_string();
                        // 1. First attempt atomic VACUUM INTO which guarantees full WAL integration
                        let vacuum_res = conn.execute("VACUUM INTO ?1", params![backup_path_str]);
                        if vacuum_res.is_err() {
                            // 2. Fallback: WAL checkpoint truncate + file copy
                            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
                            fs::copy(path, &backup_path).map_err(|e| {
                                format!(
                                    "Failed to create pre-migration v2 backup at {:?}: {}",
                                    backup_path, e
                                )
                            })?;
                        }
                        // 3. Immediately verify the cold backup's integrity
                        if let Ok(bk_conn) = Connection::open(&backup_path) {
                            Self::verify_conn_integrity(&bk_conn).map_err(|e| {
                                let _ = fs::remove_file(&backup_path);
                                format!("Pre-migration backup integrity verification failed: {}", e)
                            })?;
                        }
                    }
                }
            }

            Self::execute_migration_v3(&conn)?;
            Self::verify_conn_integrity(&conn)?;
        }

        Ok(())
    }

    fn execute_migration_v3(conn: &Connection) -> Result<(), String> {
        let now = now_epoch_secs();

        // SQLite requires foreign_keys = OFF outside the transaction when rebuilding referenced tables
        conn.execute_batch("PRAGMA foreign_keys = OFF;")
            .map_err(|e| format!("Failed to disable foreign_keys for v3 migration: {}", e))?;

        let migration_res = (|| -> Result<(), String> {
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("Migration 3 transaction start error: {}", e))?;

            // Clean up any leftover staging tables from a previously interrupted migration attempt
            tx.execute_batch(
                "DROP TABLE IF EXISTS _v3_conversations;
                 DROP TABLE IF EXISTS _v3_messages;
                 DROP TABLE IF EXISTS _v3_conversation_state;
                 DROP TABLE IF EXISTS _v3_cache_metadata;

                 CREATE TABLE IF NOT EXISTS legacy_unassigned_records (
                     record_type TEXT NOT NULL,
                     record_id TEXT NOT NULL,
                     original_account_id TEXT,
                     payload_json TEXT NOT NULL,
                     reason TEXT NOT NULL,
                     quarantined_at INTEGER NOT NULL,
                     PRIMARY KEY (record_type, record_id)
                 );

                 CREATE TABLE _v3_conversations (
                     account_id TEXT NOT NULL DEFAULT 'offline_demo',
                     id TEXT NOT NULL,
                     type TEXT NOT NULL,
                     title TEXT NOT NULL,
                     updated_at INTEGER NOT NULL,
                     created_at_iso TEXT,
                     updated_at_iso TEXT,
                     other_user_json TEXT,
                     unread_count INTEGER NOT NULL DEFAULT 0,
                     PRIMARY KEY (account_id, id)
                 );

                 CREATE TABLE _v3_messages (
                     account_id TEXT NOT NULL DEFAULT 'offline_demo',
                     id TEXT NOT NULL,
                     conversation_id TEXT NOT NULL,
                     sender_id TEXT NOT NULL,
                     content TEXT NOT NULL,
                     created_at INTEGER NOT NULL,
                     created_at_iso TEXT,
                     delivery_status TEXT NOT NULL DEFAULT 'local_saved',
                     client_message_id TEXT,
                     edited_at TEXT,
                     deleted_at TEXT,
                     delivered_at TEXT,
                     read_at TEXT,
                     is_mine INTEGER NOT NULL DEFAULT 1,
                     PRIMARY KEY (account_id, id),
                     FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE
                 );

                 CREATE TABLE _v3_conversation_state (
                     account_id TEXT NOT NULL DEFAULT 'offline_demo',
                     conversation_id TEXT NOT NULL,
                     last_read_message_id TEXT,
                     draft_text TEXT,
                     updated_at INTEGER NOT NULL DEFAULT 0,
                     PRIMARY KEY (account_id, conversation_id),
                     FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE
                 );

                 CREATE TABLE _v3_cache_metadata (
                     account_id TEXT NOT NULL DEFAULT 'global',
                     key TEXT NOT NULL,
                     value TEXT NOT NULL,
                     updated_at INTEGER NOT NULL,
                     PRIMARY KEY (account_id, key)
                 );",
            )
            .map_err(|e| format!("Migration 3 staging tables creation error: {}", e))?;

            // 1. Inspect existing messages first so we know which concrete accounts participate in each conversation
            struct LegacyMsgRow {
                id: String,
                conversation_id: String,
                sender_id: String,
                content: String,
                created_at: i64,
                delivery_status: String,
                client_message_id: Option<String>,
                edited_at: Option<String>,
                deleted_at: Option<String>,
                delivered_at: Option<String>,
                read_at: Option<String>,
                is_mine: i64,
                account_id: Option<String>,
            }

            let mut msg_rows = Vec::new();
            {
                let msg_cols: HashSet<String> = {
                    let mut stmt = tx.prepare("PRAGMA table_info(messages)").map_err(|e| e.to_string())?;
                    let cols = stmt
                        .query_map([], |r| r.get::<_, String>(1))
                        .map_err(|e| e.to_string())?
                        .filter_map(|r| r.ok())
                        .collect();
                    cols
                };

                let client_col = if msg_cols.contains("client_message_id") { "client_message_id" } else { "NULL" };
                let edited_col = if msg_cols.contains("edited_at") { "edited_at" } else { "NULL" };
                let deleted_col = if msg_cols.contains("deleted_at") { "deleted_at" } else { "NULL" };
                let delivered_col = if msg_cols.contains("delivered_at") { "delivered_at" } else { "NULL" };
                let read_col = if msg_cols.contains("read_at") { "read_at" } else { "NULL" };
                let is_mine_col = if msg_cols.contains("is_mine") { "is_mine" } else { "1" };
                let account_col = if msg_cols.contains("account_id") { "account_id" } else { "NULL" };

                let msg_query = format!(
                    "SELECT id, conversation_id, sender_id, content, created_at, delivery_status,
                            {}, {}, {}, {}, {}, {}, {}
                     FROM messages",
                    client_col, edited_col, deleted_col, delivered_col, read_col, is_mine_col, account_col
                );

                let mut stmt = tx
                    .prepare(&msg_query)
                    .map_err(|e| format!("Migration 3 read messages error: {}", e))?;
                let iter = stmt
                    .query_map([], |r| {
                        Ok(LegacyMsgRow {
                            id: r.get(0)?,
                            conversation_id: r.get(1)?,
                            sender_id: r.get(2)?,
                            content: r.get(3)?,
                            created_at: r.get(4)?,
                            delivery_status: r.get(5)?,
                            client_message_id: r.get(6).ok().flatten(),
                            edited_at: get_optional_text_or_int(r, 7),
                            deleted_at: get_optional_text_or_int(r, 8),
                            delivered_at: get_optional_text_or_int(r, 9),
                            read_at: get_optional_text_or_int(r, 10),
                            is_mine: r.get::<_, i64>(11).unwrap_or(1),
                            account_id: r.get::<_, Option<String>>(12).ok().flatten(),
                        })
                    })
                    .map_err(|e| format!("Migration 3 query messages error: {}", e))?;
                for item in iter {
                    msg_rows.push(item.map_err(|e| e.to_string())?);
                }
            }

            // Track concrete accounts per conversation_id
            let mut conv_accounts: HashMap<String, HashSet<String>> = HashMap::new();
            for m in &msg_rows {
                let raw_acc = m.account_id.as_deref().unwrap_or("").trim();
                if !raw_acc.is_empty()
                    && raw_acc != "offline_demo"
                    && raw_acc != "legacy_unassigned"
                {
                    conv_accounts
                        .entry(m.conversation_id.clone())
                        .or_default()
                        .insert(raw_acc.to_string());
                }
            }

            // 2. Read existing conversations
            struct LegacyConvRow {
                id: String,
                c_type: String,
                title: String,
                updated_at: i64,
                account_id: Option<String>,
            }
            let mut conv_rows = Vec::new();
            let mut conv_meta_by_id: HashMap<String, (String, String, i64)> = HashMap::new();
            {
                let conv_cols: HashSet<String> = {
                    let mut stmt = tx.prepare("PRAGMA table_info(conversations)").map_err(|e| e.to_string())?;
                    let cols = stmt
                        .query_map([], |r| r.get::<_, String>(1))
                        .map_err(|e| e.to_string())?
                        .filter_map(|r| r.ok())
                        .collect();
                    cols
                };
                let conv_account_col = if conv_cols.contains("account_id") { "account_id" } else { "NULL" };
                let conv_query = format!(
                    "SELECT id, type, title, updated_at, {} FROM conversations",
                    conv_account_col
                );

                let mut stmt = tx
                    .prepare(&conv_query)
                    .map_err(|e| format!("Migration 3 read conversations error: {}", e))?;
                let iter = stmt
                    .query_map([], |r| {
                        Ok(LegacyConvRow {
                            id: r.get(0)?,
                            c_type: r.get(1)?,
                            title: r.get(2)?,
                            updated_at: r.get(3)?,
                            account_id: r.get::<_, Option<String>>(4).ok().flatten(),
                        })
                    })
                    .map_err(|e| format!("Migration 3 query conversations error: {}", e))?;
                for item in iter {
                    let row = item.map_err(|e| e.to_string())?;
                    conv_meta_by_id.insert(
                        row.id.clone(),
                        (row.c_type.clone(), row.title.clone(), row.updated_at),
                    );
                    let raw_acc = row.account_id.as_deref().unwrap_or("").trim();
                    if !raw_acc.is_empty()
                        && raw_acc != "offline_demo"
                        && raw_acc != "legacy_unassigned"
                    {
                        conv_accounts
                            .entry(row.id.clone())
                            .or_default()
                            .insert(raw_acc.to_string());
                    }
                    conv_rows.push(row);
                }
            }

            // 3. Migrate conversations with strict ambiguity detection
            let mut inserted_convs: HashSet<(String, String)> = HashSet::new();
            for c in &conv_rows {
                let raw_acc = c.account_id.as_deref().unwrap_or("").trim();
                let target_acc = if !raw_acc.is_empty()
                    && raw_acc != "offline_demo"
                    && raw_acc != "legacy_unassigned"
                {
                    raw_acc.to_string()
                } else if raw_acc == "offline_demo" && is_known_demo_conv_id(&c.id) {
                    "offline_demo".to_string()
                } else {
                    // Ambiguous legacy conversation (not a known demo ID, yet has no concrete account_id)
                    let payload = serde_json::json!({
                        "id": c.id,
                        "type": c.c_type,
                        "title": c.title,
                        "updated_at": c.updated_at,
                        "account_id": c.account_id,
                    })
                    .to_string();
                    tx.execute(
                        "INSERT OR REPLACE INTO legacy_unassigned_records
                         (record_type, record_id, original_account_id, payload_json, reason, quarantined_at)
                         VALUES ('conversation', ?1, ?2, ?3, ?4, ?5)",
                        params![
                            c.id,
                            c.account_id,
                            payload,
                            "Conversa legada sem account_id autenticado determinístico",
                            now
                        ],
                    )
                    .map_err(|e| format!("Quarantine conv error: {}", e))?;
                    "legacy_unassigned".to_string()
                };

                let iso = epoch_secs_to_iso8601(c.updated_at);
                tx.execute(
                    "INSERT OR REPLACE INTO _v3_conversations
                     (account_id, id, type, title, updated_at, created_at_iso, updated_at_iso, unread_count)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0)",
                    params![target_acc, c.id, c.c_type, c.title, c.updated_at, iso],
                )
                .map_err(|e| format!("Insert _v3_conversations error: {}", e))?;
                inserted_convs.insert((target_acc, c.id.clone()));
            }

            // 4. Migrate messages and reconstruct any missing parent (account_id, conversation_id) rows
            for m in &msg_rows {
                let raw_acc = m.account_id.as_deref().unwrap_or("").trim();
                let target_acc = if !raw_acc.is_empty()
                    && raw_acc != "offline_demo"
                    && raw_acc != "legacy_unassigned"
                {
                    raw_acc.to_string()
                } else if raw_acc == "offline_demo"
                    && (is_known_demo_msg_id(&m.id)
                        || is_known_demo_conv_id(&m.conversation_id))
                {
                    "offline_demo".to_string()
                } else {
                    // Ambiguous legacy message -> record in quarantine and preserve under 'legacy_unassigned'
                    let payload = serde_json::json!({
                        "id": m.id,
                        "conversation_id": m.conversation_id,
                        "sender_id": m.sender_id,
                        "content": m.content,
                        "created_at": m.created_at,
                        "delivery_status": m.delivery_status,
                        "account_id": m.account_id,
                    })
                    .to_string();
                    tx.execute(
                        "INSERT OR REPLACE INTO legacy_unassigned_records
                         (record_type, record_id, original_account_id, payload_json, reason, quarantined_at)
                         VALUES ('message', ?1, ?2, ?3, ?4, ?5)",
                        params![
                            m.id,
                            m.account_id,
                            payload,
                            "Mensagem legada sem account_id autenticado determinístico",
                            now
                        ],
                    )
                    .map_err(|e| format!("Quarantine msg error: {}", e))?;
                    "legacy_unassigned".to_string()
                };

                // Ensure parent conversation exists for (target_acc, m.conversation_id)
                if !inserted_convs.contains(&(target_acc.clone(), m.conversation_id.clone())) {
                    let (c_type, c_title, c_updated) = conv_meta_by_id
                        .get(&m.conversation_id)
                        .cloned()
                        .unwrap_or_else(|| {
                            ("dm".to_string(), m.conversation_id.clone(), m.created_at)
                        });
                    let iso = epoch_secs_to_iso8601(c_updated);
                    tx.execute(
                        "INSERT OR IGNORE INTO _v3_conversations
                         (account_id, id, type, title, updated_at, created_at_iso, updated_at_iso, unread_count)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0)",
                        params![
                            target_acc,
                            m.conversation_id,
                            c_type,
                            c_title,
                            c_updated,
                            iso
                        ],
                    )
                    .map_err(|e| format!("Reconstruct parent conv error: {}", e))?;
                    inserted_convs.insert((target_acc.clone(), m.conversation_id.clone()));
                }

                let created_iso = epoch_secs_to_iso8601(m.created_at);
                tx.execute(
                    "INSERT OR REPLACE INTO _v3_messages
                     (account_id, id, conversation_id, sender_id, content, created_at, created_at_iso,
                      delivery_status, client_message_id, edited_at, deleted_at, delivered_at, read_at, is_mine)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    params![
                        target_acc,
                        m.id,
                        m.conversation_id,
                        m.sender_id,
                        m.content,
                        m.created_at,
                        created_iso,
                        m.delivery_status,
                        m.client_message_id,
                        m.edited_at,
                        m.deleted_at,
                        m.delivered_at,
                        m.read_at,
                        m.is_mine,
                    ],
                )
                .map_err(|e| format!("Insert _v3_messages error: {}", e))?;
            }

            // 5. Migrate conversation_state (which had NO account_id in v1/v2!)
            struct LegacyStateRow {
                conversation_id: String,
                last_read_message_id: Option<String>,
                draft_text: Option<String>,
            }
            let mut state_rows = Vec::new();
            {
                let mut stmt = tx
                    .prepare(
                        "SELECT conversation_id, last_read_message_id, draft_text FROM conversation_state",
                    )
                    .map_err(|e| format!("Migration 3 read conversation_state error: {}", e))?;
                let iter = stmt
                    .query_map([], |r| {
                        Ok(LegacyStateRow {
                            conversation_id: r.get(0)?,
                            last_read_message_id: r.get(1).ok().flatten(),
                            draft_text: r.get(2).ok().flatten(),
                        })
                    })
                    .map_err(|e| format!("Migration 3 query conversation_state error: {}", e))?;
                for item in iter {
                    state_rows.push(item.map_err(|e| e.to_string())?);
                }
            }

            for st in &state_rows {
                let owners = conv_accounts.get(&st.conversation_id);
                let target_acc = match owners.map(|s| s.len()).unwrap_or(0) {
                    1 => owners.unwrap().iter().next().unwrap().clone(),
                    0 if is_known_demo_conv_id(&st.conversation_id) => "offline_demo".to_string(),
                    _ => {
                        // Either 0 concrete owners on a non-demo conversation, or >=2 accounts shared this conversation_id in v2!
                        // Do NOT guess which account owns the draft/read state -> quarantine and preserve under 'legacy_unassigned'.
                        let payload = serde_json::json!({
                            "conversation_id": st.conversation_id,
                            "last_read_message_id": st.last_read_message_id,
                            "draft_text": st.draft_text,
                        })
                        .to_string();
                        tx.execute(
                            "INSERT OR REPLACE INTO legacy_unassigned_records
                             (record_type, record_id, original_account_id, payload_json, reason, quarantined_at)
                             VALUES ('conversation_state', ?1, NULL, ?2, ?3, ?4)",
                            params![
                                st.conversation_id,
                                payload,
                                "Estado de conversa/rascunho legado com propriedade ambígua entre contas",
                                now
                            ],
                        )
                        .map_err(|e| format!("Quarantine conversation_state error: {}", e))?;
                        "legacy_unassigned".to_string()
                    }
                };

                if !inserted_convs.contains(&(target_acc.clone(), st.conversation_id.clone())) {
                    let (c_type, c_title, c_updated) = conv_meta_by_id
                        .get(&st.conversation_id)
                        .cloned()
                        .unwrap_or_else(|| ("dm".to_string(), st.conversation_id.clone(), now));
                    let iso = epoch_secs_to_iso8601(c_updated);
                    tx.execute(
                        "INSERT OR IGNORE INTO _v3_conversations
                         (account_id, id, type, title, updated_at, created_at_iso, updated_at_iso, unread_count)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0)",
                        params![
                            target_acc,
                            st.conversation_id,
                            c_type,
                            c_title,
                            c_updated,
                            iso
                        ],
                    )
                    .map_err(|e| format!("Ensure parent conv for state error: {}", e))?;
                    inserted_convs.insert((target_acc.clone(), st.conversation_id.clone()));
                }

                tx.execute(
                    "INSERT OR REPLACE INTO _v3_conversation_state
                     (account_id, conversation_id, last_read_message_id, draft_text, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        target_acc,
                        st.conversation_id,
                        st.last_read_message_id,
                        st.draft_text,
                        now
                    ],
                )
                .map_err(|e| format!("Insert _v3_conversation_state error: {}", e))?;
            }

            // 6. Migrate cache_metadata
            tx.execute(
                "INSERT OR REPLACE INTO _v3_cache_metadata (account_id, key, value, updated_at)
                 SELECT 'global', key, value, updated_at FROM cache_metadata",
                [],
            )
            .map_err(|e| format!("Migrate cache_metadata error: {}", e))?;

            // 7. Swap old tables with new v3 tables
            tx.execute_batch(
                "DROP TABLE conversation_state;
                 DROP TABLE messages;
                 DROP TABLE conversations;
                 DROP TABLE cache_metadata;

                 ALTER TABLE _v3_conversations RENAME TO conversations;
                 ALTER TABLE _v3_messages RENAME TO messages;
                 ALTER TABLE _v3_conversation_state RENAME TO conversation_state;
                 ALTER TABLE _v3_cache_metadata RENAME TO cache_metadata;

                 CREATE INDEX IF NOT EXISTS idx_conversations_account_updated
                     ON conversations(account_id, updated_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_messages_account_conv_created
                     ON messages(account_id, conversation_id, created_at DESC, id DESC);
                 CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_account_client_msg
                     ON messages(account_id, sender_id, client_message_id)
                     WHERE client_message_id IS NOT NULL;",
            )
            .map_err(|e| format!("Migration 3 table swap error: {}", e))?;

            // Verify zero foreign key violations before committing
            let fk_violations: i64 = tx
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check()", [], |r| {
                    r.get(0)
                })
                .unwrap_or(0);
            if fk_violations > 0 {
                return Err(format!(
                    "Migration 3 aborted: {} foreign key violations detected",
                    fk_violations
                ));
            }

            tx.execute(
                "INSERT INTO _migrations (version, applied_at) VALUES (3, ?1)",
                params![now],
            )
            .map_err(|e| format!("Migration 3 record error: {}", e))?;

            tx.commit()
                .map_err(|e| format!("Migration 3 commit error: {}", e))?;
            Ok(())
        })();

        // Always re-enable foreign_keys
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");

        migration_res
    }

    /// Seeds offline demo conversations and messages strictly under `account_id = 'offline_demo'`.
    /// Never called automatically on production databases.
    pub fn seed_if_empty(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = now_epoch_secs();
        let schema_ver = Self::query_schema_version(&conn)?;

        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Seed transaction error: {}", e))?;

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
                "INSERT OR IGNORE INTO conversations (account_id, id, type, title, updated_at)
                 VALUES ('offline_demo', ?1, ?2, ?3, ?4)",
                params![id, c_type, title, updated],
            )
            .map_err(|e| format!("Seed conv error: {}", e))?;
        }

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
                "INSERT OR IGNORE INTO messages (account_id, id, conversation_id, sender_id, content, created_at, delivery_status)
                 VALUES ('offline_demo', ?1, ?2, ?3, ?4, ?5, ?6)",
                params![m_id, conv_id, sender, content, ts, "local_saved"],
            )
            .map_err(|e| format!("Seed msg error: {}", e))?;
        }

        if schema_ver >= 3 {
            tx.execute(
                "INSERT OR IGNORE INTO cache_metadata (account_id, key, value, updated_at) VALUES ('global', ?1, ?2, ?3)",
                params!["schema_version", "3.0", now],
            )
            .map_err(|e| format!("Seed metadata error: {}", e))?;
        } else {
            tx.execute(
                "INSERT OR IGNORE INTO cache_metadata (key, value, updated_at) VALUES (?1, ?2, ?3)",
                params!["schema_version", "1.0", now],
            )
            .map_err(|e| format!("Seed metadata error: {}", e))?;
        }

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
            db_path: None,
        };
        db.apply_migrations()?;
        db.seed_if_empty()?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn new_in_memory_clean() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Failed to open in-memory SQLite: {}", e))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("Failed to set pragmas: {}", e))?;

        let db = DbState {
            conn: Mutex::new(conn),
            db_path: None,
        };
        db.apply_migrations()?;
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

        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 3, "Migration version 3 should be recorded");

        let conv_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE account_id = 'offline_demo'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(conv_count >= 3, "At least 3 seeded conversations expected");

        let msg_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE account_id = 'offline_demo'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(msg_count >= 3, "At least 3 seeded messages expected");

        let schema_ver: String = conn
            .query_row(
                "SELECT value FROM cache_metadata WHERE account_id = 'global' AND key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(schema_ver, "3.0");
    }

    #[test]
    fn test_migration_idempotence() {
        let db = DbState::new_in_memory().expect("Should initialize in-memory DB");
        assert!(db.apply_migrations().is_ok());
        assert!(db.apply_migrations().is_ok());

        let conn = db.conn.lock().unwrap();
        let migration_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            migration_rows, 3,
            "Migration should record 3 versions without duplicates"
        );
    }

    #[test]
    fn test_pagination_and_ordering() {
        let db = DbState::new_in_memory().expect("Should initialize in-memory DB");
        let conn = db.conn.lock().unwrap();

        let conv_id = "test_pagination_conv";
        conn.execute(
            "INSERT INTO conversations (account_id, id, type, title, updated_at) VALUES ('offline_demo', ?1, 'dm', 'Test Pagination', 1000)",
            params![conv_id],
        )
        .unwrap();

        for i in 1..=30 {
            conn.execute(
                "INSERT INTO messages (account_id, id, conversation_id, sender_id, content, created_at, delivery_status)
                 VALUES ('offline_demo', ?1, ?2, 'usr_me', ?3, ?4, 'local_saved')",
                params![
                    format!("msg_{:03}", i),
                    conv_id,
                    format!("Message number {}", i),
                    1000 + i
                ],
            )
            .unwrap();
        }

        let mut stmt = conn
            .prepare(
                "SELECT id, created_at FROM messages WHERE account_id = 'offline_demo' AND conversation_id = ?1 ORDER BY created_at DESC LIMIT 10",
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

        let oldest_ts = page1[9].1;
        let mut stmt2 = conn
            .prepare(
                "SELECT id, created_at FROM messages WHERE account_id = 'offline_demo' AND conversation_id = ?1 AND created_at < ?2 ORDER BY created_at DESC LIMIT 10",
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
            "INSERT INTO conversations (account_id, id, type, title, updated_at) VALUES ('offline_demo', ?1, 'dm', 'Test Draft', 2000)",
            params![conv_id],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO conversation_state (account_id, conversation_id, draft_text) VALUES ('offline_demo', ?1, ?2)
             ON CONFLICT(account_id, conversation_id) DO UPDATE SET draft_text = ?2",
            params![conv_id, "Escrevendo um rascunho importante..."],
        )
        .unwrap();

        let draft: String = conn
            .query_row(
                "SELECT draft_text FROM conversation_state WHERE account_id = 'offline_demo' AND conversation_id = ?1",
                params![conv_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(draft, "Escrevendo um rascunho importante...");

        conn.execute(
            "INSERT INTO conversation_state (account_id, conversation_id, last_read_message_id) VALUES ('offline_demo', ?1, ?2)
             ON CONFLICT(account_id, conversation_id) DO UPDATE SET last_read_message_id = ?2",
            params![conv_id, "msg_099"],
        )
        .unwrap();

        let (read_id, draft_after): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT last_read_message_id, draft_text FROM conversation_state WHERE account_id = 'offline_demo' AND conversation_id = ?1",
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
