use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::auth::{get_api_base, resolve_and_validate_account_id};
use crate::db::{
    epoch_secs_to_iso8601, get_optional_text_or_int, now_epoch_secs, parse_iso8601_to_epoch_secs,
    DbState,
};

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

/// Strictly validates that a parameter is a canonical UUID before interpolating into REST URLs.
pub fn validate_uuid(val: &str, field_name: &str) -> Result<String, String> {
    let trimmed = val.trim();
    Uuid::parse_str(trimmed)
        .map(|u| u.to_string())
        .map_err(|_| format!("Parâmetro '{}' inválido: formato UUID esperado.", field_name))
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_status: Option<String>,
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

pub fn compute_delivery_status(m: &DirectMessageDto, fallback: &str) -> String {
    if m.read_at.is_some() {
        "read".to_string()
    } else if m.delivered_at.is_some() {
        "delivered".to_string()
    } else if let Some(ref st) = m.delivery_status {
        st.clone()
    } else {
        fallback.to_string()
    }
}

pub fn upsert_cached_conversation(
    conn: &Connection,
    act_id: &str,
    c: &DirectConversationDto,
) -> Result<(), String> {
    let now = now_epoch_secs();
    let updated_epoch = parse_iso8601_to_epoch_secs(&c.updated_at).unwrap_or(now);
    let schema_ver = DbState::query_schema_version(conn)?;

    if schema_ver >= 3 {
        let other_json = serde_json::to_string(&c.other_user).ok();
        conn.execute(
            "INSERT INTO conversations
             (account_id, id, type, title, updated_at, created_at_iso, updated_at_iso, other_user_json, unread_count)
             VALUES (?1, ?2, 'dm', ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(account_id, id) DO UPDATE SET
                 title = excluded.title,
                 updated_at = MAX(conversations.updated_at, excluded.updated_at),
                 created_at_iso = COALESCE(conversations.created_at_iso, excluded.created_at_iso),
                 updated_at_iso = excluded.updated_at_iso,
                 other_user_json = COALESCE(excluded.other_user_json, conversations.other_user_json),
                 unread_count = excluded.unread_count",
            params![
                act_id,
                c.id,
                c.other_user.display_name,
                updated_epoch,
                c.created_at,
                c.updated_at,
                other_json,
                c.unread_count
            ],
        )
        .map_err(|e| format!("Failed to upsert conversation cache: {}", e))?;
    } else {
        conn.execute(
            "INSERT INTO conversations (id, type, title, updated_at, account_id)
             VALUES (?1, 'dm', ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET title = ?2, updated_at = ?3 WHERE conversations.account_id = ?4",
            params![c.id, c.other_user.display_name, updated_epoch, act_id],
        )
        .map_err(|e| format!("Failed to upsert v2 conversation cache: {}", e))?;
    }
    Ok(())
}

pub fn upsert_cached_message(
    conn: &Connection,
    act_id: &str,
    m: &DirectMessageDto,
    fallback_status: &str,
) -> Result<(), String> {
    let now = now_epoch_secs();
    let created_epoch = parse_iso8601_to_epoch_secs(&m.created_at).unwrap_or(now);
    let created_iso = if m.created_at.trim().is_empty() {
        epoch_secs_to_iso8601(created_epoch)
    } else {
        m.created_at.clone()
    };
    let status = compute_delivery_status(m, fallback_status);
    let is_mine_int = if m.is_mine { 1 } else { 0 };
    let client_msg_opt = if m.client_message_id.trim().is_empty() {
        None
    } else {
        Some(m.client_message_id.clone())
    };
    let schema_ver = DbState::query_schema_version(conn)?;

    if schema_ver >= 3 {
        // Ensure parent conversation exists for (act_id, m.conversation_id)
        conn.execute(
            "INSERT INTO conversations (account_id, id, type, title, updated_at, created_at_iso, updated_at_iso)
             VALUES (?1, ?2, 'dm', ?2, ?3, ?4, ?4)
             ON CONFLICT(account_id, id) DO UPDATE SET
                 updated_at = MAX(conversations.updated_at, excluded.updated_at)",
            params![act_id, m.conversation_id, created_epoch, created_iso],
        )
        .map_err(|e| format!("Failed to ensure parent conversation for message: {}", e))?;

        // If an optimistic/temporary row exists for the same (account_id, sender_id, client_message_id)
        // with a different `id` (e.g. `local_<uuid>`), remove the temporary row before upserting canonical `m.id`.
        if let Some(ref cid) = client_msg_opt {
            let _ = conn.execute(
                "DELETE FROM messages
                 WHERE account_id = ?1 AND client_message_id = ?2 AND id != ?3",
                params![act_id, cid, m.id],
            );
        }

        conn.execute(
            "INSERT INTO messages
             (account_id, id, conversation_id, sender_id, content, created_at, created_at_iso,
              delivery_status, client_message_id, edited_at, deleted_at, delivered_at, read_at, is_mine)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(account_id, id) DO UPDATE SET
                 content = CASE
                     WHEN messages.deleted_at IS NOT NULL THEN messages.content
                     WHEN excluded.deleted_at IS NOT NULL THEN '[Mensagem apagada]'
                     ELSE excluded.content
                 END,
                 edited_at = CASE
                     WHEN messages.deleted_at IS NOT NULL OR excluded.deleted_at IS NOT NULL THEN messages.edited_at
                     ELSE COALESCE(excluded.edited_at, messages.edited_at)
                 END,
                 deleted_at = COALESCE(messages.deleted_at, excluded.deleted_at),
                 delivered_at = COALESCE(messages.delivered_at, excluded.delivered_at),
                 read_at = COALESCE(messages.read_at, excluded.read_at),
                 delivery_status = CASE
                     WHEN messages.delivery_status = 'read' OR excluded.delivery_status = 'read'
                          OR messages.read_at IS NOT NULL OR excluded.read_at IS NOT NULL THEN 'read'
                     WHEN messages.delivery_status = 'delivered' OR excluded.delivery_status = 'delivered'
                          OR messages.delivered_at IS NOT NULL OR excluded.delivered_at IS NOT NULL THEN 'delivered'
                     WHEN messages.delivery_status = 'sent' OR excluded.delivery_status = 'sent' THEN 'sent'
                     ELSE excluded.delivery_status
                 END",
            params![
                act_id,
                m.id,
                m.conversation_id,
                m.sender_id,
                if m.deleted_at.is_some() {
                    "[Mensagem apagada]"
                } else {
                    &m.content
                },
                created_epoch,
                created_iso,
                status,
                client_msg_opt,
                m.edited_at,
                m.deleted_at,
                m.delivered_at,
                m.read_at,
                is_mine_int,
            ],
        )
        .map_err(|e| format!("Failed to upsert message cache: {}", e))?;
    } else {
        conn.execute(
            "INSERT INTO conversations (id, type, title, updated_at, account_id)
             VALUES (?1, 'dm', ?1, ?2, ?3)
             ON CONFLICT(id) DO NOTHING",
            params![m.conversation_id, created_epoch, act_id],
        )
        .map_err(|e| format!("Failed to ensure v2 parent conversation: {}", e))?;

        conn.execute(
            "INSERT INTO messages
             (id, conversation_id, sender_id, content, created_at, delivery_status, client_message_id,
              edited_at, deleted_at, delivered_at, read_at, is_mine, account_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
                 content = CASE
                     WHEN messages.deleted_at IS NOT NULL THEN messages.content
                     WHEN excluded.deleted_at IS NOT NULL THEN '[Mensagem apagada]'
                     ELSE excluded.content
                 END,
                 edited_at = COALESCE(excluded.edited_at, messages.edited_at),
                 deleted_at = COALESCE(messages.deleted_at, excluded.deleted_at),
                 delivered_at = COALESCE(messages.delivered_at, excluded.delivered_at),
                 read_at = COALESCE(messages.read_at, excluded.read_at)
             WHERE messages.account_id = ?13",
            params![
                m.id,
                m.conversation_id,
                m.sender_id,
                m.content,
                created_epoch,
                status,
                client_msg_opt,
                m.edited_at,
                m.deleted_at,
                m.delivered_at,
                m.read_at,
                is_mine_int,
                act_id,
            ],
        )
        .map_err(|e| format!("Failed to upsert v2 message cache: {}", e))?;
    }

    Ok(())
}

pub fn load_cached_messages_for_account(
    state: &DbState,
    act_id: &str,
    conversation_id: &str,
    limit: i64,
) -> Result<Vec<DirectMessageDto>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let schema_ver = DbState::query_schema_version(&conn)?;

    let mut cached = Vec::new();
    if schema_ver >= 3 {
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, sender_id, content, created_at, created_at_iso,
                        delivery_status, client_message_id, edited_at, deleted_at, delivered_at, read_at, is_mine
                 FROM messages
                 WHERE account_id = ?1 AND conversation_id = ?2
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![act_id, conversation_id, limit], |r| {
                let epoch: i64 = r.get(4)?;
                let iso_opt: Option<String> = r.get(5).ok().flatten();
                let created_at = iso_opt
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| epoch_secs_to_iso8601(epoch));
                let status: String = r.get(6).unwrap_or_else(|_| "sent".to_string());
                Ok(DirectMessageDto {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    sender_id: r.get(2)?,
                    content: r.get(3)?,
                    created_at,
                    client_message_id: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
                    edited_at: get_optional_text_or_int(r, 8),
                    deleted_at: get_optional_text_or_int(r, 9),
                    delivered_at: get_optional_text_or_int(r, 10),
                    read_at: get_optional_text_or_int(r, 11),
                    is_mine: r.get::<_, i64>(12).map(|v| v != 0).unwrap_or(true),
                    delivery_status: Some(status),
                })
            })
            .map_err(|e| e.to_string())?;

        for r in rows {
            if let Ok(m) = r {
                cached.push(m);
            }
        }
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, sender_id, content, created_at, delivery_status,
                        client_message_id, edited_at, deleted_at, delivered_at, read_at, is_mine
                 FROM messages
                 WHERE conversation_id = ?1 AND account_id = ?2
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![conversation_id, act_id, limit], |r| {
                let epoch: i64 = r.get(4)?;
                let status: String = r.get(5).unwrap_or_else(|_| "sent".to_string());
                Ok(DirectMessageDto {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    sender_id: r.get(2)?,
                    content: r.get(3)?,
                    created_at: epoch_secs_to_iso8601(epoch),
                    client_message_id: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    edited_at: get_optional_text_or_int(r, 7),
                    deleted_at: get_optional_text_or_int(r, 8),
                    delivered_at: get_optional_text_or_int(r, 9),
                    read_at: get_optional_text_or_int(r, 10),
                    is_mine: r.get::<_, i64>(11).map(|v| v != 0).unwrap_or(true),
                    delivery_status: Some(status),
                })
            })
            .map_err(|e| e.to_string())?;

        for r in rows {
            if let Ok(m) = r {
                cached.push(m);
            }
        }
    }

    cached.reverse();
    Ok(cached)
}

pub fn load_cached_conversations_for_account(
    state: &DbState,
    act_id: &str,
) -> Result<Vec<DirectConversationDto>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let schema_ver = DbState::query_schema_version(&conn)?;

    let mut convs = Vec::new();
    if schema_ver >= 3 {
        let mut stmt = conn
            .prepare(
                "SELECT id, title, updated_at, created_at_iso, updated_at_iso, other_user_json, unread_count
                 FROM conversations
                 WHERE account_id = ?1 AND type = 'dm'
                 ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![act_id], |r| {
                let id: String = r.get(0)?;
                let title: String = r.get(1)?;
                let updated_epoch: i64 = r.get(2)?;
                let created_iso: Option<String> = r.get(3).ok().flatten();
                let updated_iso: Option<String> = r.get(4).ok().flatten();
                let other_json: Option<String> = r.get(5).ok().flatten();
                let unread_count: i64 = r.get(6).unwrap_or(0);
                Ok((
                    id,
                    title,
                    updated_epoch,
                    created_iso,
                    updated_iso,
                    other_json,
                    unread_count,
                ))
            })
            .map_err(|e| e.to_string())?;

        for row in rows {
            let (id, title, updated_epoch, created_iso, updated_iso, other_json, unread_count) =
                row.map_err(|e| e.to_string())?;
            let other_user = other_json
                .as_deref()
                .and_then(|j| serde_json::from_str::<FriendSummaryDto>(j).ok())
                .unwrap_or(FriendSummaryDto {
                    id: id.clone(),
                    username: title.to_lowercase().replace(' ', "_"),
                    tag: "0000".to_string(),
                    display_name: title,
                    avatar_url: None,
                    bio: None,
                    status: "offline".to_string(),
                    custom_status: None,
                    activity: None,
                    last_seen_at: None,
                });

            let fallback_iso = epoch_secs_to_iso8601(updated_epoch);
            convs.push(DirectConversationDto {
                id,
                other_user,
                last_message: None,
                unread_count,
                created_at: created_iso.unwrap_or_else(|| fallback_iso.clone()),
                updated_at: updated_iso.unwrap_or(fallback_iso),
            });
        }
    }

    drop(conn);
    for c in &mut convs {
        if let Ok(msgs) = load_cached_messages_for_account(state, act_id, &c.id, 1) {
            c.last_message = msgs.into_iter().last();
        }
    }

    Ok(convs)
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
    let act_id = resolve_and_validate_account_id(account_id.as_deref(), false)?;
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/dm/conversations", get_api_base());

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

            if let Ok(conn) = state.conn.lock() {
                for c in &convs {
                    let _ = upsert_cached_conversation(&conn, &act_id, c);
                    if let Some(ref m) = c.last_message {
                        let _ = upsert_cached_message(&conn, &act_id, m, "sent");
                    }
                }
            }

            Ok(convs)
        }
        _ => load_cached_conversations_for_account(&state, &act_id),
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
    let act_id = resolve_and_validate_account_id(account_id.as_deref(), false)?;
    let valid_target_id = match target_user_id {
        Some(ref tid) if !tid.trim().is_empty() => Some(validate_uuid(tid, "target_user_id")?),
        _ => None,
    };

    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/dm/conversations", get_api_base());

    let payload = serde_json::json!({
        "target_user_id": valid_target_id,
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

        if let Ok(conn) = state.conn.lock() {
            let _ = upsert_cached_conversation(&conn, &act_id, &conv);
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
    let valid_conv_id = validate_uuid(&conversation_id, "conversation_id")?;
    let valid_before_id = match before_id {
        Some(ref bid) if !bid.trim().is_empty() => Some(validate_uuid(bid, "before_id")?),
        _ => None,
    };
    let act_id = resolve_and_validate_account_id(account_id.as_deref(), false)?;
    let token = require_token()?;
    let client = http_client();
    let limit_val = limit.unwrap_or(50).clamp(1, 100);

    let mut url = format!(
        "{}/v1/dm/conversations/{}/messages?limit={}",
        get_api_base(),
        valid_conv_id,
        limit_val
    );
    if let Some(b_id) = valid_before_id {
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

            if let Ok(conn) = state.conn.lock() {
                for m in &messages {
                    let _ = upsert_cached_message(&conn, &act_id, m, "sent");
                }
            }

            Ok(messages)
        }
        _ => load_cached_messages_for_account(&state, &act_id, &valid_conv_id, limit_val),
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
    let valid_conv_id = validate_uuid(&conversation_id, "conversation_id")?;
    let clean = content.trim();
    if clean.is_empty() {
        return Err("A mensagem não pode estar vazia.".to_string());
    }
    if clean.chars().count() > 2000 {
        return Err("A mensagem não pode ter mais de 2000 caracteres.".to_string());
    }

    let act_id = resolve_and_validate_account_id(account_id.as_deref(), false)?;
    let token = require_token()?;
    let client_msg_id = match client_message_id {
        Some(ref id) if !id.trim().is_empty() => {
            Uuid::parse_str(id.trim()).map_err(|_| "client_message_id inválido.".to_string())?
        }
        _ => Uuid::new_v4(),
    };

    let client = http_client();
    let url = format!(
        "{}/v1/dm/conversations/{}/messages",
        get_api_base(),
        valid_conv_id
    );

    let payload = serde_json::json!({
        "client_message_id": client_msg_id,
        "content": clean,
    });

    // 1. Optimistic insert in SQLite with 'sending' status, strictly scoped to `act_id`
    let now = now_epoch_secs();
    let now_iso = epoch_secs_to_iso8601(now);
    let temp_id = format!("local_{}", client_msg_id);

    if let Ok(conn) = state.conn.lock() {
        let optimistic = DirectMessageDto {
            id: temp_id.clone(),
            conversation_id: valid_conv_id.clone(),
            sender_id: act_id.clone(),
            client_message_id: client_msg_id.to_string(),
            content: clean.to_string(),
            created_at: now_iso,
            edited_at: None,
            deleted_at: None,
            delivered_at: None,
            read_at: None,
            is_mine: true,
            delivery_status: Some("sending".to_string()),
        };
        let _ = upsert_cached_message(&conn, &act_id, &optimistic, "sending");
    }

    // 2. Perform HTTP POST
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            if let Ok(conn) = state.conn.lock() {
                let _ = conn.execute(
                    "UPDATE messages SET delivery_status = 'failed'
                     WHERE account_id = ?1 AND client_message_id = ?2 AND delivery_status = 'sending'",
                    params![act_id, client_msg_id.to_string()],
                );
            }
            format!("Falha de conexão ao enviar mensagem: {}", e)
        })?;

    if resp.status().is_success() {
        let sent_dto = resp
            .json::<DirectMessageDto>()
            .await
            .map_err(|e| format!("Falha ao decodificar mensagem enviada: {}", e))?;

        if let Ok(conn) = state.conn.lock() {
            let _ = upsert_cached_message(&conn, &act_id, &sent_dto, "sent");
        }

        Ok(sent_dto)
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao enviar mensagem.".to_string())?;

        if let Ok(conn) = state.conn.lock() {
            let _ = conn.execute(
                "UPDATE messages SET delivery_status = 'failed'
                 WHERE account_id = ?1 AND client_message_id = ?2 AND delivery_status = 'sending'",
                params![act_id, client_msg_id.to_string()],
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
    account_id: Option<String>,
) -> Result<DirectMessageDto, String> {
    let valid_msg_id = validate_uuid(&message_id, "message_id")?;
    let clean = content.trim();
    if clean.is_empty() {
        return Err("A mensagem não pode ficar vazia.".to_string());
    }
    if clean.chars().count() > 2000 {
        return Err("A mensagem não pode ter mais de 2000 caracteres.".to_string());
    }

    let act_id = resolve_and_validate_account_id(account_id.as_deref(), false).ok();
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/dm/messages/{}", get_api_base(), valid_msg_id);

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

        if let Ok(conn) = state.conn.lock() {
            let target_acc = act_id.unwrap_or_else(|| edited.sender_id.clone());
            let _ = upsert_cached_message(&conn, &target_acc, &edited, "sent");
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
    account_id: Option<String>,
) -> Result<DirectMessageDto, String> {
    let valid_msg_id = validate_uuid(&message_id, "message_id")?;
    let act_id = resolve_and_validate_account_id(account_id.as_deref(), false).ok();
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/dm/messages/{}", get_api_base(), valid_msg_id);

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

        if let Ok(conn) = state.conn.lock() {
            let target_acc = act_id.unwrap_or_else(|| deleted.sender_id.clone());
            let _ = upsert_cached_message(&conn, &target_acc, &deleted, "sent");
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
    account_id: Option<String>,
) -> Result<(), String> {
    let valid_conv_id = validate_uuid(&conversation_id, "conversation_id")?;
    let valid_last_read = match last_read_message_id {
        Some(ref mid) if !mid.trim().is_empty() => {
            Some(validate_uuid(mid, "last_read_message_id")?)
        }
        _ => None,
    };
    let act_id = resolve_and_validate_account_id(account_id.as_deref(), true)?;

    let token = require_token()?;
    let client = http_client();
    let url = format!(
        "{}/v1/dm/conversations/{}/read",
        get_api_base(),
        valid_conv_id
    );

    let payload = serde_json::json!({
        "last_read_message_id": valid_last_read,
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão ao marcar lido: {}", e))?;

    if resp.status().is_success() {
        if let Some(ref mid) = valid_last_read {
            let _ = crate::commands::mark_conversation_read_for_account(
                &state,
                &valid_conv_id,
                mid,
                Some(&act_id),
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

pub fn cache_incoming_message_for_account(
    state: &DbState,
    message: &DirectMessageDto,
    account_id: Option<&str>,
) -> Result<(), String> {
    let act_id = resolve_and_validate_account_id(account_id, false)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    let mut msg = message.clone();
    if msg.delivered_at.is_none() && !msg.is_mine {
        msg.delivered_at = Some(epoch_secs_to_iso8601(now_epoch_secs()));
    }
    upsert_cached_message(&conn, &act_id, &msg, "delivered")?;

    let msg_epoch = parse_iso8601_to_epoch_secs(&msg.created_at).unwrap_or_else(now_epoch_secs);
    let _ = conn.execute(
        "UPDATE conversations
         SET updated_at = MAX(updated_at, ?1), updated_at_iso = ?2
         WHERE account_id = ?3 AND id = ?4",
        params![msg_epoch, msg.created_at, act_id, msg.conversation_id],
    );

    Ok(())
}

/// Caches an incoming real-time Gateway message into local SQLite
#[tauri::command]
pub fn dm_cache_incoming_message(
    state: State<'_, DbState>,
    message: DirectMessageDto,
    account_id: Option<String>,
) -> Result<(), String> {
    cache_incoming_message_for_account(&state, &message, account_id.as_deref())
}
