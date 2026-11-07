use crate::db::{DbConversation, DbConversationState, DbMessage, DbState};
use rusqlite::params;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[tauri::command]
pub fn get_conversations(state: State<DbState>) -> Result<Vec<DbConversation>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, type, title, updated_at, account_id FROM conversations ORDER BY updated_at DESC")
        .map_err(|e| format!("Query prepare error: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(DbConversation {
                id: row.get(0)?,
                conversation_type: row.get(1)?,
                title: row.get(2)?,
                updated_at: row.get(3)?,
                account_id: row.get(4).unwrap_or_else(|_| "offline_demo".to_string()),
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
pub fn get_messages(
    state: State<DbState>,
    conversation_id: String,
    limit: i64,
    before_timestamp: Option<i64>,
) -> Result<Vec<DbMessage>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    let limit = if limit <= 0 { 30 } else { limit.min(100) };

    let mut messages = Vec::new();

    if let Some(before_ts) = before_timestamp {
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, sender_id, content, created_at, delivery_status,
                        client_message_id, edited_at, deleted_at, delivered_at, read_at, is_mine, account_id 
                 FROM messages 
                 WHERE conversation_id = ?1 AND created_at < ?2 
                 ORDER BY created_at DESC 
                 LIMIT ?3",
            )
            .map_err(|e| format!("Query prepare error: {}", e))?;

        let rows = stmt
            .query_map(params![conversation_id, before_ts, limit], |row| {
                Ok(DbMessage {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                    delivery_status: row.get(5)?,
                    client_message_id: row.get(6).ok(),
                    edited_at: row.get(7).ok(),
                    deleted_at: row.get(8).ok(),
                    delivered_at: row.get(9).ok(),
                    read_at: row.get(10).ok(),
                    is_mine: row.get::<_, i64>(11).map(|v| v != 0).unwrap_or(true),
                    account_id: row.get(12).unwrap_or_else(|_| "offline_demo".to_string()),
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
                 WHERE conversation_id = ?1 
                 ORDER BY created_at DESC 
                 LIMIT ?2",
            )
            .map_err(|e| format!("Query prepare error: {}", e))?;

        let rows = stmt
            .query_map(params![conversation_id, limit], |row| {
                Ok(DbMessage {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                    delivery_status: row.get(5)?,
                    client_message_id: row.get(6).ok(),
                    edited_at: row.get(7).ok(),
                    deleted_at: row.get(8).ok(),
                    delivered_at: row.get(9).ok(),
                    read_at: row.get(10).ok(),
                    is_mine: row.get::<_, i64>(11).map(|v| v != 0).unwrap_or(true),
                    account_id: row.get(12).unwrap_or_else(|_| "offline_demo".to_string()),
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
pub fn ensure_conversation(
    state: State<DbState>,
    id: String,
    conversation_type: String,
    title: String,
) -> Result<DbConversation, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    conn.execute(
        "INSERT INTO conversations (id, type, title, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET title = ?3 WHERE conversations.title != ?3",
        params![id, conversation_type, title, now],
    )
    .map_err(|e| format!("Ensure conversation error: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT id, type, title, updated_at, account_id FROM conversations WHERE id = ?1")
        .map_err(|e| format!("Query prepare error: {}", e))?;

    let conv = stmt
        .query_row(params![id], |row| {
            Ok(DbConversation {
                id: row.get(0)?,
                conversation_type: row.get(1)?,
                title: row.get(2)?,
                updated_at: row.get(3)?,
                account_id: row.get(4).unwrap_or_else(|_| "offline_demo".to_string()),
            })
        })
        .map_err(|e| format!("Query row error: {}", e))?;

    Ok(conv)
}

#[tauri::command]
pub fn save_message(
    state: State<DbState>,
    conversation_id: String,
    sender_id: String,
    content: String,
) -> Result<DbMessage, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let id = format!("msg_{}", nanos);
    let delivery_status = "local_saved".to_string();

    let msg = DbMessage {
        id: id.clone(),
        conversation_id: conversation_id.clone(),
        sender_id: sender_id.clone(),
        content: content.clone(),
        created_at: now,
        delivery_status: delivery_status.clone(),
        client_message_id: None,
        edited_at: None,
        deleted_at: None,
        delivered_at: None,
        read_at: None,
        is_mine: true,
        account_id: "offline_demo".to_string(),
    };

    // 1. Ensure conversation exists BEFORE inserting message to satisfy foreign key
    conn.execute(
        "INSERT INTO conversations (id, type, title, updated_at)
         VALUES (?1, 'dm', ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET updated_at = ?2",
        params![conversation_id, now],
    )
    .map_err(|e| format!("Ensure conversation error: {}", e))?;

    // 2. Insert message
    conn.execute(
        "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, delivery_status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![msg.id, msg.conversation_id, msg.sender_id, msg.content, msg.created_at, msg.delivery_status],
    )
    .map_err(|e| format!("Insert message error: {}", e))?;

    Ok(msg)
}

#[tauri::command]
pub fn get_conversation_state(
    state: State<DbState>,
    conversation_id: String,
) -> Result<Option<DbConversationState>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

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
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn save_conversation_draft(
    state: State<DbState>,
    conversation_id: String,
    draft_text: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    // Ensure conversation exists in conversations table before inserting into conversation_state
    conn.execute(
        "INSERT INTO conversations (id, type, title, updated_at)
         VALUES (?1, 'dm', ?1, ?2)
         ON CONFLICT(id) DO NOTHING",
        params![conversation_id, now],
    )
    .map_err(|e| format!("Ensure conversation for draft error: {}", e))?;

    conn.execute(
        "INSERT INTO conversation_state (conversation_id, draft_text)
         VALUES (?1, ?2)
         ON CONFLICT(conversation_id) DO UPDATE SET draft_text = ?2",
        params![conversation_id, draft_text],
    )
    .map_err(|e| format!("Save draft error: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn mark_conversation_read(
    state: State<DbState>,
    conversation_id: String,
    last_read_message_id: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    // Ensure conversation exists in conversations table before inserting into conversation_state
    conn.execute(
        "INSERT INTO conversations (id, type, title, updated_at)
         VALUES (?1, 'dm', ?1, ?2)
         ON CONFLICT(id) DO NOTHING",
        params![conversation_id, now],
    )
    .map_err(|e| format!("Ensure conversation for mark_read error: {}", e))?;

    conn.execute(
        "INSERT INTO conversation_state (conversation_id, last_read_message_id)
         VALUES (?1, ?2)
         ON CONFLICT(conversation_id) DO UPDATE SET last_read_message_id = ?2",
        params![conversation_id, last_read_message_id],
    )
    .map_err(|e| format!("Mark read error: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn get_cache_metadata(state: State<DbState>, key: String) -> Result<Option<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

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

#[tauri::command]
pub fn set_cache_metadata(state: State<DbState>, key: String, value: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    conn.execute(
        "INSERT INTO cache_metadata (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
        params![key, value, now],
    )
    .map_err(|e| format!("Set metadata error: {}", e))?;

    Ok(())
}
