use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde_json::json;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::{CallSession, CallStatus, GatewayEvent};
use crate::repositories::FriendRepository;
use crate::services::{AuthService, PresenceManager};

pub const CALL_RINGING_TIMEOUT_SECS: u64 = 45;

#[derive(Clone)]
pub struct CallService {
    calls: Arc<RwLock<HashMap<Uuid, CallSession>>>,
    user_active_calls: Arc<RwLock<HashMap<Uuid, Uuid>>>,
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
            calls: Arc::new(RwLock::new(HashMap::new())),
            user_active_calls: Arc::new(RwLock::new(HashMap::new())),
            friend_repo,
            auth_service,
            presence_mgr,
        }
    }

    /// Inicia um convite de chamada 1:1 com um amigo
    pub async fn invite(
        &self,
        caller_id: Uuid,
        callee_id: Uuid,
    ) -> Result<CallSession, AppError> {
        if caller_id == callee_id {
            return Err(AppError::BadRequest("Não é possível chamar a si mesmo.".to_string()));
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
            return Err(AppError::Forbidden("Comunicação não permitida.".to_string()));
        }

        // 2. Verifica se o destinatário está conectado ao Gateway
        let is_callee_online = self.presence_mgr.is_user_connected(callee_id).await;
        if !is_callee_online {
            return Err(AppError::BadRequest(
                "O usuário chamado não está online no momento.".to_string(),
            ));
        }

        // 3. Verifica se caller ou callee já estão em chamada ativa
        {
            let user_calls = self.user_active_calls.read().await;
            if user_calls.contains_key(&caller_id) {
                return Err(AppError::BadRequest(
                    "Você já está em uma chamada ativa ou pendente.".to_string(),
                ));
            }
            if user_calls.contains_key(&callee_id) {
                return Err(AppError::BadRequest(
                    "O usuário chamado já está ocupado em outra chamada.".to_string(),
                ));
            }
        }

        // 4. Cria sessão de chamada
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
            let mut calls = self.calls.write().await;
            let mut user_calls = self.user_active_calls.write().await;
            calls.insert(call_id, session.clone());
            user_calls.insert(caller_id, call_id);
            user_calls.insert(callee_id, call_id);
        }

        // 5. Notifica o destinatário via WebSocket (call.incoming)
        let caller_profile = self.auth_service.get_user_profile(caller_id).await?;
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
        self.presence_mgr.send_to_user(callee_id, &incoming_event).await;

        // Notifica o chamador com confirmação de toque e ID da chamada (call.ringing)
        let ringing_event = GatewayEvent::new(
            "call.ringing",
            json!({
                "call_id": call_id,
                "callee_id": callee_id,
            }),
        );
        self.presence_mgr.send_to_user(caller_id, &ringing_event).await;

        info!(
            "[Calls] Chamada 1:1 iniciada com sucesso: {} chamou {} (Call: {})",
            caller_id, callee_id, call_id
        );

        // 6. Timeout assíncrono para expiração do convite (45s)
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(CALL_RINGING_TIMEOUT_SECS)).await;
            let should_cancel = {
                let calls = this.calls.read().await;
                if let Some(c) = calls.get(&call_id) {
                    c.status == CallStatus::Ringing
                } else {
                    false
                }
            };

            if should_cancel {
                debug!("[Calls] Timeout de toque atingido para chamada {}. Cancelando.", call_id);
                let _ = this.cancel(caller_id, call_id).await;
            }
        });

        Ok(session)
    }

    /// Aceita um convite de chamada recebido
    pub async fn accept(
        &self,
        user_id: Uuid,
        call_id: Uuid,
    ) -> Result<CallSession, AppError> {
        let session = {
            let mut calls = self.calls.write().await;
            let s = calls.get_mut(&call_id).ok_or_else(|| {
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
            s.clone()
        };

        // Notifica o chamador que a chamada foi aceita (call.accepted)
        let accepted_event = GatewayEvent::new(
            "call.accepted",
            json!({
                "call_id": call_id,
                "peer_id": user_id,
            }),
        );
        self.presence_mgr.send_to_user(session.caller_id, &accepted_event).await;

        // Notifica quaisquer outras conexões do callee que a chamada foi atendida nesta sessão
        let callee_dismiss_event = GatewayEvent::new(
            "call.accepted_by_user",
            json!({
                "call_id": call_id,
            }),
        );
        self.presence_mgr.send_to_user(user_id, &callee_dismiss_event).await;

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
            let mut calls = self.calls.write().await;
            let s = calls.get_mut(&call_id).ok_or_else(|| {
                AppError::NotFound("Chamada não encontrada.".to_string())
            })?;

            if s.callee_id != user_id {
                return Err(AppError::Forbidden(
                    "Apenas o destinatário pode recusar a chamada.".to_string(),
                ));
            }

            s.status = CallStatus::Ended;
            s.ended_at = Some(Utc::now());
            s.caller_id
        };

        // Remove das chamadas ativas
        {
            let mut calls = self.calls.write().await;
            let mut user_calls = self.user_active_calls.write().await;
            calls.remove(&call_id);
            user_calls.remove(&caller_id);
            user_calls.remove(&user_id);
        }

        // Notifica o chamador que a chamada foi recusada (call.rejected)
        let reject_event = GatewayEvent::new(
            "call.rejected",
            json!({
                "call_id": call_id,
                "reason": reason.unwrap_or_else(|| "Chamada recusada.".to_string()),
            }),
        );
        self.presence_mgr.send_to_user(caller_id, &reject_event).await;

        info!("[Calls] Chamada {} recusada por {}.", call_id, user_id);
        Ok(())
    }

    /// Cancela uma chamada que ainda está tocando
    pub async fn cancel(
        &self,
        user_id: Uuid,
        call_id: Uuid,
    ) -> Result<(), AppError> {
        let callee_id = {
            let mut calls = self.calls.write().await;
            let s = calls.get_mut(&call_id).ok_or_else(|| {
                AppError::NotFound("Chamada não encontrada.".to_string())
            })?;

            if s.caller_id != user_id {
                return Err(AppError::Forbidden(
                    "Apenas o originador pode cancelar a chamada pendente.".to_string(),
                ));
            }

            s.status = CallStatus::Ended;
            s.ended_at = Some(Utc::now());
            s.callee_id
        };

        // Remove das chamadas ativas
        {
            let mut calls = self.calls.write().await;
            let mut user_calls = self.user_active_calls.write().await;
            calls.remove(&call_id);
            user_calls.remove(&user_id);
            user_calls.remove(&callee_id);
        }

        // Notifica ambos participantes que a chamada foi cancelada/expirada (call.canceled)
        let cancel_event = GatewayEvent::new(
            "call.canceled",
            json!({
                "call_id": call_id,
            }),
        );
        self.presence_mgr.send_to_user(callee_id, &cancel_event).await;
        self.presence_mgr.send_to_user(user_id, &cancel_event).await;

        info!("[Calls] Chamada {} cancelada por {}. Ambos participantes notificados.", call_id, user_id);
        Ok(())
    }

    /// Encerra uma chamada ativa
    pub async fn end(
        &self,
        user_id: Uuid,
        call_id: Uuid,
    ) -> Result<(), AppError> {
        let peer_id = {
            let mut calls = self.calls.write().await;
            let s = calls.get_mut(&call_id).ok_or_else(|| {
                AppError::NotFound("Chamada não encontrada.".to_string())
            })?;

            if s.caller_id != user_id && s.callee_id != user_id {
                return Err(AppError::Forbidden(
                    "Você não faz parte desta chamada.".to_string(),
                ));
            }

            s.status = CallStatus::Ended;
            s.ended_at = Some(Utc::now());

            if s.caller_id == user_id {
                s.callee_id
            } else {
                s.caller_id
            }
        };

        // Remove das chamadas ativas
        {
            let mut calls = self.calls.write().await;
            let mut user_calls = self.user_active_calls.write().await;
            calls.remove(&call_id);
            user_calls.remove(&user_id);
            user_calls.remove(&peer_id);
        }

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
            let mut calls = self.calls.write().await;
            let s = calls.get_mut(&call_id).ok_or_else(|| {
                AppError::NotFound("Chamada não encontrada.".to_string())
            })?;

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

    /// Encaminha SDP (Offer ou Answer) para o peer correspondente
    pub async fn relay_sdp(
        &self,
        user_id: Uuid,
        call_id: Uuid,
        target_user_id: Uuid,
        sdp_type: &str, // "offer" ou "answer"
        sdp: String,
    ) -> Result<(), AppError> {
        // Validação de segurança: apenas participantes da chamada podem trocar SDP
        {
            let calls = self.calls.read().await;
            let s = calls.get(&call_id).ok_or_else(|| {
                AppError::NotFound("Chamada não encontrada.".to_string())
            })?;

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
        let sdp_event = GatewayEvent::new(
            event_name,
            json!({
                "call_id": call_id,
                "sender_id": user_id,
                "sdp": sdp,
            }),
        );

        self.presence_mgr.send_to_user(target_user_id, &sdp_event).await;

        // Registra apenas diagnóstico do tipo e tamanho sem expor SDP completo
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
        // Validação de segurança: apenas participantes da chamada podem trocar ICE
        {
            let calls = self.calls.read().await;
            let s = calls.get(&call_id).ok_or_else(|| {
                AppError::NotFound("Chamada não encontrada.".to_string())
            })?;

            let is_participant = (s.caller_id == user_id && s.callee_id == target_user_id)
                || (s.callee_id == user_id && s.caller_id == target_user_id);

            if !is_participant {
                return Err(AppError::Forbidden(
                    "Operação de sinalização ICE não autorizada.".to_string(),
                ));
            }
        }

        let ice_event = GatewayEvent::new(
            "call.webrtc.ice_candidate",
            json!({
                "call_id": call_id,
                "sender_id": user_id,
                "candidate": candidate,
            }),
        );

        self.presence_mgr.send_to_user(target_user_id, &ice_event).await;

        // Diagnóstico seguro: não expõe endereços IP privados em logs
        debug!(
            "[Calls] ICE Candidate retransmitido ({} -> {}) [Call: {}]",
            user_id, target_user_id, call_id
        );

        Ok(())
    }

    /// Limpa chamadas de um usuário que desconectou do WebSocket
    pub async fn cleanup_user(&self, user_id: Uuid) {
        let call_opt = {
            let mut user_calls = self.user_active_calls.write().await;
            user_calls.remove(&user_id)
        };

        if let Some(call_id) = call_opt {
            let mut peer_to_notify = None;
            {
                let mut calls = self.calls.write().await;
                if let Some(s) = calls.remove(&call_id) {
                    let peer_id = if s.caller_id == user_id {
                        s.callee_id
                    } else {
                        s.caller_id
                    };
                    peer_to_notify = Some(peer_id);
                    let mut user_calls = self.user_active_calls.write().await;
                    user_calls.remove(&peer_id);
                }
            }

            if let Some(peer_id) = peer_to_notify {
                warn!(
                    "[Calls] Usuário {} desconectou durante chamada {}. Notificando peer {}.",
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
}
