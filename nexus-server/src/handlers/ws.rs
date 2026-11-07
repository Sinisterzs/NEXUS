use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::models::{GatewayClientMessage, GatewayEvent};
use crate::services::{AuthService, CallService, DmService, FriendService};

pub const GATEWAY_AUTH_TIMEOUT_SECS: u64 = 5;
pub const MAX_FRAME_SIZE: usize = 65536;

#[derive(Debug, Deserialize)]
pub struct WsAuthParams {
    pub token: Option<String>,
}

#[derive(Clone)]
pub struct WsState {
    pub auth_service: AuthService,
    pub friend_service: FriendService,
    pub dm_service: DmService,
    pub call_service: CallService,
}

/// GET /v1/gateway (and /v1/ws) - Presence & Social Real-Time WebSocket Gateway
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    Query(query): Query<WsAuthParams>,
    State(state): State<WsState>,
) -> impl IntoResponse {
    // 1. Check if token was passed in handshake (optional fallback)
    let handshake_token = query.token.or_else(|| {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|h| {
                if h.starts_with("Bearer ") {
                    Some(h.trim_start_matches("Bearer ").trim().to_string())
                } else {
                    None
                }
            })
    });

    // 2. Upgrade socket immediately without blocking on URL params
    ws.on_upgrade(move |socket| handle_gateway_socket(socket, handshake_token, state))
}

async fn handle_gateway_socket(
    mut socket: WebSocket,
    handshake_token: Option<String>,
    state: WsState,
) {
    let auth_service = state.auth_service.clone();
    let friend_service = state.friend_service.clone();
    let dm_service = state.dm_service.clone();
    let call_service = state.call_service.clone();

    // 1. Initial Authentication Step:
    // If token wasn't provided in handshake, wait for an "authenticate" frame within 5 seconds.
    let user_profile = if let Some(token) = handshake_token {
        match auth_service.validate_token_and_get_user(&token).await {
            Ok(user) => user,
            Err(_) => {
                let err_event = GatewayEvent::new(
                    "error",
                    json!({ "message": "Token de autenticação inválido ou expirado." }),
                );
                let _ = socket
                    .send(Message::Text(serde_json::to_string(&err_event).unwrap_or_default()))
                    .await;
                let _ = socket.close().await;
                return;
            }
        }
    } else {
        // Wait for first message with short timeout
        let auth_res = tokio::time::timeout(
            Duration::from_secs(GATEWAY_AUTH_TIMEOUT_SECS),
            socket.next(),
        )
        .await;

        let first_msg = match auth_res {
            Ok(Some(Ok(Message::Text(text)))) => text,
            Ok(Some(Ok(_))) => {
                let err_event = GatewayEvent::new(
                    "error",
                    json!({ "message": "Formato de autenticação inválido. Esperado frame de texto JSON." }),
                );
                let _ = socket
                    .send(Message::Text(serde_json::to_string(&err_event).unwrap_or_default()))
                    .await;
                let _ = socket.close().await;
                return;
            }
            _ => {
                warn!("[Gateway] Timeout de autenticação atingido (5s). Fechando conexão.");
                let err_event = GatewayEvent::new(
                    "error",
                    json!({ "message": "Autenticação necessária dentro de 5 segundos." }),
                );
                let _ = socket
                    .send(Message::Text(serde_json::to_string(&err_event).unwrap_or_default()))
                    .await;
                let _ = socket.close().await;
                return;
            }
        };

        let client_auth: Result<GatewayClientMessage, _> = serde_json::from_str(&first_msg);
        let user_res = match client_auth {
            Ok(GatewayClientMessage::Authenticate { token, ticket }) => {
                if let Some(t) = ticket {
                    match dm_service.consume_gateway_ticket(&t).await {
                        Ok(Some(uid)) => auth_service.get_user_profile(uid).await,
                        _ => Err(crate::errors::AppError::InvalidToken),
                    }
                } else if let Some(tok) = token {
                    auth_service.validate_token_and_get_user(&tok).await
                } else {
                    Err(crate::errors::AppError::InvalidToken)
                }
            }
            _ => {
                let err_event = GatewayEvent::new(
                    "error",
                    json!({ "message": "Primeira mensagem deve ser 'op': 'authenticate'." }),
                );
                let _ = socket
                    .send(Message::Text(serde_json::to_string(&err_event).unwrap_or_default()))
                    .await;
                let _ = socket.close().await;
                return;
            }
        };

        match user_res {
            Ok(user) => user,
            Err(_) => {
                let err_event = GatewayEvent::new(
                    "error",
                    json!({ "message": "Sessão inválida ou expirada." }),
                );
                let _ = socket
                    .send(Message::Text(serde_json::to_string(&err_event).unwrap_or_default()))
                    .await;
                let _ = socket.close().await;
                return;
            }
        }
    };

    let user_id = user_profile.id;
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<GatewayEvent>();
    let connection_id = Uuid::new_v4();
    let presence_mgr = friend_service.presence_manager().clone();

    // 2. Register connection in presence manager
    let (is_first_connection, friend_ids, effective_status) = match presence_mgr
        .register_connection(user_id, connection_id, tx.clone())
        .await
    {
        Ok(res) => res,
        Err(err_msg) => {
            let err_event = GatewayEvent::new("error", json!({ "message": err_msg }));
            let _ = ws_sender
                .send(Message::Text(serde_json::to_string(&err_event).unwrap_or_default()))
                .await;
            return;
        }
    };

    info!(
        "[Gateway] Usuário autenticado conectado: {} ({}) [Conn: {}]",
        user_profile.username, user_id, connection_id
    );

    // 3. If first connection and not invisible, broadcast presence.updated to friends
    if is_first_connection && effective_status != "offline" {
        let presence_event = GatewayEvent::new(
            "presence.updated",
            json!({
                "user_id": user_id,
                "status": effective_status,
                "custom_status": serde_json::Value::Null,
                "activity": serde_json::Value::Null,
                "last_seen_at": chrono::Utc::now(),
            }),
        );
        presence_mgr
            .broadcast_to_friends(&friend_ids, &presence_event)
            .await;
    }

    // 4. Send connection.ready event with current friend list and presence
    let friends = friend_service.get_friends(user_id).await.unwrap_or_default();
    let presence_data = friend_service.get_presence(user_id).await.ok();

    let ready_event = GatewayEvent::new(
        "connection.ready",
        json!({
            "user_id": user_id,
            "session": {
                "connection_id": connection_id,
                "status": effective_status,
                "presence": presence_data,
            },
            "friends": friends,
        }),
    );
    let _ = tx.send(ready_event);

    // 5. Spawn outgoing writer task
    let mut send_task = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match serde_json::to_string(&event) {
                Ok(json) => {
                    if ws_sender.send(Message::Text(json)).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    error!("[Gateway] Falha ao serializar GatewayEvent: {}", e);
                }
            }
        }
    });

    // 6. Incoming reader task with flood protection & message size limit
    let recv_friend_service = friend_service.clone();
    let recv_dm_service = dm_service.clone();
    let recv_call_service = call_service.clone();
    let recv_tx = tx.clone();

    let mut recv_task = tokio::spawn(async move {
        let mut msg_count = 0u32;
        let mut last_window = tokio::time::Instant::now();

        while let Some(msg_result) = ws_receiver.next().await {
            // Flood protection: max 30 msgs per second
            if last_window.elapsed() > Duration::from_secs(1) {
                msg_count = 0;
                last_window = tokio::time::Instant::now();
            }
            msg_count += 1;
            if msg_count > 30 {
                warn!("[Gateway] Usuário {} excedeu limite de mensagens por segundo.", user_id);
                break;
            }

            match msg_result {
                Ok(Message::Text(text)) => {
                    if text.len() > MAX_FRAME_SIZE {
                        warn!("[Gateway] Mensagem excedeu tamanho máximo ({} bytes).", text.len());
                        break;
                    }

                    if let Ok(client_msg) = serde_json::from_str::<GatewayClientMessage>(&text) {
                        match client_msg {
                            GatewayClientMessage::Ping => {
                                let pong_event = GatewayEvent::new("pong", json!({ "timestamp": chrono::Utc::now() }));
                                let _ = recv_tx.send(pong_event);
                            }
                            GatewayClientMessage::SetPresence {
                                status,
                                custom_status,
                                activity,
                            } => {
                                let _ = recv_friend_service
                                    .update_presence(
                                        user_id,
                                        Some(&status),
                                        custom_status.as_deref(),
                                        activity.as_deref(),
                                        None,
                                    )
                                    .await;
                            }
                            GatewayClientMessage::DmDeliveryAck { message_ids } => {
                                let _ = recv_dm_service.mark_delivered(user_id, &message_ids).await;
                            }
                            GatewayClientMessage::DmReadAck {
                                conversation_id,
                                last_message_id,
                            } => {
                                let _ = recv_dm_service
                                    .mark_read(conversation_id, user_id, last_message_id)
                                    .await;
                            }
                            GatewayClientMessage::Authenticate { .. } => {
                                // Already authenticated
                            }
                            GatewayClientMessage::CallInvite { target_user_id } => {
                                if let Err(e) = recv_call_service.invite(user_id, target_user_id).await {
                                    let err_event = GatewayEvent::new("call.error", json!({ "message": e.to_string() }));
                                    let _ = recv_tx.send(err_event);
                                }
                            }
                            GatewayClientMessage::CallAccept { call_id } => {
                                if let Err(e) = recv_call_service.accept(user_id, call_id).await {
                                    let err_event = GatewayEvent::new("call.error", json!({ "message": e.to_string() }));
                                    let _ = recv_tx.send(err_event);
                                }
                            }
                            GatewayClientMessage::CallReject { call_id, reason } => {
                                let _ = recv_call_service.reject(user_id, call_id, reason).await;
                            }
                            GatewayClientMessage::CallCancel { call_id } => {
                                let _ = recv_call_service.cancel(user_id, call_id).await;
                            }
                            GatewayClientMessage::CallEnd { call_id } => {
                                let _ = recv_call_service.end(user_id, call_id).await;
                            }
                            GatewayClientMessage::CallMute { call_id, is_muted } => {
                                let _ = recv_call_service.set_mute(user_id, call_id, is_muted).await;
                            }
                            GatewayClientMessage::CallWebrtcOffer {
                                call_id,
                                target_user_id,
                                sdp,
                            } => {
                                if let Err(e) = recv_call_service
                                    .relay_sdp(user_id, call_id, target_user_id, "offer", sdp)
                                    .await
                                {
                                    let err_event = GatewayEvent::new("call.error", json!({ "message": e.to_string() }));
                                    let _ = recv_tx.send(err_event);
                                }
                            }
                            GatewayClientMessage::CallWebrtcAnswer {
                                call_id,
                                target_user_id,
                                sdp,
                            } => {
                                if let Err(e) = recv_call_service
                                    .relay_sdp(user_id, call_id, target_user_id, "answer", sdp)
                                    .await
                                {
                                    let err_event = GatewayEvent::new("call.error", json!({ "message": e.to_string() }));
                                    let _ = recv_tx.send(err_event);
                                }
                            }
                            GatewayClientMessage::CallWebrtcIceCandidate {
                                call_id,
                                target_user_id,
                                candidate,
                            } => {
                                let _ = recv_call_service
                                    .relay_ice(user_id, call_id, target_user_id, candidate)
                                    .await;
                            }
                        }
                    }
                }
                Ok(Message::Ping(_)) => {
                    // Axum automatically replies with Pong frame
                }
                Ok(Message::Close(_)) => {
                    break;
                }
                Err(e) => {
                    debug!("[Gateway] Conexão encerrada para o usuário {}: {}", user_id, e);
                    break;
                }
                _ => {}
            }
        }
    });

    // 7. Wait for either loop to complete
    tokio::select! {
        res = (&mut send_task) => {
            warn!("[Gateway] send_task terminou para o usuário {}: {:?}", user_id, res);
            recv_task.abort();
        }
        res = (&mut recv_task) => {
            warn!("[Gateway] recv_task terminou para o usuário {}: {:?}", user_id, res);
            send_task.abort();
        }
    };

    // 8. Connection termination & call/presence cleanup
    call_service.cleanup_user(user_id).await;

    let (is_now_offline, friend_ids) = presence_mgr
        .unregister_connection(user_id, connection_id)
        .await;

    if is_now_offline && !friend_ids.is_empty() {
        info!("[Gateway] Usuário {} desconectou (última conexão). Broadcast offline.", user_id);
        let offline_event = GatewayEvent::new(
            "presence.updated",
            json!({
                "user_id": user_id,
                "status": "offline",
                "custom_status": serde_json::Value::Null,
                "activity": serde_json::Value::Null,
                "last_seen_at": chrono::Utc::now(),
            }),
        );
        presence_mgr
            .broadcast_to_friends(&friend_ids, &offline_event)
            .await;
    }
}
