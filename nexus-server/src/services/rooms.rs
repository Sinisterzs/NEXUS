use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::PgPool;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::{
    CommunityChannel, CommunityRole, GatewayEvent, RoomParticipantDto, VoiceRoomStateDto,
};
use crate::repositories::CommunityRepository;
use crate::services::community_permissions::{
    has_permission, resolve_channel_permissions, ChannelOverwriteRule,
    ResolveChannelPermissionsInput, PERM_CONNECT_VOICE, PERM_SCREEN_SHARE, PERM_SPEAK,
    PERM_VIEW_CHANNEL,
};
use crate::services::{AuthService, PresenceManager};

pub const DEFAULT_MAX_ROOM_PARTICIPANTS: usize = 4;

fn parse_max_participants(raw: Option<&str>) -> usize {
    raw.and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(DEFAULT_MAX_ROOM_PARTICIPANTS)
}

#[derive(Debug, Clone)]
struct VoiceRoom {
    participants: HashMap<Uuid, RoomParticipantDto>,
}

impl VoiceRoom {
    fn new() -> Self {
        Self {
            participants: HashMap::new(),
        }
    }

    fn sorted_participants(&self) -> Vec<RoomParticipantDto> {
        let mut list: Vec<RoomParticipantDto> = self.participants.values().cloned().collect();
        list.sort_by_key(|p| (p.joined_at, p.user_id));
        list
    }
}

#[derive(Debug)]
struct LeaveOutcome {
    community_id: Uuid,
    channel_id: Uuid,
    remaining_participant_ids: Vec<Uuid>,
    participants: Vec<RoomParticipantDto>,
}

#[derive(Default)]
struct RoomManagerState {
    rooms: HashMap<(Uuid, Uuid), VoiceRoom>,
    user_rooms: HashMap<Uuid, (Uuid, Uuid)>,
}

impl RoomManagerState {
    fn try_join(
        &mut self,
        community_id: Uuid,
        channel_id: Uuid,
        participant: RoomParticipantDto,
        max_participants: usize,
    ) -> Result<(Vec<RoomParticipantDto>, bool), AppError> {
        let key = (community_id, channel_id);
        let user_id = participant.user_id;

        if let Some(existing_room) = self.rooms.get(&key) {
            if !existing_room.participants.contains_key(&user_id)
                && existing_room.participants.len() >= max_participants
            {
                return Err(AppError::BadRequest(format!(
                    "A sala de voz atingiu o limite máximo de {} participantes.",
                    max_participants
                )));
            }
        }

        let room = self
            .rooms
            .entry(key)
            .or_insert_with(VoiceRoom::new);
        let is_new_join = !room.participants.contains_key(&user_id);
        room.participants.insert(user_id, participant);
        self.user_rooms.insert(user_id, key);

        Ok((room.sorted_participants(), is_new_join))
    }

    fn remove_participant(
        &mut self,
        community_id: Uuid,
        channel_id: Uuid,
        user_id: Uuid,
    ) -> Option<LeaveOutcome> {
        let key = (community_id, channel_id);
        let room = self.rooms.get_mut(&key)?;
        room.participants.remove(&user_id)?;

        if self.user_rooms.get(&user_id) == Some(&key) {
            self.user_rooms.remove(&user_id);
        }

        let remaining_participant_ids: Vec<Uuid> = room.participants.keys().copied().collect();
        let participants = room.sorted_participants();

        if room.participants.is_empty() {
            self.rooms.remove(&key);
        }

        Some(LeaveOutcome {
            community_id,
            channel_id,
            remaining_participant_ids,
            participants,
        })
    }

    fn validate_peer_signal(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        sender_id: Uuid,
        target_user_id: Uuid,
    ) -> Result<(), AppError> {
        if sender_id == target_user_id {
            return Err(AppError::BadRequest(
                "Não é possível enviar sinalização WebRTC para si mesmo.".to_string(),
            ));
        }

        let key = (community_id, channel_id);
        let room = self.rooms.get(&key).ok_or_else(|| {
            AppError::NotFound("Sala de voz não encontrada ou sem participantes.".to_string())
        })?;

        if !room.participants.contains_key(&sender_id) {
            return Err(AppError::Forbidden(
                "Você não está conectado a esta sala de voz.".to_string(),
            ));
        }

        if !room.participants.contains_key(&target_user_id) {
            return Err(AppError::NotFound(
                "O participante de destino não está nesta sala de voz.".to_string(),
            ));
        }

        Ok(())
    }
}

#[derive(Clone)]
pub struct RoomService {
    state: Arc<RwLock<RoomManagerState>>,
    max_participants: usize,
    pool: PgPool,
    repo: CommunityRepository,
    auth_service: AuthService,
    presence_mgr: PresenceManager,
}

impl RoomService {
    pub fn new(
        pool: PgPool,
        auth_service: AuthService,
        presence_mgr: PresenceManager,
    ) -> Self {
        let max_participants = parse_max_participants(
            std::env::var("NEXUS_VOICE_MAX_PARTICIPANTS")
                .ok()
                .as_deref(),
        );
        let repo = CommunityRepository::new(pool.clone());
        Self {
            state: Arc::new(RwLock::new(RoomManagerState::default())),
            max_participants,
            pool,
            repo,
            auth_service,
            presence_mgr,
        }
    }

    pub fn with_max_participants(mut self, max_participants: usize) -> Self {
        self.max_participants = max_participants.max(1);
        self
    }

    pub fn max_participants(&self) -> usize {
        self.max_participants
    }

    /// Entra em um canal de voz de uma comunidade após validar canal, membresia e permissões.
    pub async fn join_room(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        user_id: Uuid,
    ) -> Result<VoiceRoomStateDto, AppError> {
        let channel = self
            .repo
            .get_channel(community_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Canal de voz não encontrado.".to_string()))?;

        if channel.channel_type != "voice" {
            return Err(AppError::BadRequest(
                "Este canal não é um canal de voz.".to_string(),
            ));
        }

        let perms = self
            .resolve_user_channel_permissions(community_id, &channel, user_id)
            .await?;

        if !has_permission(perms, PERM_VIEW_CHANNEL) || !has_permission(perms, PERM_CONNECT_VOICE) {
            return Err(AppError::Forbidden(
                "Você não tem permissão para conectar a este canal de voz.".to_string(),
            ));
        }

        let can_speak = has_permission(perms, PERM_SPEAK);
        let can_screen_share = has_permission(perms, PERM_SCREEN_SHARE);
        let user_profile = self.auth_service.get_user_profile(user_id).await?;

        // Se o usuário já estiver em outra sala, remove da sala anterior antes de entrar na nova.
        let previous_room = {
            let state = self.state.read().await;
            state.user_rooms.get(&user_id).copied()
        };
        if let Some((prev_community_id, prev_channel_id)) = previous_room {
            if (prev_community_id, prev_channel_id) != (community_id, channel_id) {
                self.leave_specific_room_with_reason(
                    prev_community_id,
                    prev_channel_id,
                    user_id,
                    Some("moved_to_another_room"),
                )
                .await?;
            }
        }

        let participant = RoomParticipantDto {
            user_id,
            username: user_profile.username,
            display_name: user_profile.display_name,
            avatar_url: user_profile.avatar_url,
            is_muted: !can_speak,
            is_deafened: false,
            is_speaking: false,
            is_screen_sharing: false,
            can_speak,
            can_screen_share,
            joined_at: Utc::now(),
        };

        let (participants, is_new_join) = {
            let mut state = self.state.write().await;
            state.try_join(community_id, channel_id, participant.clone(), self.max_participants)?
        };

        let joined_event = GatewayEvent::new(
            "room_joined",
            json!({
                "community_id": community_id,
                "channel_id": channel_id,
                "max_participants": self.max_participants,
                "participants": participants,
                "can_speak": can_speak,
                "can_screen_share": can_screen_share,
            }),
        );
        self.presence_mgr
            .send_critical_event(user_id, &joined_event)
            .await;

        if is_new_join {
            let other_ids: Vec<Uuid> = participants
                .iter()
                .filter(|p| p.user_id != user_id)
                .map(|p| p.user_id)
                .collect();
            if !other_ids.is_empty() {
                let participant_joined_event = GatewayEvent::new(
                    "room_participant_joined",
                    json!({
                        "community_id": community_id,
                        "channel_id": channel_id,
                        "participant": participant,
                    }),
                );
                self.presence_mgr
                    .broadcast_to_users(&other_ids, &participant_joined_event)
                    .await;
            }
        }

        self.broadcast_community_voice_state(community_id, &channel, &participants)
            .await;

        info!(
            "[Rooms] Usuário {} entrou na sala de voz ({}, {}) [{} participantes]",
            user_id,
            community_id,
            channel_id,
            participants.len()
        );

        Ok(VoiceRoomStateDto {
            community_id,
            channel_id,
            max_participants: self.max_participants,
            participants,
        })
    }

    /// Remove o usuário da sala em que estiver conectado (ex: desconexão do WebSocket).
    /// Nunca encerra a sala para os demais participantes enquanto restar >= 1 participante.
    pub async fn leave_room(&self, user_id: Uuid) -> Result<(), AppError> {
        let current_room = {
            let state = self.state.read().await;
            state.user_rooms.get(&user_id).copied()
        };

        if let Some((community_id, channel_id)) = current_room {
            self.leave_specific_room_with_reason(
                community_id,
                channel_id,
                user_id,
                Some("disconnected"),
            )
            .await?;
        }

        Ok(())
    }

    /// Remove apenas `user_id` da sala `(community_id, channel_id)`.
    pub async fn leave_specific_room(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        user_id: Uuid,
    ) -> Result<(), AppError> {
        self.leave_specific_room_with_reason(community_id, channel_id, user_id, None)
            .await
    }

    async fn leave_specific_room_with_reason(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        user_id: Uuid,
        reason: Option<&str>,
    ) -> Result<(), AppError> {
        let outcome = {
            let mut state = self.state.write().await;
            state.remove_participant(community_id, channel_id, user_id)
        };

        let Some(outcome) = outcome else {
            return Ok(());
        };

        let left_event = GatewayEvent::new(
            "room_left",
            json!({
                "community_id": outcome.community_id,
                "channel_id": outcome.channel_id,
                "reason": reason,
            }),
        );
        self.presence_mgr
            .send_critical_event(user_id, &left_event)
            .await;

        if !outcome.remaining_participant_ids.is_empty() {
            let participant_left_event = GatewayEvent::new(
                "room_participant_left",
                json!({
                    "community_id": outcome.community_id,
                    "channel_id": outcome.channel_id,
                    "user_id": user_id,
                }),
            );
            self.presence_mgr
                .broadcast_to_users(&outcome.remaining_participant_ids, &participant_left_event)
                .await;
        }

        if let Ok(Some(channel)) = self.repo.get_channel(community_id, channel_id).await {
            self.broadcast_community_voice_state(community_id, &channel, &outcome.participants)
                .await;
        }

        debug!(
            "[Rooms] Usuário {} saiu da sala ({}, {}); {} participantes restantes",
            user_id,
            community_id,
            channel_id,
            outcome.participants.len()
        );

        Ok(())
    }

    /// Atualiza o estado de áudio/tela do participante na sala, validando `PERM_SPEAK` e `PERM_SCREEN_SHARE`.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_participant_state(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        user_id: Uuid,
        is_muted: Option<bool>,
        is_deafened: Option<bool>,
        is_speaking: Option<bool>,
        is_screen_sharing: Option<bool>,
    ) -> Result<RoomParticipantDto, AppError> {
        let channel = self
            .repo
            .get_channel(community_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Canal de voz não encontrado.".to_string()))?;

        let perms = self
            .resolve_user_channel_permissions(community_id, &channel, user_id)
            .await?;

        let can_speak = has_permission(perms, PERM_SPEAK);
        let can_screen_share = has_permission(perms, PERM_SCREEN_SHARE);

        if (is_muted == Some(false) || is_speaking == Some(true)) && !can_speak {
            return Err(AppError::Forbidden(
                "Você não tem permissão para falar neste canal de voz.".to_string(),
            ));
        }

        if is_screen_sharing == Some(true) && !can_screen_share {
            return Err(AppError::Forbidden(
                "Você não tem permissão para compartilhar tela neste canal de voz.".to_string(),
            ));
        }

        let (updated_participant, room_member_ids, participants) = {
            let mut state = self.state.write().await;
            let key = (community_id, channel_id);
            let room = state.rooms.get_mut(&key).ok_or_else(|| {
                AppError::NotFound("Sala de voz não encontrada.".to_string())
            })?;
            let participant = room.participants.get_mut(&user_id).ok_or_else(|| {
                AppError::Forbidden("Você não está conectado a esta sala de voz.".to_string())
            })?;

            participant.can_speak = can_speak;
            participant.can_screen_share = can_screen_share;

            if let Some(muted) = is_muted {
                participant.is_muted = muted;
            }
            if let Some(deafened) = is_deafened {
                participant.is_deafened = deafened;
            }
            if let Some(speaking) = is_speaking {
                participant.is_speaking = speaking;
            }
            if let Some(screen_sharing) = is_screen_sharing {
                participant.is_screen_sharing = screen_sharing;
            }

            if !can_speak {
                participant.is_muted = true;
                participant.is_speaking = false;
            }
            if !can_screen_share {
                participant.is_screen_sharing = false;
            }
            if participant.is_muted || participant.is_deafened {
                participant.is_speaking = false;
            }

            let updated = participant.clone();
            let member_ids: Vec<Uuid> = room.participants.keys().copied().collect();
            let sorted = room.sorted_participants();
            (updated, member_ids, sorted)
        };

        let updated_event = GatewayEvent::new(
            "room_participant_updated",
            json!({
                "community_id": community_id,
                "channel_id": channel_id,
                "participant": updated_participant,
            }),
        );
        self.presence_mgr
            .broadcast_to_users(&room_member_ids, &updated_event)
            .await;

        self.broadcast_community_voice_state(community_id, &channel, &participants)
            .await;

        Ok(updated_participant)
    }

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

    pub async fn relay_webrtc_offer(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        sender_id: Uuid,
        target_user_id: Uuid,
        sdp: String,
        stream_kind: Option<String>,
    ) -> Result<(), AppError> {
        Self::validate_stream_kind(stream_kind.as_deref())?;
        let mut payload = json!({
            "community_id": community_id,
            "channel_id": channel_id,
            "sender_id": sender_id,
            "sdp": sdp,
        });
        if let Some(kind) = stream_kind {
            payload["stream_kind"] = json!(kind);
        }
        self.relay_peer_signal(
            community_id,
            channel_id,
            sender_id,
            target_user_id,
            "room_webrtc_offer",
            payload,
        )
        .await
    }

    pub async fn relay_webrtc_answer(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        sender_id: Uuid,
        target_user_id: Uuid,
        sdp: String,
        stream_kind: Option<String>,
    ) -> Result<(), AppError> {
        Self::validate_stream_kind(stream_kind.as_deref())?;
        let mut payload = json!({
            "community_id": community_id,
            "channel_id": channel_id,
            "sender_id": sender_id,
            "sdp": sdp,
        });
        if let Some(kind) = stream_kind {
            payload["stream_kind"] = json!(kind);
        }
        self.relay_peer_signal(
            community_id,
            channel_id,
            sender_id,
            target_user_id,
            "room_webrtc_answer",
            payload,
        )
        .await
    }

    pub async fn relay_webrtc_ice_candidate(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        sender_id: Uuid,
        target_user_id: Uuid,
        candidate: serde_json::Value,
        stream_kind: Option<String>,
    ) -> Result<(), AppError> {
        Self::validate_stream_kind(stream_kind.as_deref())?;
        let mut payload = json!({
            "community_id": community_id,
            "channel_id": channel_id,
            "sender_id": sender_id,
            "candidate": candidate,
        });
        if let Some(kind) = stream_kind {
            payload["stream_kind"] = json!(kind);
        }
        self.relay_peer_signal(
            community_id,
            channel_id,
            sender_id,
            target_user_id,
            "room_webrtc_ice_candidate",
            payload,
        )
        .await
    }

    async fn relay_peer_signal(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        sender_id: Uuid,
        target_user_id: Uuid,
        event_type: &str,
        payload: serde_json::Value,
    ) -> Result<(), AppError> {
        {
            let state = self.state.read().await;
            state.validate_peer_signal(community_id, channel_id, sender_id, target_user_id)?;
        }

        let event = GatewayEvent::new(event_type, payload);
        self.presence_mgr.send_to_user(target_user_id, &event).await;
        Ok(())
    }

    /// Lista os canais de voz com participantes ativos em uma comunidade (filtrados por `PERM_VIEW_CHANNEL`).
    pub async fn list_community_voice_rooms(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
    ) -> Result<Vec<VoiceRoomStateDto>, AppError> {
        let community = self
            .repo
            .get_community_by_id(community_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Comunidade não encontrada.".to_string()))?;

        if self.repo.get_active_ban(community_id, actor_id).await?.is_some() {
            return Err(AppError::Forbidden(
                "Você está banido desta comunidade.".to_string(),
            ));
        }
        if !self.repo.is_member(community_id, actor_id).await? {
            return Err(AppError::Forbidden(
                "Você não é membro desta comunidade.".to_string(),
            ));
        }

        let snapshot: Vec<(Uuid, Vec<RoomParticipantDto>)> = {
            let state = self.state.read().await;
            state
                .rooms
                .iter()
                .filter(|((comm_id, _), room)| *comm_id == community_id && !room.participants.is_empty())
                .map(|((_, chan_id), room)| (*chan_id, room.sorted_participants()))
                .collect()
        };

        if snapshot.is_empty() {
            return Ok(Vec::new());
        }

        let roles = self.repo.list_roles(community_id).await?;
        let everyone_role = roles.iter().find(|r| r.is_default);
        let everyone_role_id = everyone_role.map(|r| r.id);
        let everyone_permissions = everyone_role.map_or(0, |r| r.permissions_bitmask);
        let role_map: HashMap<Uuid, &CommunityRole> = roles.iter().map(|r| (r.id, r)).collect();
        let actor_role_ids = self.repo.list_member_role_ids(community_id, actor_id).await?;
        let actor_role_perms: Vec<i64> = actor_role_ids
            .iter()
            .filter_map(|rid| role_map.get(rid).map(|r| r.permissions_bitmask))
            .collect();
        let actor_mute = self.repo.get_member_mute(community_id, actor_id).await?;
        let channels = self.repo.list_channels(community_id).await?;
        let channel_map: HashMap<Uuid, CommunityChannel> =
            channels.into_iter().map(|c| (c.id, c)).collect();
        let now = Utc::now();

        let mut visible_rooms = Vec::new();
        for (channel_id, participants) in snapshot {
            let Some(channel) = channel_map.get(&channel_id) else {
                continue;
            };
            let overwrites = self.repo.list_channel_overwrites(channel_id).await?;
            let rules: Vec<ChannelOverwriteRule> =
                overwrites.iter().map(ChannelOverwriteRule::from).collect();
            let perms = resolve_channel_permissions(&ResolveChannelPermissionsInput {
                actor_id,
                owner_id: community.owner_id,
                is_member: true,
                is_banned: false,
                everyone_role_id,
                everyone_permissions,
                member_role_ids: &actor_role_ids,
                member_role_permissions: &actor_role_perms,
                is_private: channel.is_private,
                is_read_only: channel.is_read_only,
                overwrites: &rules,
                text_muted_until: actor_mute.as_ref().and_then(|m| m.text_muted_until),
                voice_muted_until: actor_mute.as_ref().and_then(|m| m.voice_muted_until),
                server_voice_muted: actor_mute.as_ref().map_or(false, |m| m.server_voice_muted),
                now,
            });
            if has_permission(perms, PERM_VIEW_CHANNEL) {
                visible_rooms.push(VoiceRoomStateDto {
                    community_id,
                    channel_id,
                    max_participants: self.max_participants,
                    participants,
                });
            }
        }

        visible_rooms.sort_by_key(|r| r.channel_id);
        Ok(visible_rooms)
    }

    async fn resolve_user_channel_permissions(
        &self,
        community_id: Uuid,
        channel: &CommunityChannel,
        user_id: Uuid,
    ) -> Result<i64, AppError> {
        let community = self
            .repo
            .get_community_by_id(community_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Comunidade não encontrada.".to_string()))?;

        if self.repo.get_active_ban(community_id, user_id).await?.is_some() {
            return Err(AppError::Forbidden(
                "Você está banido desta comunidade.".to_string(),
            ));
        }

        if !self.repo.is_member(community_id, user_id).await? {
            return Err(AppError::Forbidden(
                "Você não é membro desta comunidade.".to_string(),
            ));
        }

        let roles = self.repo.list_roles(community_id).await?;
        let everyone_role = roles.iter().find(|r| r.is_default);
        let everyone_role_id = everyone_role.map(|r| r.id);
        let everyone_permissions = everyone_role.map_or(0, |r| r.permissions_bitmask);
        let role_map: HashMap<Uuid, i64> = roles
            .iter()
            .map(|r| (r.id, r.permissions_bitmask))
            .collect();

        let member_role_ids = self.repo.list_member_role_ids(community_id, user_id).await?;
        let member_role_permissions: Vec<i64> = member_role_ids
            .iter()
            .filter_map(|rid| role_map.get(rid).copied())
            .collect();

        let overwrites = self.repo.list_channel_overwrites(channel.id).await?;
        let rules: Vec<ChannelOverwriteRule> =
            overwrites.iter().map(ChannelOverwriteRule::from).collect();
        let mute = self.repo.get_member_mute(community_id, user_id).await?;

        Ok(resolve_channel_permissions(&ResolveChannelPermissionsInput {
            actor_id: user_id,
            owner_id: community.owner_id,
            is_member: true,
            is_banned: false,
            everyone_role_id,
            everyone_permissions,
            member_role_ids: &member_role_ids,
            member_role_permissions: &member_role_permissions,
            is_private: channel.is_private,
            is_read_only: channel.is_read_only,
            overwrites: &rules,
            text_muted_until: mute.as_ref().and_then(|m| m.text_muted_until),
            voice_muted_until: mute.as_ref().and_then(|m| m.voice_muted_until),
            server_voice_muted: mute.as_ref().map_or(false, |m| m.server_voice_muted),
            now: Utc::now(),
        }))
    }

    async fn broadcast_community_voice_state(
        &self,
        community_id: Uuid,
        channel: &CommunityChannel,
        participants: &[RoomParticipantDto],
    ) {
        let viewers = self
            .list_authorized_channel_viewers(community_id, channel)
            .await;
        if viewers.is_empty() {
            return;
        }

        let event = GatewayEvent::new(
            "community_voice_state_updated",
            json!({
                "community_id": community_id,
                "channel_id": channel.id,
                "participants": participants,
            }),
        );
        self.presence_mgr.broadcast_to_users(&viewers, &event).await;
    }

    async fn list_authorized_channel_viewers(
        &self,
        community_id: Uuid,
        channel: &CommunityChannel,
    ) -> Vec<Uuid> {
        let connected_ids = self.presence_mgr.list_connected_user_ids().await;
        if connected_ids.is_empty() {
            return Vec::new();
        }

        let Ok(Some(community)) = self.repo.get_community_by_id(community_id).await else {
            return Vec::new();
        };

        let target_users: Vec<Uuid> = match sqlx::query_scalar::<_, Uuid>(
            r#"
            SELECT cm.user_id
            FROM community_members cm
            WHERE cm.community_id = $1
              AND cm.user_id = ANY($2)
              AND NOT EXISTS (
                  SELECT 1 FROM community_bans b
                  WHERE b.community_id = cm.community_id
                    AND b.user_id = cm.user_id
                    AND (b.expires_at IS NULL OR b.expires_at > NOW())
              )
            "#,
        )
        .bind(community_id)
        .bind(&connected_ids)
        .fetch_all(&self.pool)
        .await
        {
            Ok(ids) => ids,
            Err(e) => {
                warn!(
                    "[Rooms] Falha ao listar membros conectados da comunidade {}: {}",
                    community_id, e
                );
                return Vec::new();
            }
        };

        if target_users.is_empty() {
            return Vec::new();
        }

        let roles = self.repo.list_roles(community_id).await.unwrap_or_default();
        let everyone_role = roles.iter().find(|r| r.is_default);
        let everyone_role_id = everyone_role.map(|r| r.id);
        let everyone_permissions = everyone_role.map_or(0, |r| r.permissions_bitmask);
        let role_perm_map: HashMap<Uuid, i64> = roles
            .iter()
            .map(|r| (r.id, r.permissions_bitmask))
            .collect();

        #[derive(sqlx::FromRow)]
        struct MemberRoleRow {
            user_id: Uuid,
            role_id: Uuid,
        }
        let member_role_rows = sqlx::query_as::<_, MemberRoleRow>(
            r#"
            SELECT user_id, role_id
            FROM community_member_roles
            WHERE community_id = $1 AND user_id = ANY($2)
            "#,
        )
        .bind(community_id)
        .bind(&target_users)
        .fetch_all(&self.pool)
        .await
        .unwrap_or_default();

        let mut user_role_ids: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
        for row in member_role_rows {
            user_role_ids.entry(row.user_id).or_default().push(row.role_id);
        }

        #[derive(sqlx::FromRow)]
        struct MemberMuteRow {
            user_id: Uuid,
            text_muted_until: Option<DateTime<Utc>>,
            voice_muted_until: Option<DateTime<Utc>>,
            server_voice_muted: bool,
        }
        let mutes = sqlx::query_as::<_, MemberMuteRow>(
            r#"
            SELECT user_id, text_muted_until, voice_muted_until, COALESCE(server_voice_muted, FALSE) AS server_voice_muted
            FROM community_member_mutes
            WHERE community_id = $1 AND user_id = ANY($2)
            "#,
        )
        .bind(community_id)
        .bind(&target_users)
        .fetch_all(&self.pool)
        .await
        .unwrap_or_default();

        let mute_map: HashMap<Uuid, MemberMuteRow> =
            mutes.into_iter().map(|m| (m.user_id, m)).collect();

        let overwrites = self
            .repo
            .list_channel_overwrites(channel.id)
            .await
            .unwrap_or_default();
        let rules: Vec<ChannelOverwriteRule> =
            overwrites.iter().map(ChannelOverwriteRule::from).collect();
        let now = Utc::now();

        let mut viewers = HashSet::new();
        for uid in target_users {
            let role_ids = user_role_ids.get(&uid).map(Vec::as_slice).unwrap_or(&[]);
            let role_perms: Vec<i64> = role_ids
                .iter()
                .filter_map(|rid| role_perm_map.get(rid).copied())
                .collect();
            let mute = mute_map.get(&uid);
            let perms = resolve_channel_permissions(&ResolveChannelPermissionsInput {
                actor_id: uid,
                owner_id: community.owner_id,
                is_member: true,
                is_banned: false,
                everyone_role_id,
                everyone_permissions,
                member_role_ids: role_ids,
                member_role_permissions: &role_perms,
                is_private: channel.is_private,
                is_read_only: channel.is_read_only,
                overwrites: &rules,
                text_muted_until: mute.and_then(|m| m.text_muted_until),
                voice_muted_until: mute.and_then(|m| m.voice_muted_until),
                server_voice_muted: mute.map_or(false, |m| m.server_voice_muted),
                now,
            });
            if has_permission(perms, PERM_VIEW_CHANNEL) {
                viewers.insert(uid);
            }
        }

        viewers.into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_participant(user_id: Uuid, label: &str) -> RoomParticipantDto {
        RoomParticipantDto {
            user_id,
            username: label.to_string(),
            display_name: label.to_string(),
            avatar_url: None,
            is_muted: false,
            is_deafened: false,
            is_speaking: false,
            is_screen_sharing: false,
            can_speak: true,
            can_screen_share: true,
            joined_at: Utc::now(),
        }
    }

    #[test]
    fn test_parse_max_participants_defaults_and_overrides() {
        assert_eq!(parse_max_participants(None), DEFAULT_MAX_ROOM_PARTICIPANTS);
        assert_eq!(parse_max_participants(Some("")), DEFAULT_MAX_ROOM_PARTICIPANTS);
        assert_eq!(parse_max_participants(Some("0")), DEFAULT_MAX_ROOM_PARTICIPANTS);
        assert_eq!(parse_max_participants(Some("invalid")), DEFAULT_MAX_ROOM_PARTICIPANTS);
        assert_eq!(parse_max_participants(Some("8")), 8);
    }

    #[test]
    fn test_room_capacity_limit_of_four() {
        let mut state = RoomManagerState::default();
        let community_id = Uuid::new_v4();
        let channel_id = Uuid::new_v4();

        for idx in 1..=DEFAULT_MAX_ROOM_PARTICIPANTS {
            let uid = Uuid::new_v4();
            let (participants, is_new) = state
                .try_join(
                    community_id,
                    channel_id,
                    make_participant(uid, &format!("user_{idx}")),
                    DEFAULT_MAX_ROOM_PARTICIPANTS,
                )
                .expect("deve permitir até 4 participantes");
            assert!(is_new);
            assert_eq!(participants.len(), idx);
        }

        let fifth_user = Uuid::new_v4();
        let err = state
            .try_join(
                community_id,
                channel_id,
                make_participant(fifth_user, "user_5"),
                DEFAULT_MAX_ROOM_PARTICIPANTS,
            )
            .expect_err("5º participante deve ser rejeitado quando a sala está cheia");
        assert!(matches!(err, AppError::BadRequest(_)));
        assert_eq!(
            state
                .rooms
                .get(&(community_id, channel_id))
                .map(|r| r.participants.len()),
            Some(DEFAULT_MAX_ROOM_PARTICIPANTS)
        );
    }

    #[test]
    fn test_leave_room_preserves_other_participants_and_deletes_only_when_empty() {
        let mut state = RoomManagerState::default();
        let community_id = Uuid::new_v4();
        let channel_id = Uuid::new_v4();

        let u1 = Uuid::new_v4();
        let u2 = Uuid::new_v4();
        let u3 = Uuid::new_v4();

        for (uid, name) in [(u1, "u1"), (u2, "u2"), (u3, "u3")] {
            state
                .try_join(
                    community_id,
                    channel_id,
                    make_participant(uid, name),
                    DEFAULT_MAX_ROOM_PARTICIPANTS,
                )
                .unwrap();
        }

        // Saída de u1 não encerra a sala para u2 e u3
        let outcome1 = state
            .remove_participant(community_id, channel_id, u1)
            .expect("u1 estava na sala");
        assert_eq!(outcome1.remaining_participant_ids.len(), 2);
        assert!(outcome1.remaining_participant_ids.contains(&u2));
        assert!(outcome1.remaining_participant_ids.contains(&u3));
        assert!(state.rooms.contains_key(&(community_id, channel_id)));
        assert!(!state.user_rooms.contains_key(&u1));
        assert_eq!(state.user_rooms.get(&u2), Some(&(community_id, channel_id)));

        // Saída de u2 ainda mantém u3 na sala
        let outcome2 = state
            .remove_participant(community_id, channel_id, u2)
            .expect("u2 estava na sala");
        assert_eq!(outcome2.remaining_participant_ids, vec![u3]);
        assert!(state.rooms.contains_key(&(community_id, channel_id)));

        // Saída do último participante (u3) apaga a sala
        let outcome3 = state
            .remove_participant(community_id, channel_id, u3)
            .expect("u3 estava na sala");
        assert!(outcome3.remaining_participant_ids.is_empty());
        assert!(outcome3.participants.is_empty());
        assert!(!state.rooms.contains_key(&(community_id, channel_id)));
    }

    #[test]
    fn test_webrtc_signaling_isolated_to_same_room() {
        let mut state = RoomManagerState::default();
        let community_id = Uuid::new_v4();
        let room_a = Uuid::new_v4();
        let room_b = Uuid::new_v4();

        let u1 = Uuid::new_v4();
        let u2 = Uuid::new_v4();
        let u3 = Uuid::new_v4();
        let outsider = Uuid::new_v4();

        state
            .try_join(
                community_id,
                room_a,
                make_participant(u1, "u1"),
                DEFAULT_MAX_ROOM_PARTICIPANTS,
            )
            .unwrap();
        state
            .try_join(
                community_id,
                room_a,
                make_participant(u2, "u2"),
                DEFAULT_MAX_ROOM_PARTICIPANTS,
            )
            .unwrap();
        state
            .try_join(
                community_id,
                room_b,
                make_participant(u3, "u3"),
                DEFAULT_MAX_ROOM_PARTICIPANTS,
            )
            .unwrap();

        // Mesmo par na mesma sala: permitido
        assert!(state
            .validate_peer_signal(community_id, room_a, u1, u2)
            .is_ok());

        // Destinatário em outra sala: bloqueado
        assert!(state
            .validate_peer_signal(community_id, room_a, u1, u3)
            .is_err());

        // Remetente tentando sinalizar na sala B onde não está: bloqueado
        assert!(state
            .validate_peer_signal(community_id, room_b, u1, u3)
            .is_err());

        // Destinatário fora de qualquer sala: bloqueado
        assert!(state
            .validate_peer_signal(community_id, room_a, u1, outsider)
            .is_err());
    }
}
