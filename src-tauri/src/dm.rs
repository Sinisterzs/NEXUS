use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::auth::get_api_base;
use crate::db::DbState;

fn require_token() -> Result<String, String> {
    crate::auth::get_secure_token()
        .ok_or_else(|| "Sessão não encontrada. Faça login novamente.".to_string())
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendSummaryDto {
    pub id: String,
    pub username: String,
    pub tag: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub status: String,
    pub custom_status: Option<String>,
    pub activity: Option<String>,
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectMessageDto {
    pub id: String,
    pub conversation_id: String,
    pub sender_id: String,
    pub client_message_id: String,
    pub content: String,
    pub created_at: String,
    pub edited_at: Option<String>,
    pub deleted_at: Option<String>,
    pub delivered_at: Option<String>,
    pub read_at: Option<String>,
    pub is_mine: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectConversationDto {
    pub id: String,
    pub other_user: FriendSummaryDto,
    pub last_message: Option<DirectMessageDto>,
    pub unread_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct GatewayTicketResponse {
    pub ticket: String,
    pub expires_in_secs: u64,
}

#[derive(Debug, Deserialize)]
struct ApiErrorDetail {
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct ApiErrorResponse {
    pub error: ApiErrorDetail,
}

/// Request a short-lived (60s) single-use ticket for WebSocket gateway authentication
#[tauri::command]
pub async fn gateway_get_ticket() -> Result<String, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/gateway/ticket", get_api_base());

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha de conexão com o servidor Nexus: {}", e))?;

    if resp.status().is_success() {
        let ticket_resp = resp
            .json::<GatewayTicketResponse>()
            .await
            .map_err(|e| format!("Falha ao decodificar ticket do Gateway: {}", e))?;
        Ok(ticket_resp.ticket)
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao solicitar ticket.".to_string())?;
        Err(err.error.message)
    }
}

/// Lists DM conversations from remote backend and updates local SQLite cache
#[tauri::command]
pub async fn dm_list_conversations(
    state: State<'_, DbState>,
    account_id: Option<String>,
) -> Result<Vec<DirectConversationDto>, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/dm/conversations", get_api_base());
    let act_id = account_id.unwrap_or_else(|| "offline_demo".to_string());

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await;

    match resp {
        Ok(response) if response.status().is_success() => {
            let convs = response
                .json::<Vec<DirectConversationDto>>()
                .await
                .map_err(|e| format!("Falha ao decodificar conversas: {}", e))?;

            // Sync to local SQLite cache
            if let Ok(conn) = state.conn.lock() {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;

                for c in &convs {
                    let _ = conn.execute(
                        "INSERT INTO conversations (id, type, title, updated_at, account_id)
                         VALUES (?1, 'dm', ?2, ?3, ?4)
                         ON CONFLICT(id) DO UPDATE SET title = ?2, updated_at = ?3, account_id = ?4",
                        params![c.id, c.other_user.display_name, now, act_id],
                    );

                    if let Some(ref m) = c.last_message {
                        let _ = conn.execute(
                            "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, delivery_status, client_message_id, edited_at, deleted_at, delivered_at, read_at, is_mine, account_id)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                             ON CONFLICT(id) DO UPDATE SET content = ?4, delivered_at = ?10, read_at = ?11, edited_at = ?8, deleted_at = ?9",
                            params![
                                m.id,
                                m.conversation_id,
                                m.sender_id,
                                m.content,
                                now,
                                if m.read_at.is_some() { "read" } else if m.delivered_at.is_some() { "delivered" } else { "sent" },
                                m.client_message_id,
                                m.edited_at.as_deref().map(|_| now),
                                m.deleted_at.as_deref().map(|_| now),
                                m.delivered_at.as_deref().map(|_| now),
                                m.read_at.as_deref().map(|_| now),
                                if m.is_mine { 1 } else { 0 },
                                act_id
                            ],
                        );
                    }
                }
            }

            Ok(convs)
        }
        _ => {
            // Offline / network failure: fallback to local cache
            Ok(Vec::new())
        }
    }
}

/// Finds or creates a DM conversation with a target user
#[tauri::command]
pub async fn dm_get_or_create_conversation(
    state: State<'_, DbState>,
    target_user_id: Option<String>,
    username: Option<String>,
    account_id: Option<String>,
) -> Result<DirectConversationDto, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/dm/conversations", get_api_base());
    let act_id = account_id.unwrap_or_else(|| "offline_demo".to_string());

    let payload = serde_json::json!({
        "target_user_id": target_user_id,
        "username": username,
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão com o servidor: {}", e))?;

    if resp.status().is_success() {
        let conv = resp
            .json::<DirectConversationDto>()
            .await
            .map_err(|e| format!("Falha ao decodificar conversa: {}", e))?;

        // Cache in SQLite
        if let Ok(conn) = state.conn.lock() {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;

            let _ = conn.execute(
                "INSERT INTO conversations (id, type, title, updated_at, account_id)
                 VALUES (?1, 'dm', ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET title = ?2, updated_at = ?3, account_id = ?4",
                params![conv.id, conv.other_user.display_name, now, act_id],
            );
        }

        Ok(conv)
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao abrir conversa.".to_string())?;
        Err(err.error.message)
    }
}

/// Fetches messages in conversation with keyset pagination
#[tauri::command]
pub async fn dm_get_messages(
    state: State<'_, DbState>,
    conversation_id: String,
    limit: Option<i64>,
    before_id: Option<String>,
    account_id: Option<String>,
) -> Result<Vec<DirectMessageDto>, String> {
    let token = require_token()?;
    let client = http_client();
    let limit_val = limit.unwrap_or(50);
    let act_id = account_id.unwrap_or_else(|| "offline_demo".to_string());

    let mut url = format!(
        "{}/v1/dm/conversations/{}/messages?limit={}",
        get_api_base(),
        conversation_id,
        limit_val
    );
    if let Some(b_id) = before_id {
        url.push_str(&format!("&before_id={}", b_id));
    }

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await;

    match resp {
        Ok(response) if response.status().is_success() => {
            let messages = response
                .json::<Vec<DirectMessageDto>>()
                .await
                .map_err(|e| format!("Falha ao decodificar mensagens: {}", e))?;

            // Sync to local SQLite cache
            if let Ok(conn) = state.conn.lock() {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;

                for m in &messages {
                    let _ = conn.execute(
                        "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, delivery_status, client_message_id, edited_at, deleted_at, delivered_at, read_at, is_mine, account_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                         ON CONFLICT(id) DO UPDATE SET content = ?4, delivered_at = ?10, read_at = ?11, edited_at = ?8, deleted_at = ?9",
                        params![
                            m.id,
                            m.conversation_id,
                            m.sender_id,
                            m.content,
                            now,
                            if m.read_at.is_some() { "read" } else if m.delivered_at.is_some() { "delivered" } else { "sent" },
                            m.client_message_id,
                            m.edited_at.as_deref().map(|_| now),
                            m.deleted_at.as_deref().map(|_| now),
                            m.delivered_at.as_deref().map(|_| now),
                            m.read_at.as_deref().map(|_| now),
                            if m.is_mine { 1 } else { 0 },
                            act_id
                        ],
                    );
                }
            }

            Ok(messages)
        }
        _ => {
            // Offline fallback: load from SQLite cache
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "SELECT id, conversation_id, sender_id, content, created_at, delivery_status,
                            client_message_id, edited_at, deleted_at, delivered_at, read_at, is_mine 
                     FROM messages 
                     WHERE conversation_id = ?1 AND account_id = ?2
                     ORDER BY created_at DESC 
                     LIMIT ?3",
                )
                .map_err(|e| e.to_string())?;

            let rows = stmt
                .query_map(params![conversation_id, act_id, limit_val], |r| {
                    Ok(DirectMessageDto {
                        id: r.get(0)?,
                        conversation_id: r.get(1)?,
                        sender_id: r.get(2)?,
                        content: r.get(3)?,
                        created_at: r.get::<_, i64>(4)?.to_string(),
                        client_message_id: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        edited_at: r.get::<_, Option<i64>>(7)?.map(|t| t.to_string()),
                        deleted_at: r.get::<_, Option<i64>>(8)?.map(|t| t.to_string()),
                        delivered_at: r.get::<_, Option<i64>>(9)?.map(|t| t.to_string()),
                        read_at: r.get::<_, Option<i64>>(10)?.map(|t| t.to_string()),
                        is_mine: r.get::<_, i64>(11).map(|v| v != 0).unwrap_or(true),
                    })
                })
                .map_err(|e| e.to_string())?;

            let mut cached = Vec::new();
            for r in rows {
                if let Ok(m) = r {
                    cached.push(m);
                }
            }
            cached.reverse();
            Ok(cached)
        }
    }
}

/// Sends a direct message with client-generated UUID for idempotency
#[tauri::command]
pub async fn dm_send_message(
    state: State<'_, DbState>,
    conversation_id: String,
    content: String,
    client_message_id: Option<String>,
    account_id: Option<String>,
) -> Result<DirectMessageDto, String> {
    let clean = content.trim();
    if clean.is_empty() {
        return Err("A mensagem não pode estar vazia.".to_string());
    }
    if clean.chars().count() > 2000 {
        return Err("A mensagem não pode ter mais de 2000 caracteres.".to_string());
    }

    let token = require_token()?;
    let client_msg_id = client_message_id
        .and_then(|id| Uuid::parse_str(&id).ok())
        .unwrap_or_else(Uuid::new_v4);
    let act_id = account_id.unwrap_or_else(|| "offline_demo".to_string());

    let client = http_client();
    let url = format!(
        "{}/v1/dm/conversations/{}/messages",
        get_api_base(),
        conversation_id
    );

    let payload = serde_json::json!({
        "client_message_id": client_msg_id,
        "content": clean,
    });

    // 1. Optimistic insert in SQLite with 'sending' status
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let temp_id = format!("local_{}", client_msg_id);

    if let Ok(conn) = state.conn.lock() {
        let _ = conn.execute(
            "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, delivery_status, client_message_id, is_mine, account_id)
             VALUES (?1, ?2, 'usr_me', ?3, ?4, 'sending', ?5, 1, ?6)",
            params![temp_id, conversation_id, clean, now, client_msg_id.to_string(), act_id],
        );
    }

    // 2. Perform HTTP POST
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            // Mark failed in SQLite
            if let Ok(conn) = state.conn.lock() {
                let _ = conn.execute(
                    "UPDATE messages SET delivery_status = 'failed' WHERE client_message_id = ?1",
                    params![client_msg_id.to_string()],
                );
            }
            format!("Falha de conexão ao enviar mensagem: {}", e)
        })?;

    if resp.status().is_success() {
        let sent_dto = resp
            .json::<DirectMessageDto>()
            .await
            .map_err(|e| format!("Falha ao decodificar mensagem enviada: {}", e))?;

        // Update local cache with authoritative server ID and delivery status
        if let Ok(conn) = state.conn.lock() {
            let delivery_status = if sent_dto.delivered_at.is_some() {
                "delivered"
            } else {
                "sent"
            };
            let _ = conn.execute(
                "UPDATE messages 
                 SET id = ?1, delivery_status = ?2, delivered_at = ?3 
                 WHERE client_message_id = ?4",
                params![
                    sent_dto.id,
                    delivery_status,
                    sent_dto.delivered_at.as_deref().map(|_| now),
                    client_msg_id.to_string()
                ],
            );
        }

        Ok(sent_dto)
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao enviar mensagem.".to_string())?;

        if let Ok(conn) = state.conn.lock() {
            let _ = conn.execute(
                "UPDATE messages SET delivery_status = 'failed' WHERE client_message_id = ?1",
                params![client_msg_id.to_string()],
            );
        }

        Err(err.error.message)
    }
}

/// Edits a previously sent message
#[tauri::command]
pub async fn dm_edit_message(
    state: State<'_, DbState>,
    message_id: String,
    content: String,
) -> Result<DirectMessageDto, String> {
    let clean = content.trim();
    if clean.is_empty() {
        return Err("A mensagem não pode ficar vazia.".to_string());
    }

    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/dm/messages/{}", get_api_base(), message_id);

    let payload = serde_json::json!({ "content": clean });

    let resp = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão ao editar mensagem: {}", e))?;

    if resp.status().is_success() {
        let edited = resp
            .json::<DirectMessageDto>()
            .await
            .map_err(|e| format!("Falha ao decodificar mensagem editada: {}", e))?;

        // Update local SQLite cache
        if let Ok(conn) = state.conn.lock() {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let _ = conn.execute(
                "UPDATE messages SET content = ?1, edited_at = ?2 WHERE id = ?3",
                params![clean, now, message_id],
            );
        }

        Ok(edited)
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao editar mensagem.".to_string())?;
        Err(err.error.message)
    }
}

/// Soft-deletes a previously sent message (tombstone pattern)
#[tauri::command]
pub async fn dm_delete_message(
    state: State<'_, DbState>,
    message_id: String,
) -> Result<DirectMessageDto, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/dm/messages/{}", get_api_base(), message_id);

    let resp = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha de conexão ao excluir mensagem: {}", e))?;

    if resp.status().is_success() {
        let deleted = resp
            .json::<DirectMessageDto>()
            .await
            .map_err(|e| format!("Falha ao decodificar resposta de exclusão: {}", e))?;

        // Update local SQLite cache
        if let Ok(conn) = state.conn.lock() {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let _ = conn.execute(
                "UPDATE messages SET content = '[Mensagem apagada]', deleted_at = ?1 WHERE id = ?2",
                params![now, message_id],
            );
        }

        Ok(deleted)
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao excluir mensagem.".to_string())?;
        Err(err.error.message)
    }
}

/// Marks a conversation as read up to a message
#[tauri::command]
pub async fn dm_mark_read(
    state: State<'_, DbState>,
    conversation_id: String,
    last_read_message_id: Option<String>,
) -> Result<(), String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!(
        "{}/v1/dm/conversations/{}/read",
        get_api_base(),
        conversation_id
    );

    let payload = serde_json::json!({
        "last_read_message_id": last_read_message_id,
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão ao marcar lido: {}", e))?;

    if resp.status().is_success() {
        if let Ok(conn) = state.conn.lock() {
            let _ = conn.execute(
                "INSERT INTO conversation_state (conversation_id, last_read_message_id) 
                 VALUES (?1, ?2) 
                 ON CONFLICT(conversation_id) DO UPDATE SET last_read_message_id = ?2",
                params![conversation_id, last_read_message_id],
            );
        }
        Ok(())
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro ao marcar conversa como lida.".to_string())?;
        Err(err.error.message)
    }
}

/// Caches an incoming real-time Gateway message into local SQLite
#[tauri::command]
pub fn dm_cache_incoming_message(
    state: State<'_, DbState>,
    message: DirectMessageDto,
    account_id: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let act_id = account_id.unwrap_or_else(|| "offline_demo".to_string());

    let _ = conn.execute(
        "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, delivery_status, client_message_id, delivered_at, is_mine, account_id)
         VALUES (?1, ?2, ?3, ?4, ?5, 'delivered', ?6, ?7, 0, ?8)
         ON CONFLICT(id) DO UPDATE SET content = ?4, delivered_at = ?7",
        params![
            message.id,
            message.conversation_id,
            message.sender_id,
            message.content,
            now,
            message.client_message_id,
            now,
            act_id
        ],
    );

    let _ = conn.execute(
        "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
        params![now, message.conversation_id],
    );

    Ok(())
}
