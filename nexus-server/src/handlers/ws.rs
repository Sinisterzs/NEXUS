use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::{mpsc, Notify};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::models::{GatewayClientMessage, GatewayEvent};
use crate::services::presence::{
    ClientConnection, GATEWAY_CRITICAL_QUEUE_CAPACITY, GATEWAY_EPHEMERAL_QUEUE_CAPACITY,
};
use crate::services::{AuthService, CallService, DmService, FriendService};

pub const GATEWAY_AUTH_TIMEOUT_SECS: u64 = 5;
pub const GATEWAY_SEND_TIMEOUT_SECS: u64 = 10;
pub const MAX_FRAME_SIZE: usize = 65536;
pub const MAX_CONTROL_MSGS_PER_SEC: u32 = 40;
pub const MAX_ICE_CANDIDATES_PER_SEC: u32 = 120;
pub const MAX_TOTAL_FRAMES_PER_SEC: u32 = 160;

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
    State(state): State<WsState>,
) -> impl IntoResponse {
    // 1. Check if token was passed in Authorization header (never via URL query string to prevent log leaks)
    let handshake_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| {
            if h.starts_with("Bearer ") {
                Some(h.trim_start_matches("Bearer ").trim().to_string())
            } else {
                None
            }
        });

    // 2. Enforce protocol-level frame and message size limits and upgrade socket
    ws.max_frame_size(MAX_FRAME_SIZE)
        .max_message_size(MAX_FRAME_SIZE)
        .on_upgrade(move |socket| handle_gateway_socket(socket, handshake_token, state))
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
    let presence_mgr = friend_service.presence_manager().clone();

    // 1. Initial Authentication Step:
    // If token wasn't provided in handshake, wait for an "authenticate" frame within 5 seconds.
    let (session_id, user_profile) = if let Some(token) = handshake_token {
        match auth_service.validate_token_and_get_session(&token).await {
            Ok((sid, user)) => (Some(sid), user),
            Err(_) => {
                let err_event = GatewayEvent::new(
                    "error",
                    json!({ "message": "Token de autenticação inválido ou expirado." }),
                );
                let _ = socket
                    .send(Message::Text(
                        serde_json::to_string(&err_event).unwrap_or_default(),
                    ))
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
                    .send(Message::Text(
                        serde_json::to_string(&err_event).unwrap_or_default(),
                    ))
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
                    .send(Message::Text(
                        serde_json::to_string(&err_event).unwrap_or_default(),
                    ))
                    .await;
                let _ = socket.close().await;
                return;
            }
        };

        let client_auth: Result<GatewayClientMessage, _> = serde_json::from_str(&first_msg);
        let user_res = match client_auth {
            Ok(GatewayClientMessage::Authenticate { token, ticket }) => {
                if let Some(t) = ticket {
                    let bound_sid = presence_mgr.take_ticket_session(&t).await;
                    match bound_sid {
                        Some(sid) if auth_service.is_session_active(sid).await => {
                            match dm_service.consume_gateway_ticket(&t).await {
                                Ok(Some(uid)) => auth_service
                                    .get_user_profile(uid)
                                    .await
                                    .map(|u| (Some(sid), u)),
                                _ => Err(crate::errors::AppError::InvalidToken),
                            }
                        }
                        _ => {
                            let _ = dm_service.consume_gateway_ticket(&t).await;
                            Err(crate::errors::AppError::InvalidToken)
                        }
                    }
                } else if let Some(tok) = token {
                    auth_service
                        .validate_token_and_get_session(&tok)
                        .await
                        .map(|(sid, u)| (Some(sid), u))
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
                    .send(Message::Text(
                        serde_json::to_string(&err_event).unwrap_or_default(),
                    ))
                    .await;
                let _ = socket.close().await;
                return;
            }
        };

        match user_res {
            Ok(res) => res,
            Err(_) => {
                let err_event = GatewayEvent::new(
                    "error",
                    json!({ "message": "Sessão inválida ou expirada." }),
                );
                let _ = socket
                    .send(Message::Text(
                        serde_json::to_string(&err_event).unwrap_or_default(),
                    ))
                    .await;
                let _ = socket.close().await;
                return;
            }
        }
    };

    let user_id = user_profile.id;
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (critical_tx, mut critical_rx) =
        mpsc::channel::<GatewayEvent>(GATEWAY_CRITICAL_QUEUE_CAPACITY);
    let (ephemeral_tx, mut ephemeral_rx) =
        mpsc::channel::<GatewayEvent>(GATEWAY_EPHEMERAL_QUEUE_CAPACITY);
    let slow_consumer_disconnect = Arc::new(Notify::new());
    let connection_id = Uuid::new_v4();

    let client_conn = ClientConnection::new(
        connection_id,
        critical_tx,
        ephemeral_tx,
        slow_consumer_disconnect.clone(),
    );

    // 2. Register connection in presence manager
    let (is_first_connection, friend_ids, effective_status) = match presence_mgr
        .register_connection(user_id, connection_id, client_conn.clone())
        .await
    {
        Ok(res) => res,
        Err(err_msg) => {
            let err_event = GatewayEvent::new("error", json!({ "message": err_msg }));
            let _ = ws_sender
                .send(Message::Text(
                    serde_json::to_string(&err_event).unwrap_or_default(),
                ))
                .await;
            let _ = ws_sender.close().await;
            return;
        }
    };

    if let Some(sid) = session_id {
        presence_mgr
            .bind_connection_to_session(connection_id, sid)
            .await;
    }

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
    client_conn.try_enqueue(user_id, ready_event);

    // 5. Spawn outgoing writer task with priority scheduling and slow-consumer protection
    let send_slow_notify = slow_consumer_disconnect.clone();
    let mut send_task = tokio::spawn(async move {
        loop {
            let next_event = tokio::select! {
                biased;
                _ = send_slow_notify.notified() => {
                    let slow_err = GatewayEvent::new(
                        "error",
                        json!({
                            "code": "BACKPRESSURE_DISCONNECT",
                            "message": "Conexão encerrada para ressincronização (cliente lento)."
                        }),
                    );
                    if let Ok(json) = serde_json::to_string(&slow_err) {
                        let _ = tokio::time::timeout(
                            Duration::from_millis(500),
                            ws_sender.send(Message::Text(json)),
                        )
                        .await;
                    }
                    let _ = tokio::time::timeout(Duration::from_millis(500), ws_sender.close()).await;
                    break;
                }
                maybe_crit = critical_rx.recv() => {
                    match maybe_crit {
                        Some(ev) => ev,
                        None => break,
                    }
                }
                maybe_eph = ephemeral_rx.recv() => {
                    match maybe_eph {
                        Some(ev) => ev,
                        None => break,
                    }
                }
            };

            let is_session_revoked = next_event.event_type == "session.revoked";
            match serde_json::to_string(&next_event) {
                Ok(json) => {
                    let send_res = tokio::time::timeout(
                        Duration::from_secs(GATEWAY_SEND_TIMEOUT_SECS),
                        ws_sender.send(Message::Text(json)),
                    )
                    .await;
                    if send_res.is_err() || matches!(send_res, Ok(Err(_))) {
                        warn!(
                            "[Gateway] Falha ou timeout ao enviar frame para usuário {} [Conn: {}]. Encerrando.",
                            user_id, connection_id
                        );
                        break;
                    }
                }
                Err(e) => {
                    error!("[Gateway] Falha ao serializar GatewayEvent: {}", e);
                }
            }
            if is_session_revoked {
                let _ = tokio::time::timeout(Duration::from_millis(500), ws_sender.close()).await;
                break;
            }
        }
    });

    // 6. Incoming reader task with separated control/ICE flood protection, session liveness check & message size limit
    let recv_auth_service = auth_service.clone();
    let recv_friend_service = friend_service.clone();
    let recv_dm_service = dm_service.clone();
    let recv_call_service = call_service.clone();
    let recv_conn = client_conn.clone();

    let mut recv_task = tokio::spawn(async move {
        let mut control_msg_count = 0u32;
        let mut ice_msg_count = 0u32;
        let mut total_frame_count = 0u32;
        let mut last_window = tokio::time::Instant::now();

        loop {
            // Heartbeat inactivity timeout: clients send ping every 20s. If no message in 60s, assume dropped.
            let next_msg = tokio::time::timeout(Duration::from_secs(60), ws_receiver.next()).await;

            let msg_result = match next_msg {
                Ok(Some(res)) => res,
                Ok(None) => break, // Socket closed
                Err(_) => {
                    warn!(
                        "[Gateway] Inatividade de conexão excedida (60s) para o usuário {}. Encerrando.",
                        user_id
                    );
                    break;
                }
            };

            // Verify session has not been revoked or expired
            if let Some(sid) = session_id {
                if !recv_auth_service.is_session_active(sid).await {
                    info!(
                        "[Gateway] Sessão {} revogada ou expirada para o usuário {}. Encerrando WebSocket.",
                        sid, user_id
                    );
                    break;
                }
            }

            // Reset 1-second rate-limit window
            if last_window.elapsed() > Duration::from_secs(1) {
                control_msg_count = 0;
                ice_msg_count = 0;
                total_frame_count = 0;
                last_window = tokio::time::Instant::now();
            }
            total_frame_count += 1;
            if total_frame_count > MAX_TOTAL_FRAMES_PER_SEC {
                warn!(
                    "[Gateway] Usuário {} excedeu limite total de frames por segundo ({}). Encerrando.",
                    user_id, total_frame_count
                );
                break;
            }

            match msg_result {
                Ok(Message::Text(text)) => {
                    if text.len() > MAX_FRAME_SIZE {
                        warn!(
                            "[Gateway] Mensagem excedeu tamanho máximo ({} bytes).",
                            text.len()
                        );
                        break;
                    }

                    if let Ok(client_msg) = serde_json::from_str::<GatewayClientMessage>(&text) {
                        // Separate trickle ICE candidate burst budget from general control messages
                        if matches!(
                            client_msg,
                            GatewayClientMessage::CallWebrtcIceCandidate { .. }
                        ) {
                            ice_msg_count += 1;
                            if ice_msg_count > MAX_ICE_CANDIDATES_PER_SEC {
                                warn!(
                                    "[Gateway] Rajada de ICE candidates excedeu limite ({}/s) para usuário {}. Descartando excedente sem encerrar chamada.",
                                    ice_msg_count, user_id
                                );
                                continue;
                            }
                        } else {
                            control_msg_count += 1;
                            if control_msg_count > MAX_CONTROL_MSGS_PER_SEC {
                                warn!(
                                    "[Gateway] Usuário {} excedeu limite de mensagens de controle por segundo ({}).",
                                    user_id, control_msg_count
                                );
                                break;
                            }
                        }

                        match client_msg {
                            GatewayClientMessage::Ping => {
                                let pong_event = GatewayEvent::new(
                                    "pong",
                                    json!({ "timestamp": chrono::Utc::now() }),
                                );
                                recv_conn.try_enqueue(user_id, pong_event);
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
                                let _ =
                                    recv_dm_service.mark_delivered(user_id, &message_ids).await;
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
                                if let Err(e) =
                                    recv_call_service.invite(user_id, target_user_id).await
                                {
                                    let err_event = GatewayEvent::new(
                                        "call.error",
                                        json!({ "message": e.to_string() }),
                                    );
                                    recv_conn.try_enqueue(user_id, err_event);
                                }
                            }
                            GatewayClientMessage::CallAccept { call_id } => {
                                if let Err(e) = recv_call_service.accept(user_id, call_id).await {
                                    let err_event = GatewayEvent::new(
                                        "call.error",
                                        json!({ "message": e.to_string() }),
                                    );
                                    recv_conn.try_enqueue(user_id, err_event);
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
                                let _ =
                                    recv_call_service.set_mute(user_id, call_id, is_muted).await;
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
                                    let err_event = GatewayEvent::new(
                                        "call.error",
                                        json!({ "message": e.to_string() }),
                                    );
                                    recv_conn.try_enqueue(user_id, err_event);
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
                                    let err_event = GatewayEvent::new(
                                        "call.error",
                                        json!({ "message": e.to_string() }),
                                    );
                                    recv_conn.try_enqueue(user_id, err_event);
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
                    } else {
                        control_msg_count += 1;
                        if control_msg_count > MAX_CONTROL_MSGS_PER_SEC {
                            break;
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
                    debug!(
                        "[Gateway] Conexão encerrada para o usuário {}: {}",
                        user_id, e
                    );
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

    // 8. Unregister connection FIRST; only clean up active calls if this was the user's LAST connection
    let (is_now_offline, friend_ids) = presence_mgr
        .unregister_connection(user_id, connection_id)
        .await;

    if is_now_offline {
        call_service.cleanup_user(user_id).await;

        if !friend_ids.is_empty() {
            info!(
                "[Gateway] Usuário {} desconectou (última conexão). Broadcast offline.",
                user_id
            );
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
}
