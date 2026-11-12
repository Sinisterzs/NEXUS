use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde_json::json;
use tokio::sync::RwLock;
use tokio::task::AbortHandle;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::{CallSession, CallStatus, GatewayEvent};
use crate::repositories::FriendRepository;
use crate::services::{AuthService, PresenceManager};

pub const CALL_RINGING_TIMEOUT_SECS: u64 = 45;

#[derive(Default)]
struct CallState {
    calls: HashMap<Uuid, CallSession>,
    user_active_calls: HashMap<Uuid, Uuid>,
    ringing_timers: HashMap<Uuid, AbortHandle>,
}

#[derive(Clone)]
pub struct CallService {
    state: Arc<RwLock<CallState>>,
    ringing_timeout: Duration,
    friend_repo: FriendRepository,
    auth_service: AuthService,
    presence_mgr: PresenceManager,
}

impl CallService {
    pub fn new(
        friend_repo: FriendRepository,
        auth_service: AuthService,
        presence_mgr: PresenceManager,
    ) -> Self {
        Self {
            state: Arc::new(RwLock::new(CallState::default())),
            ringing_timeout: Duration::from_secs(CALL_RINGING_TIMEOUT_SECS),
            friend_repo,
            auth_service,
            presence_mgr,
        }
    }

    pub fn with_ringing_timeout(mut self, timeout: Duration) -> Self {
        self.ringing_timeout = timeout;
        self
    }

    pub async fn active_call_for_user(&self, user_id: Uuid) -> Option<CallSession> {
        let state = self.state.read().await;
        let call_id = state.user_active_calls.get(&user_id)?;
        state.calls.get(call_id).cloned()
    }

    pub async fn active_call_count(&self) -> usize {
        let state = self.state.read().await;
        state.calls.len()
    }

    pub async fn active_timer_count(&self) -> usize {
        let state = self.state.read().await;
        state.ringing_timers.len()
    }

    /// Inicia um convite de chamada 1:1 com um amigo
    pub async fn invite(
        &self,
        caller_id: Uuid,
        callee_id: Uuid,
    ) -> Result<CallSession, AppError> {
        if caller_id == callee_id {
            return Err(AppError::BadRequest(
                "Não é possível chamar a si mesmo.".to_string(),
            ));
        }

        // 1. Verifica amizade e bloqueios
        let is_friend = self.friend_repo.is_friend(caller_id, callee_id).await?;
        if !is_friend {
            return Err(AppError::Forbidden(
                "Você só pode iniciar chamadas com usuários da sua lista de amigos.".to_string(),
            ));
        }

        let is_blocked = self.friend_repo.is_blocked(caller_id, callee_id).await?
            || self.friend_repo.is_blocked(callee_id, caller_id).await?;
        if is_blocked {
            return Err(AppError::Forbidden(
                "Comunicação não permitida.".to_string(),
            ));
        }

        // 2. Verifica se o destinatário está conectado ao Gateway e carrega perfil do chamador antes do lock
        if !self.presence_mgr.is_user_connected(callee_id).await {
            return Err(AppError::BadRequest(
                "O usuário chamado não está online no momento.".to_string(),
            ));
        }

        let caller_profile = self.auth_service.get_user_profile(caller_id).await?;

        if !self.presence_mgr.is_user_connected(callee_id).await {
            return Err(AppError::BadRequest(
                "O usuário chamado não está online no momento.".to_string(),
            ));
        }

        // 3. Verifica atomicamente disponibilidade de ambos os participantes e registra a sessão + timer
        let call_id = Uuid::new_v4();
        let session = CallSession {
            id: call_id,
            caller_id,
            callee_id,
            status: CallStatus::Ringing,
            caller_muted: false,
            callee_muted: false,
            created_at: Utc::now(),
            started_at: None,
            ended_at: None,
        };

        {
            let mut state = self.state.write().await;
            if state.user_active_calls.contains_key(&caller_id) {
                return Err(AppError::BadRequest(
                    "Você já está em uma chamada ativa ou pendente.".to_string(),
                ));
            }
            if state.user_active_calls.contains_key(&callee_id) {
                return Err(AppError::BadRequest(
                    "O usuário chamado já está ocupado em outra chamada.".to_string(),
                ));
            }

            state.calls.insert(call_id, session.clone());
            state.user_active_calls.insert(caller_id, call_id);
            state.user_active_calls.insert(callee_id, call_id);

            let this = self.clone();
            let timeout_duration = self.ringing_timeout;
            let timer_task = tokio::spawn(async move {
                tokio::time::sleep(timeout_duration).await;
                this.expire_ringing_call(call_id).await;
            });
            state
                .ringing_timers
                .insert(call_id, timer_task.abort_handle());
        }

        // 4. Notifica o destinatário via WebSocket (call.incoming)
        let incoming_event = GatewayEvent::new(
            "call.incoming",
            json!({
                "call_id": call_id,
                "caller": {
                    "id": caller_profile.id,
                    "username": caller_profile.username,
                    "display_name": caller_profile.display_name,
                    "avatar_url": caller_profile.avatar_url,
                }
            }),
        );
        self.presence_mgr
            .send_to_user(callee_id, &incoming_event)
            .await;

        // Notifica o chamador com confirmação de toque e ID da chamada (call.ringing)
        let ringing_event = GatewayEvent::new(
            "call.ringing",
            json!({
                "call_id": call_id,
                "callee_id": callee_id,
            }),
        );
        self.presence_mgr
            .send_to_user(caller_id, &ringing_event)
            .await;

        info!(
            "[Calls] Chamada 1:1 iniciada com sucesso: {} chamou {} (Call: {})",
            caller_id, callee_id, call_id
        );

        Ok(session)
    }

    async fn expire_ringing_call(&self, call_id: Uuid) {
        let expired_participants = {
            let mut state = self.state.write().await;
            state.ringing_timers.remove(&call_id);

            let is_still_ringing = state
                .calls
                .get(&call_id)
                .map(|c| c.status == CallStatus::Ringing)
                .unwrap_or(false);

            if !is_still_ringing {
                None
            } else if let Some(s) = state.calls.remove(&call_id) {
                if state.user_active_calls.get(&s.caller_id) == Some(&call_id) {
                    state.user_active_calls.remove(&s.caller_id);
                }
                if state.user_active_calls.get(&s.callee_id) == Some(&call_id) {
                    state.user_active_calls.remove(&s.callee_id);
                }
                Some((s.caller_id, s.callee_id))
            } else {
                None
            }
        };

        if let Some((caller_id, callee_id)) = expired_participants {
            debug!(
                "[Calls] Timeout de toque atingido para chamada {}. Cancelando atomicamente.",
                call_id
            );
            let cancel_event = GatewayEvent::new(
                "call.canceled",
                json!({
                    "call_id": call_id,
                }),
            );
            self.presence_mgr
                .send_to_user(callee_id, &cancel_event)
                .await;
            self.presence_mgr
                .send_to_user(caller_id, &cancel_event)
                .await;
        }
    }

    /// Aceita um convite de chamada recebido
    pub async fn accept(&self, user_id: Uuid, call_id: Uuid) -> Result<CallSession, AppError> {
        let session = {
            let mut state = self.state.write().await;
            let s = state.calls.get_mut(&call_id).ok_or_else(|| {
                AppError::NotFound("Chamada não encontrada ou já encerrada.".to_string())
            })?;

            if s.callee_id != user_id {
                return Err(AppError::Forbidden(
                    "Apenas o destinatário convidado pode aceitar esta chamada.".to_string(),
                ));
            }

            if s.status != CallStatus::Ringing {
                return Err(AppError::BadRequest(
                    "A chamada não está mais no estado de toque.".to_string(),
                ));
            }

            s.status = CallStatus::Active;
            s.started_at = Some(Utc::now());
            let cloned = s.clone();

            if let Some(timer) = state.ringing_timers.remove(&call_id) {
                timer.abort();
            }

            cloned
        };

        // Notifica o chamador que a chamada foi aceita (call.accepted)
        let accepted_event = GatewayEvent::new(
            "call.accepted",
            json!({
                "call_id": call_id,
                "peer_id": user_id,
            }),
        );
        self.presence_mgr
            .send_to_user(session.caller_id, &accepted_event)
            .await;

        // Notifica quaisquer outras conexões do callee que a chamada foi atendida nesta sessão
        let callee_dismiss_event = GatewayEvent::new(
            "call.accepted_by_user",
            json!({
                "call_id": call_id,
            }),
        );
        self.presence_mgr
            .send_to_user(user_id, &callee_dismiss_event)
            .await;

        info!(
            "[Calls] Chamada {} aceita por {}. Sessão ativa.",
            call_id, user_id
        );

        Ok(session)
    }

    /// Recusa uma chamada recebida
    pub async fn reject(
        &self,
        user_id: Uuid,
        call_id: Uuid,
        reason: Option<String>,
    ) -> Result<(), AppError> {
        let caller_id = {
            let mut state = self.state.write().await;
            let s = state
                .calls
                .get(&call_id)
                .ok_or_else(|| AppError::NotFound("Chamada não encontrada.".to_string()))?;

            if s.callee_id != user_id {
                return Err(AppError::Forbidden(
                    "Apenas o destinatário pode recusar a chamada.".to_string(),
                ));
            }

            if s.status != CallStatus::Ringing {
                return Err(AppError::BadRequest(
                    "A chamada já foi atendida ou encerrada e não pode ser recusada.".to_string(),
                ));
            }

            let caller_id = s.caller_id;
            state.calls.remove(&call_id);
            if let Some(timer) = state.ringing_timers.remove(&call_id) {
                timer.abort();
            }
            if state.user_active_calls.get(&caller_id) == Some(&call_id) {
                state.user_active_calls.remove(&caller_id);
            }
            if state.user_active_calls.get(&user_id) == Some(&call_id) {
                state.user_active_calls.remove(&user_id);
            }
            caller_id
        };

        // Notifica o chamador que a chamada foi recusada (call.rejected)
        let reject_event = GatewayEvent::new(
            "call.rejected",
            json!({
                "call_id": call_id,
                "reason": reason.unwrap_or_else(|| "Chamada recusada.".to_string()),
            }),
        );
        self.presence_mgr
            .send_to_user(caller_id, &reject_event)
            .await;

        info!("[Calls] Chamada {} recusada por {}.", call_id, user_id);
        Ok(())
    }

    /// Cancela uma chamada que ainda está tocando
    pub async fn cancel(&self, user_id: Uuid, call_id: Uuid) -> Result<(), AppError> {
        let callee_id = {
            let mut state = self.state.write().await;
            let s = state
                .calls
                .get(&call_id)
                .ok_or_else(|| AppError::NotFound("Chamada não encontrada.".to_string()))?;

            if s.caller_id != user_id {
                return Err(AppError::Forbidden(
                    "Apenas o originador pode cancelar a chamada pendente.".to_string(),
                ));
            }

            if s.status != CallStatus::Ringing {
                return Err(AppError::BadRequest(
                    "A chamada já foi atendida ou encerrada e não pode ser cancelada.".to_string(),
                ));
            }

            let callee_id = s.callee_id;
            state.calls.remove(&call_id);
            if let Some(timer) = state.ringing_timers.remove(&call_id) {
                timer.abort();
            }
            if state.user_active_calls.get(&user_id) == Some(&call_id) {
                state.user_active_calls.remove(&user_id);
            }
            if state.user_active_calls.get(&callee_id) == Some(&call_id) {
                state.user_active_calls.remove(&callee_id);
            }
            callee_id
        };

        // Notifica ambos participantes que a chamada foi cancelada/expirada (call.canceled)
        let cancel_event = GatewayEvent::new(
            "call.canceled",
            json!({
                "call_id": call_id,
            }),
        );
        self.presence_mgr
            .send_to_user(callee_id, &cancel_event)
            .await;
        self.presence_mgr
            .send_to_user(user_id, &cancel_event)
            .await;

        info!(
            "[Calls] Chamada {} cancelada por {}. Ambos participantes notificados.",
            call_id, user_id
        );
        Ok(())
    }

    /// Encerra uma chamada ativa
    pub async fn end(&self, user_id: Uuid, call_id: Uuid) -> Result<(), AppError> {
        let peer_id = {
            let mut state = self.state.write().await;
            let s = state
                .calls
                .get(&call_id)
                .ok_or_else(|| AppError::NotFound("Chamada não encontrada.".to_string()))?;

            if s.caller_id != user_id && s.callee_id != user_id {
                return Err(AppError::Forbidden(
                    "Você não faz parte desta chamada.".to_string(),
                ));
            }

            let peer_id = if s.caller_id == user_id {
                s.callee_id
            } else {
                s.caller_id
            };

            state.calls.remove(&call_id);
            if let Some(timer) = state.ringing_timers.remove(&call_id) {
                timer.abort();
            }
            if state.user_active_calls.get(&user_id) == Some(&call_id) {
                state.user_active_calls.remove(&user_id);
            }
            if state.user_active_calls.get(&peer_id) == Some(&call_id) {
                state.user_active_calls.remove(&peer_id);
            }
            peer_id
        };

        // Notifica o outro participante que a chamada encerrou (call.ended)
        let end_event = GatewayEvent::new(
            "call.ended",
            json!({
                "call_id": call_id,
                "reason": "Chamada encerrada pelo participante.",
            }),
        );
        self.presence_mgr.send_to_user(peer_id, &end_event).await;

        info!("[Calls] Chamada {} encerrada por {}.", call_id, user_id);
        Ok(())
    }

    /// Atualiza estado de mudo do microfone e propaga para o peer
    pub async fn set_mute(
        &self,
        user_id: Uuid,
        call_id: Uuid,
        is_muted: bool,
    ) -> Result<(), AppError> {
        let peer_id = {
            let mut state = self.state.write().await;
            let s = state
                .calls
                .get_mut(&call_id)
                .ok_or_else(|| AppError::NotFound("Chamada não encontrada.".to_string()))?;

            if s.status == CallStatus::Ended {
                return Err(AppError::BadRequest(
                    "A chamada já foi encerrada.".to_string(),
                ));
            }

            if s.caller_id == user_id {
                s.caller_muted = is_muted;
                s.callee_id
            } else if s.callee_id == user_id {
                s.callee_muted = is_muted;
                s.caller_id
            } else {
                return Err(AppError::Forbidden(
                    "Você não faz parte desta chamada.".to_string(),
                ));
            }
        };

        let mute_event = GatewayEvent::new(
            "call.participant_muted",
            json!({
                "call_id": call_id,
                "user_id": user_id,
                "is_muted": is_muted,
            }),
        );
        self.presence_mgr.send_to_user(peer_id, &mute_event).await;

        Ok(())
    }

    /// Valida o campo opcional `stream_kind` ("voice" | "screen").
    fn validate_stream_kind(stream_kind: Option<&str>) -> Result<(), AppError> {
        if let Some(kind) = stream_kind {
            if kind != "voice" && kind != "screen" {
                return Err(AppError::BadRequest(
                    "stream_kind inválido. Valores permitidos: \"voice\" ou \"screen\"."
                        .to_string(),
                ));
            }
        }
        Ok(())
    }

    /// Encaminha SDP (Offer ou Answer) para o peer correspondente
    pub async fn relay_sdp(
        &self,
        user_id: Uuid,
        call_id: Uuid,
        target_user_id: Uuid,
        sdp_type: &str, // "offer" ou "answer"
        sdp: String,
    ) -> Result<(), AppError> {
        self.relay_sdp_with_stream_kind(user_id, call_id, target_user_id, sdp_type, sdp, None)
            .await
    }

    /// Encaminha SDP (Offer ou Answer) para o peer correspondente com `stream_kind` opcional
    pub async fn relay_sdp_with_stream_kind(
        &self,
        user_id: Uuid,
        call_id: Uuid,
        target_user_id: Uuid,
        sdp_type: &str, // "offer" ou "answer"
        sdp: String,
        stream_kind: Option<String>,
    ) -> Result<(), AppError> {
        Self::validate_stream_kind(stream_kind.as_deref())?;

        // Validação de segurança: apenas participantes de uma chamada não encerrada podem trocar SDP
        {
            let state = self.state.read().await;
            let s = state
                .calls
                .get(&call_id)
                .ok_or_else(|| AppError::NotFound("Chamada não encontrada.".to_string()))?;

            if s.status == CallStatus::Ended {
                return Err(AppError::BadRequest(
                    "A chamada já foi encerrada.".to_string(),
                ));
            }

            let is_participant = (s.caller_id == user_id && s.callee_id == target_user_id)
                || (s.callee_id == user_id && s.caller_id == target_user_id);

            if !is_participant {
                return Err(AppError::Forbidden(
                    "Operação de sinalização não autorizada para esta chamada.".to_string(),
                ));
            }
        }

        let event_name = match sdp_type {
            "offer" => "call.webrtc.offer",
            "answer" => "call.webrtc.answer",
            _ => return Err(AppError::BadRequest("Tipo de SDP inválido.".to_string())),
        };

        let sdp_len = sdp.len();
        let mut payload = json!({
            "call_id": call_id,
            "sender_id": user_id,
            "sdp": sdp,
        });
        if let Some(kind) = stream_kind {
            payload["stream_kind"] = json!(kind);
        }
        let sdp_event = GatewayEvent::new(event_name, payload);

        self.presence_mgr
            .send_to_user(target_user_id, &sdp_event)
            .await;

        debug!(
            "[Calls] SDP {} retransmitido ({} -> {}) [Call: {}, {} bytes]",
            sdp_type, user_id, target_user_id, call_id, sdp_len
        );

        Ok(())
    }

    /// Encaminha ICE Candidate para o peer correspondente
    pub async fn relay_ice(
        &self,
        user_id: Uuid,
        call_id: Uuid,
        target_user_id: Uuid,
        candidate: serde_json::Value,
    ) -> Result<(), AppError> {
        self.relay_ice_with_stream_kind(user_id, call_id, target_user_id, candidate, None)
            .await
    }

    /// Encaminha ICE Candidate para o peer correspondente com `stream_kind` opcional
    pub async fn relay_ice_with_stream_kind(
        &self,
        user_id: Uuid,
        call_id: Uuid,
        target_user_id: Uuid,
        candidate: serde_json::Value,
        stream_kind: Option<String>,
    ) -> Result<(), AppError> {
        Self::validate_stream_kind(stream_kind.as_deref())?;

        // Validação de segurança: apenas participantes de uma chamada não encerrada podem trocar ICE
        {
            let state = self.state.read().await;
            let s = state
                .calls
                .get(&call_id)
                .ok_or_else(|| AppError::NotFound("Chamada não encontrada.".to_string()))?;

            if s.status == CallStatus::Ended {
                return Err(AppError::BadRequest(
                    "A chamada já foi encerrada.".to_string(),
                ));
            }

            let is_participant = (s.caller_id == user_id && s.callee_id == target_user_id)
                || (s.callee_id == user_id && s.caller_id == target_user_id);

            if !is_participant {
                return Err(AppError::Forbidden(
                    "Operação de sinalização ICE não autorizada.".to_string(),
                ));
            }
        }

        let mut payload = json!({
            "call_id": call_id,
            "sender_id": user_id,
            "candidate": candidate,
        });
        if let Some(kind) = stream_kind {
            payload["stream_kind"] = json!(kind);
        }
        let ice_event = GatewayEvent::new("call.webrtc.ice_candidate", payload);

        self.presence_mgr
            .send_to_user(target_user_id, &ice_event)
            .await;

        debug!(
            "[Calls] ICE Candidate retransmitido ({} -> {}) [Call: {}]",
            user_id, target_user_id, call_id
        );

        Ok(())
    }

    /// Limpa chamadas órfãs de um usuário somente quando ele não possui mais nenhuma conexão ativa no Gateway
    pub async fn cleanup_user(&self, user_id: Uuid) {
        if self.presence_mgr.is_user_connected(user_id).await {
            debug!(
                "[Calls] Ignorando cleanup_user para {}: usuário ainda possui conexões ativas no Gateway.",
                user_id
            );
            return;
        }

        let cleaned = {
            let mut state = self.state.write().await;
            if let Some(call_id) = state.user_active_calls.remove(&user_id) {
                if let Some(timer) = state.ringing_timers.remove(&call_id) {
                    timer.abort();
                }
                if let Some(s) = state.calls.remove(&call_id) {
                    let peer_id = if s.caller_id == user_id {
                        s.callee_id
                    } else {
                        s.caller_id
                    };
                    if state.user_active_calls.get(&peer_id) == Some(&call_id) {
                        state.user_active_calls.remove(&peer_id);
                    }
                    Some((call_id, peer_id))
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some((call_id, peer_id)) = cleaned {
            warn!(
                "[Calls] Usuário {} desconectou (última conexão) durante chamada {}. Notificando peer {}.",
                user_id, call_id, peer_id
            );
            let end_event = GatewayEvent::new(
                "call.ended",
                json!({
                    "call_id": call_id,
                    "reason": "O participante perdeu a conexão de rede.",
                }),
            );
            self.presence_mgr.send_to_user(peer_id, &end_event).await;
        }
    }
}
