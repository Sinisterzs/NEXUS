use crate::auth::resolve_and_validate_account_id;
use crate::db::{
    epoch_secs_to_iso8601, get_optional_text_or_int, now_epoch_secs, DbConversation,
    DbConversationState, DbMessage, DbState,
};
use rusqlite::params;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

pub fn get_conversations_for_account(
    state: &DbState,
    account_id: Option<&str>,
) -> Result<Vec<DbConversation>, String> {
    let act_id = resolve_and_validate_account_id(account_id, true)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, type, title, updated_at, account_id
             FROM conversations
             WHERE account_id = ?1
             ORDER BY updated_at DESC",
        )
        .map_err(|e| format!("Query prepare error: {}", e))?;

    let rows = stmt
        .query_map(params![act_id], |row| {
            Ok(DbConversation {
                id: row.get(0)?,
                conversation_type: row.get(1)?,
                title: row.get(2)?,
                updated_at: row.get(3)?,
                account_id: row
                    .get(4)
                    .unwrap_or_else(|_| "offline_demo".to_string()),
            })
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut convs = Vec::new();
    for r in rows {
        convs.push(r.map_err(|e| e.to_string())?);
    }

    Ok(convs)
}

#[tauri::command]
pub fn get_conversations(
    state: State<DbState>,
    account_id: Option<String>,
) -> Result<Vec<DbConversation>, String> {
    get_conversations_for_account(&state, account_id.as_deref())
}

pub fn get_messages_for_account(
    state: &DbState,
    conversation_id: &str,
    limit: i64,
    before_timestamp: Option<i64>,
    account_id: Option<&str>,
) -> Result<Vec<DbMessage>, String> {
    let act_id = resolve_and_validate_account_id(account_id, true)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    let limit = if limit <= 0 { 30 } else { limit.min(100) };
    let mut messages = Vec::new();

    if let Some(before_ts) = before_timestamp {
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, sender_id, content, created_at, delivery_status,
                        client_message_id, edited_at, deleted_at, delivered_at, read_at, is_mine, account_id 
                 FROM messages 
                 WHERE account_id = ?1 AND conversation_id = ?2 AND created_at < ?3 
                 ORDER BY created_at DESC, id DESC 
                 LIMIT ?4",
            )
            .map_err(|e| format!("Query prepare error: {}", e))?;

        let rows = stmt
            .query_map(params![act_id, conversation_id, before_ts, limit], |row| {
                Ok(DbMessage {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                    delivery_status: row.get(5)?,
                    client_message_id: row.get(6).ok().flatten(),
                    edited_at: get_optional_text_or_int(row, 7),
                    deleted_at: get_optional_text_or_int(row, 8),
                    delivered_at: get_optional_text_or_int(row, 9),
                    read_at: get_optional_text_or_int(row, 10),
                    is_mine: row.get::<_, i64>(11).map(|v| v != 0).unwrap_or(true),
                    account_id: row
                        .get(12)
                        .unwrap_or_else(|_| "offline_demo".to_string()),
                })
            })
            .map_err(|e| format!("Query error: {}", e))?;

        for r in rows {
            messages.push(r.map_err(|e| e.to_string())?);
        }
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, sender_id, content, created_at, delivery_status,
                        client_message_id, edited_at, deleted_at, delivered_at, read_at, is_mine, account_id 
                 FROM messages 
                 WHERE account_id = ?1 AND conversation_id = ?2 
                 ORDER BY created_at DESC, id DESC 
                 LIMIT ?3",
            )
            .map_err(|e| format!("Query prepare error: {}", e))?;

        let rows = stmt
            .query_map(params![act_id, conversation_id, limit], |row| {
                Ok(DbMessage {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                    delivery_status: row.get(5)?,
                    client_message_id: row.get(6).ok().flatten(),
                    edited_at: get_optional_text_or_int(row, 7),
                    deleted_at: get_optional_text_or_int(row, 8),
                    delivered_at: get_optional_text_or_int(row, 9),
                    read_at: get_optional_text_or_int(row, 10),
                    is_mine: row.get::<_, i64>(11).map(|v| v != 0).unwrap_or(true),
                    account_id: row
                        .get(12)
                        .unwrap_or_else(|_| "offline_demo".to_string()),
                })
            })
            .map_err(|e| format!("Query error: {}", e))?;

        for r in rows {
            messages.push(r.map_err(|e| e.to_string())?);
        }
    }

    // Reverse to return in chronological order (oldest to newest)
    messages.reverse();

    Ok(messages)
}

#[tauri::command]
pub fn get_messages(
    state: State<DbState>,
    conversation_id: String,
    limit: i64,
    before_timestamp: Option<i64>,
    account_id: Option<String>,
) -> Result<Vec<DbMessage>, String> {
    get_messages_for_account(
        &state,
        &conversation_id,
        limit,
        before_timestamp,
        account_id.as_deref(),
    )
}

pub fn ensure_conversation_for_account(
    state: &DbState,
    id: &str,
    conversation_type: &str,
    title: &str,
    account_id: Option<&str>,
) -> Result<DbConversation, String> {
    let act_id = resolve_and_validate_account_id(account_id, true)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = now_epoch_secs();
    let schema_ver = DbState::query_schema_version(&conn)?;

    if schema_ver >= 3 {
        let iso = epoch_secs_to_iso8601(now);
        conn.execute(
            "INSERT INTO conversations (account_id, id, type, title, updated_at, created_at_iso, updated_at_iso)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(account_id, id) DO UPDATE SET title = ?4 WHERE conversations.title != ?4",
            params![act_id, id, conversation_type, title, now, iso],
        )
        .map_err(|e| format!("Ensure conversation error: {}", e))?;
    } else {
        conn.execute(
            "INSERT INTO conversations (id, type, title, updated_at, account_id)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET title = ?3 WHERE conversations.account_id = ?5 AND conversations.title != ?3",
            params![id, conversation_type, title, now, act_id],
        )
        .map_err(|e| format!("Ensure conversation error: {}", e))?;
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, type, title, updated_at, account_id
             FROM conversations
             WHERE account_id = ?1 AND id = ?2",
        )
        .map_err(|e| format!("Query prepare error: {}", e))?;

    let conv = stmt
        .query_row(params![act_id, id], |row| {
            Ok(DbConversation {
                id: row.get(0)?,
                conversation_type: row.get(1)?,
                title: row.get(2)?,
                updated_at: row.get(3)?,
                account_id: row
                    .get(4)
                    .unwrap_or_else(|_| "offline_demo".to_string()),
            })
        })
        .map_err(|e| format!("Query row error: {}", e))?;

    Ok(conv)
}

#[tauri::command]
pub fn ensure_conversation(
    state: State<DbState>,
    id: String,
    conversation_type: String,
    title: String,
    account_id: Option<String>,
) -> Result<DbConversation, String> {
    ensure_conversation_for_account(
        &state,
        &id,
        &conversation_type,
        &title,
        account_id.as_deref(),
    )
}

pub fn save_message_for_account(
    state: &DbState,
    conversation_id: &str,
    sender_id: &str,
    content: &str,
    account_id: Option<&str>,
) -> Result<DbMessage, String> {
    let act_id = resolve_and_validate_account_id(account_id, true)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let schema_ver = DbState::query_schema_version(&conn)?;

    let now = now_epoch_secs();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let id = format!("msg_{}_{}", act_id, nanos);
    let delivery_status = "local_saved".to_string();

    let msg = DbMessage {
        id: id.clone(),
        conversation_id: conversation_id.to_string(),
        sender_id: sender_id.to_string(),
        content: content.to_string(),
        created_at: now,
        delivery_status: delivery_status.clone(),
        client_message_id: None,
        edited_at: None,
        deleted_at: None,
        delivered_at: None,
        read_at: None,
        is_mine: true,
        account_id: act_id.clone(),
    };

    if schema_ver >= 3 {
        let iso = epoch_secs_to_iso8601(now);
        conn.execute(
            "INSERT INTO conversations (account_id, id, type, title, updated_at, created_at_iso, updated_at_iso)
             VALUES (?1, ?2, 'dm', ?2, ?3, ?4, ?4)
             ON CONFLICT(account_id, id) DO UPDATE SET updated_at = ?3, updated_at_iso = ?4",
            params![act_id, conversation_id, now, iso],
        )
        .map_err(|e| format!("Ensure conversation error: {}", e))?;

        conn.execute(
            "INSERT INTO messages (account_id, id, conversation_id, sender_id, content, created_at, created_at_iso, delivery_status, is_mine)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)",
            params![
                msg.account_id,
                msg.id,
                msg.conversation_id,
                msg.sender_id,
                msg.content,
                msg.created_at,
                iso,
                msg.delivery_status
            ],
        )
        .map_err(|e| format!("Insert message error: {}", e))?;
    } else {
        conn.execute(
            "INSERT INTO conversations (id, type, title, updated_at, account_id)
             VALUES (?1, 'dm', ?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET updated_at = ?2 WHERE conversations.account_id = ?3",
            params![conversation_id, now, act_id],
        )
        .map_err(|e| format!("Ensure conversation error: {}", e))?;

        conn.execute(
            "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, delivery_status, account_id, is_mine)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
            params![
                msg.id,
                msg.conversation_id,
                msg.sender_id,
                msg.content,
                msg.created_at,
                msg.delivery_status,
                msg.account_id
            ],
        )
        .map_err(|e| format!("Insert message error: {}", e))?;
    }

    Ok(msg)
}

#[tauri::command]
pub fn save_message(
    state: State<DbState>,
    conversation_id: String,
    sender_id: String,
    content: String,
    account_id: Option<String>,
) -> Result<DbMessage, String> {
    save_message_for_account(
        &state,
        &conversation_id,
        &sender_id,
        &content,
        account_id.as_deref(),
    )
}

pub fn get_conversation_state_for_account(
    state: &DbState,
    conversation_id: &str,
    account_id: Option<&str>,
) -> Result<Option<DbConversationState>, String> {
    let act_id = resolve_and_validate_account_id(account_id, true)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let schema_ver = DbState::query_schema_version(&conn)?;

    if schema_ver >= 3 {
        let mut stmt = conn
            .prepare(
                "SELECT conversation_id, last_read_message_id, draft_text, account_id 
                 FROM conversation_state 
                 WHERE account_id = ?1 AND conversation_id = ?2",
            )
            .map_err(|e| format!("Query prepare error: {}", e))?;

        let mut rows = stmt
            .query(params![act_id, conversation_id])
            .map_err(|e| format!("Query error: {}", e))?;

        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            Ok(Some(DbConversationState {
                conversation_id: row.get(0).map_err(|e| e.to_string())?,
                last_read_message_id: row.get(1).map_err(|e| e.to_string())?,
                draft_text: row.get(2).map_err(|e| e.to_string())?,
                account_id: row
                    .get(3)
                    .unwrap_or_else(|_| act_id.clone()),
            }))
        } else {
            Ok(None)
        }
    } else {
        // Fallback for v2 pre-migration DB
        let mut stmt = conn
            .prepare(
                "SELECT conversation_id, last_read_message_id, draft_text 
                 FROM conversation_state 
                 WHERE conversation_id = ?1",
            )
            .map_err(|e| format!("Query prepare error: {}", e))?;

        let mut rows = stmt
            .query(params![conversation_id])
            .map_err(|e| format!("Query error: {}", e))?;

        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            Ok(Some(DbConversationState {
                conversation_id: row.get(0).map_err(|e| e.to_string())?,
                last_read_message_id: row.get(1).map_err(|e| e.to_string())?,
                draft_text: row.get(2).map_err(|e| e.to_string())?,
                account_id: act_id,
            }))
        } else {
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn get_conversation_state(
    state: State<DbState>,
    conversation_id: String,
    account_id: Option<String>,
) -> Result<Option<DbConversationState>, String> {
    get_conversation_state_for_account(&state, &conversation_id, account_id.as_deref())
}

pub fn save_conversation_draft_for_account(
    state: &DbState,
    conversation_id: &str,
    draft_text: &str,
    account_id: Option<&str>,
) -> Result<(), String> {
    let act_id = resolve_and_validate_account_id(account_id, true)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = now_epoch_secs();
    let schema_ver = DbState::query_schema_version(&conn)?;

    if schema_ver >= 3 {
        let iso = epoch_secs_to_iso8601(now);
        conn.execute(
            "INSERT INTO conversations (account_id, id, type, title, updated_at, created_at_iso, updated_at_iso)
             VALUES (?1, ?2, 'dm', ?2, ?3, ?4, ?4)
             ON CONFLICT(account_id, id) DO NOTHING",
            params![act_id, conversation_id, now, iso],
        )
        .map_err(|e| format!("Ensure conversation for draft error: {}", e))?;

        conn.execute(
            "INSERT INTO conversation_state (account_id, conversation_id, draft_text, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_id, conversation_id) DO UPDATE SET draft_text = ?3, updated_at = ?4",
            params![act_id, conversation_id, draft_text, now],
        )
        .map_err(|e| format!("Save draft error: {}", e))?;
    } else {
        conn.execute(
            "INSERT INTO conversations (id, type, title, updated_at, account_id)
             VALUES (?1, 'dm', ?1, ?2, ?3)
             ON CONFLICT(id) DO NOTHING",
            params![conversation_id, now, act_id],
        )
        .map_err(|e| format!("Ensure conversation for draft error: {}", e))?;

        conn.execute(
            "INSERT INTO conversation_state (conversation_id, draft_text)
             VALUES (?1, ?2)
             ON CONFLICT(conversation_id) DO UPDATE SET draft_text = ?2",
            params![conversation_id, draft_text],
        )
        .map_err(|e| format!("Save draft error: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn save_conversation_draft(
    state: State<DbState>,
    conversation_id: String,
    draft_text: String,
    account_id: Option<String>,
) -> Result<(), String> {
    save_conversation_draft_for_account(
        &state,
        &conversation_id,
        &draft_text,
        account_id.as_deref(),
    )
}

pub fn mark_conversation_read_for_account(
    state: &DbState,
    conversation_id: &str,
    last_read_message_id: &str,
    account_id: Option<&str>,
) -> Result<(), String> {
    let act_id = resolve_and_validate_account_id(account_id, true)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = now_epoch_secs();
    let schema_ver = DbState::query_schema_version(&conn)?;

    if schema_ver >= 3 {
        let iso = epoch_secs_to_iso8601(now);
        conn.execute(
            "INSERT INTO conversations (account_id, id, type, title, updated_at, created_at_iso, updated_at_iso)
             VALUES (?1, ?2, 'dm', ?2, ?3, ?4, ?4)
             ON CONFLICT(account_id, id) DO NOTHING",
            params![act_id, conversation_id, now, iso],
        )
        .map_err(|e| format!("Ensure conversation for mark_read error: {}", e))?;

        conn.execute(
            "INSERT INTO conversation_state (account_id, conversation_id, last_read_message_id, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_id, conversation_id) DO UPDATE SET last_read_message_id = ?3, updated_at = ?4",
            params![act_id, conversation_id, last_read_message_id, now],
        )
        .map_err(|e| format!("Mark read error: {}", e))?;
    } else {
        conn.execute(
            "INSERT INTO conversations (id, type, title, updated_at, account_id)
             VALUES (?1, 'dm', ?1, ?2, ?3)
             ON CONFLICT(id) DO NOTHING",
            params![conversation_id, now, act_id],
        )
        .map_err(|e| format!("Ensure conversation for mark_read error: {}", e))?;

        conn.execute(
            "INSERT INTO conversation_state (conversation_id, last_read_message_id)
             VALUES (?1, ?2)
             ON CONFLICT(conversation_id) DO UPDATE SET last_read_message_id = ?2",
            params![conversation_id, last_read_message_id],
        )
        .map_err(|e| format!("Mark read error: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn mark_conversation_read(
    state: State<DbState>,
    conversation_id: String,
    last_read_message_id: String,
    account_id: Option<String>,
) -> Result<(), String> {
    mark_conversation_read_for_account(
        &state,
        &conversation_id,
        &last_read_message_id,
        account_id.as_deref(),
    )
}

pub fn get_cache_metadata_for_account(
    state: &DbState,
    key: &str,
    account_id: Option<&str>,
) -> Result<Option<String>, String> {
    let act_id = match account_id {
        Some(a) if !a.trim().is_empty() => resolve_and_validate_account_id(Some(a), true)?,
        _ => "global".to_string(),
    };
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let schema_ver = DbState::query_schema_version(&conn)?;

    if schema_ver >= 3 {
        let mut stmt = conn
            .prepare("SELECT value FROM cache_metadata WHERE account_id = ?1 AND key = ?2")
            .map_err(|e| format!("Query prepare error: {}", e))?;
        let mut rows = stmt
            .query(params![act_id, key])
            .map_err(|e| format!("Query error: {}", e))?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let val: String = row.get(0).map_err(|e| e.to_string())?;
            Ok(Some(val))
        } else {
            Ok(None)
        }
    } else {
        let mut stmt = conn
            .prepare("SELECT value FROM cache_metadata WHERE key = ?1")
            .map_err(|e| format!("Query prepare error: {}", e))?;
        let mut rows = stmt
            .query(params![key])
            .map_err(|e| format!("Query error: {}", e))?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let val: String = row.get(0).map_err(|e| e.to_string())?;
            Ok(Some(val))
        } else {
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn get_cache_metadata(
    state: State<DbState>,
    key: String,
    account_id: Option<String>,
) -> Result<Option<String>, String> {
    get_cache_metadata_for_account(&state, &key, account_id.as_deref())
}

pub fn set_cache_metadata_for_account(
    state: &DbState,
    key: &str,
    value: &str,
    account_id: Option<&str>,
) -> Result<(), String> {
    let act_id = match account_id {
        Some(a) if !a.trim().is_empty() => resolve_and_validate_account_id(Some(a), true)?,
        _ => "global".to_string(),
    };
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = now_epoch_secs();
    let schema_ver = DbState::query_schema_version(&conn)?;

    if schema_ver >= 3 {
        conn.execute(
            "INSERT INTO cache_metadata (account_id, key, value, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_id, key) DO UPDATE SET value = ?3, updated_at = ?4",
            params![act_id, key, value, now],
        )
        .map_err(|e| format!("Set metadata error: {}", e))?;
    } else {
        conn.execute(
            "INSERT INTO cache_metadata (key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
            params![key, value, now],
        )
        .map_err(|e| format!("Set metadata error: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn set_cache_metadata(
    state: State<DbState>,
    key: String,
    value: String,
    account_id: Option<String>,
) -> Result<(), String> {
    set_cache_metadata_for_account(&state, &key, &value, account_id.as_deref())
}

#[tauri::command]
pub fn db_get_schema_version(state: State<DbState>) -> Result<i64, String> {
    state.current_schema_version()
}

static V3_MIGRATION_IN_PROGRESS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

struct MigrationLockGuard;
impl Drop for MigrationLockGuard {
    fn drop(&mut self) {
        V3_MIGRATION_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn db_migrate_to_v3(
    state: State<DbState>,
    confirm: bool,
) -> Result<serde_json::Value, String> {
    if !confirm {
        return Err("Migração v3 requer autorização explícita (confirm: true).".to_string());
    }

    // Native layer independent authorization check:
    // A JavaScript IPC argument alone does not constitute independent native authorization.
    // The native host environment must explicitly grant permission via NEXUS_ALLOW_DB_MIGRATION_V3=1.
    let native_allowed = std::env::var("NEXUS_ALLOW_DB_MIGRATION_V3")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if !native_allowed {
        return Err(
            "Migração estrutural v3 bloqueada na camada nativa: requer autorização explícita do host via variável de ambiente NEXUS_ALLOW_DB_MIGRATION_V3=1."
                .to_string(),
        );
    }

    if V3_MIGRATION_IN_PROGRESS
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        return Err("Operação de migração v3 já está em execução.".to_string());
    }
    let _guard = MigrationLockGuard;

    state.apply_migrations_with_options(true)?;
    let ver = state.current_schema_version()?;
    Ok(serde_json::json!({
        "status": "success",
        "schema_version": ver
    }))
}
