use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::json;
use tracing::warn;
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::{
    validate_overwrite_target_type, AcceptInviteResponse, AuditLogsQuery, BanMemberRequest,
    ChannelMessageDto, ChannelMessagesPageDto, ChannelMessagesQuery, ChannelPermissionOverwrite,
    ChannelPermissionOverwriteDto, ChannelReadStateDto, Community, CommunityAuditLogDto,
    CommunityBan, CommunityBanDto, CommunityCategoryDto, CommunityChannel, CommunityChannelDto,
    CommunityDto, CommunityInviteDto, CommunityMemberDto, CommunityMemberMute,
    CommunityMemberMuteDto, CommunityRole, CommunityRoleDto, CommunitySnapshotDto,
    CreateCategoryRequest, CreateChannelRequest, CreateCommunityRequest, CreateInviteRequest,
    CreateRoleRequest, DeleteCommunityRequest, EditChannelMessageRequest, GatewayEvent,
    InvitePreviewDto, KickMemberRequest, MarkChannelReadRequest, MuteMemberRequest,
    ReorderCategoriesRequest, ReorderChannelsRequest, ReorderRolesRequest,
    SendChannelMessageRequest, TransferOwnershipRequest, UpdateCategoryRequest,
    UpdateChannelRequest, UpdateCommunityRequest, UpdateMemberRequest, UpdateRoleRequest,
    UpsertChannelOverwriteRequest,
};
use crate::repositories::CommunityRepository;
use crate::services::community_permissions::{
    compute_actor_top_position, ensure_can_assign_role, ensure_can_delete_role,
    ensure_can_manage_channel_overwrite, ensure_can_manage_role, ensure_can_moderate_member,
    has_permission, resolve_channel_permissions, resolve_community_permissions,
    ChannelOverwriteRule, ResolveChannelPermissionsInput, PERM_ADMINISTRATOR, PERM_CREATE_INVITES,
    PERM_MANAGE_CHANNELS, PERM_MANAGE_COMMUNITY, PERM_MANAGE_MESSAGES, PERM_MANAGE_ROLES,
    PERM_MODERATE_MEMBERS, PERM_MUTE_MEMBERS_VOICE, PERM_READ_MESSAGE_HISTORY,
    PERM_SEND_MESSAGES, PERM_VIEW_AUDIT_LOG, PERM_VIEW_CHANNEL,
};
use crate::services::presence::PresenceManager;

struct ActorContext {
    community: Community,
    roles: Vec<CommunityRole>,
    everyone_role_id: Option<Uuid>,
    everyone_permissions: i64,
    actor_role_ids: Vec<Uuid>,
    actor_role_permissions: Vec<i64>,
    actor_top_pos: i32,
    actor_community_perms: i64,
    actor_mute: Option<CommunityMemberMute>,
    is_owner: bool,
}

#[derive(Clone)]
pub struct CommunityService {
    repo: CommunityRepository,
    presence_mgr: Option<PresenceManager>,
}

impl CommunityService {
    pub fn new(repo: CommunityRepository) -> Self {
        Self {
            repo,
            presence_mgr: None,
        }
    }

    pub fn new_with_presence(repo: CommunityRepository, presence_mgr: PresenceManager) -> Self {
        Self {
            repo,
            presence_mgr: Some(presence_mgr),
        }
    }

    pub fn repo(&self) -> &CommunityRepository {
        &self.repo
    }

    async fn connected_community_member_ids(&self, community_id: Uuid) -> Vec<Uuid> {
        let Some(ref pm) = self.presence_mgr else {
            return Vec::new();
        };
        let connected = pm.list_connected_user_ids().await;
        if connected.is_empty() {
            return Vec::new();
        }

        match sqlx::query_scalar::<_, Uuid>(
            r#"
            SELECT cm.user_id
            FROM community_members cm
            JOIN communities c ON c.id = cm.community_id AND c.deleted_at IS NULL
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
        .bind(&connected)
        .fetch_all(self.repo.pool())
        .await
        {
            Ok(ids) => ids,
            Err(e) => {
                warn!(
                    "[CommunityRT] Falha ao listar membros conectados da comunidade {}: {}",
                    community_id, e
                );
                Vec::new()
            }
        }
    }

    async fn connected_channel_member_perms(
        &self,
        community_id: Uuid,
        channel: &CommunityChannel,
        overwrites: &[ChannelPermissionOverwrite],
        only_user_ids: Option<&[Uuid]>,
    ) -> HashMap<Uuid, i64> {
        let mut target_users = self.connected_community_member_ids(community_id).await;
        if let Some(filter) = only_user_ids {
            let filter_set: HashSet<Uuid> = filter.iter().copied().collect();
            target_users.retain(|id| filter_set.contains(id));
        }
        if target_users.is_empty() {
            return HashMap::new();
        }

        let Ok(Some(community)) = self.repo.get_community_by_id(community_id).await else {
            return HashMap::new();
        };
        let Ok(roles) = self.repo.list_roles(community_id).await else {
            return HashMap::new();
        };

        let everyone_role = roles.iter().find(|r| r.is_default);
        let everyone_role_id = everyone_role.map(|r| r.id);
        let everyone_permissions = everyone_role.map_or(0, |r| r.permissions_bitmask);
        let role_perm_map: HashMap<Uuid, i64> =
            roles.iter().map(|r| (r.id, r.permissions_bitmask)).collect();

        #[derive(sqlx::FromRow)]
        struct MemberRoleRow {
            user_id: Uuid,
            role_id: Uuid,
        }
        let member_roles = match sqlx::query_as::<_, MemberRoleRow>(
            r#"
            SELECT user_id, role_id
            FROM community_member_roles
            WHERE community_id = $1 AND user_id = ANY($2)
            "#,
        )
        .bind(community_id)
        .bind(&target_users)
        .fetch_all(self.repo.pool())
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                warn!(
                    "[CommunityRT] Falha ao carregar cargos de membros conectados em {}: {}",
                    community_id, e
                );
                return HashMap::new();
            }
        };

        let mut user_role_ids: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
        for row in member_roles {
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
        .fetch_all(self.repo.pool())
        .await
        .unwrap_or_default();

        let mute_map: HashMap<Uuid, MemberMuteRow> =
            mutes.into_iter().map(|m| (m.user_id, m)).collect();

        let rules: Vec<ChannelOverwriteRule> =
            overwrites.iter().map(ChannelOverwriteRule::from).collect();
        let now = Utc::now();
        let mut result = HashMap::with_capacity(target_users.len());

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
            result.insert(uid, perms);
        }

        result
    }

    async fn connected_all_channels_view_map(
        &self,
        community_id: Uuid,
        only_user_ids: Option<&[Uuid]>,
    ) -> HashMap<Uuid, HashSet<Uuid>> {
        if self.presence_mgr.is_none() {
            return HashMap::new();
        }
        let Ok(channels) = self.repo.list_channels(community_id).await else {
            return HashMap::new();
        };
        let mut view_map = HashMap::with_capacity(channels.len());
        for ch in channels {
            let overwrites = self
                .repo
                .list_channel_overwrites(ch.id)
                .await
                .unwrap_or_default();
            let perms_map = self
                .connected_channel_member_perms(community_id, &ch, &overwrites, only_user_ids)
                .await;
            let viewers: HashSet<Uuid> = perms_map
                .into_iter()
                .filter_map(|(uid, perms)| {
                    if has_permission(perms, PERM_VIEW_CHANNEL) {
                        Some(uid)
                    } else {
                        None
                    }
                })
                .collect();
            view_map.insert(ch.id, viewers);
        }
        view_map
    }

    async fn emit_revoked_for_lost_channels(
        &self,
        community_id: Uuid,
        before: HashMap<Uuid, HashSet<Uuid>>,
        after: HashMap<Uuid, HashSet<Uuid>>,
        reason: &str,
    ) {
        for (channel_id, before_users) in before {
            let after_users = after.get(&channel_id);
            for uid in before_users {
                let still_has_access = after_users.map_or(false, |set| set.contains(&uid));
                if !still_has_access {
                    self.emit_to_user(
                        uid,
                        GatewayEvent::new(
                            "community_access_revoked",
                            json!({
                                "community_id": community_id,
                                "channel_id": channel_id,
                                "reason": reason,
                            }),
                        ),
                    )
                    .await;
                }
            }
        }
    }

    async fn emit_to_user(&self, user_id: Uuid, event: GatewayEvent) {
        if let Some(ref pm) = self.presence_mgr {
            pm.send_critical_event(user_id, &event).await;
        }
    }

    async fn emit_to_users(&self, user_ids: &[Uuid], event: GatewayEvent) {
        if let Some(ref pm) = self.presence_mgr {
            pm.broadcast_to_users(user_ids, &event).await;
        }
    }

    async fn emit_to_community(&self, community_id: Uuid, event: GatewayEvent) {
        if self.presence_mgr.is_none() {
            return;
        }
        let recipients = self.connected_community_member_ids(community_id).await;
        self.emit_to_users(&recipients, event).await;
    }

    async fn emit_channel_event_authorized(
        &self,
        community_id: Uuid,
        channel: &CommunityChannel,
        event: GatewayEvent,
    ) {
        if self.presence_mgr.is_none() {
            return;
        }
        let overwrites = self
            .repo
            .list_channel_overwrites(channel.id)
            .await
            .unwrap_or_default();
        let perms_map = self
            .connected_channel_member_perms(community_id, channel, &overwrites, None)
            .await;
        let recipients: Vec<Uuid> = perms_map
            .into_iter()
            .filter_map(|(uid, perms)| {
                if has_permission(perms, PERM_VIEW_CHANNEL) {
                    Some(uid)
                } else {
                    None
                }
            })
            .collect();
        self.emit_to_users(&recipients, event).await;
    }

    async fn emit_channel_dto_authorized(
        &self,
        community_id: Uuid,
        channel: &CommunityChannel,
        overwrites: &[ChannelPermissionOverwrite],
        event_type: &str,
    ) {
        let Some(ref pm) = self.presence_mgr else {
            return;
        };
        let perms_map = self
            .connected_channel_member_perms(community_id, channel, overwrites, None)
            .await;
        if perms_map.is_empty() {
            return;
        }
        let ow_dtos: Vec<ChannelPermissionOverwriteDto> =
            overwrites.iter().cloned().map(Into::into).collect();
        for (uid, perms) in perms_map {
            if has_permission(perms, PERM_VIEW_CHANNEL) {
                let channel_dto = CommunityChannelDto::from_model(
                    channel.clone(),
                    perms,
                    0,
                    ow_dtos.clone(),
                );
                let event = GatewayEvent::new(
                    event_type,
                    json!({
                        "community_id": community_id,
                        "channel": channel_dto,
                    }),
                );
                pm.send_critical_event(uid, &event).await;
            }
        }
    }

    async fn load_actor_context(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
    ) -> Result<ActorContext, AppError> {
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

        let roles = self.repo.list_roles(community_id).await?;
        let everyone_role = roles.iter().find(|r| r.is_default);
        let everyone_role_id = everyone_role.map(|r| r.id);
        let everyone_permissions = everyone_role.map_or(0, |r| r.permissions_bitmask);

        let role_map: HashMap<Uuid, &CommunityRole> =
            roles.iter().map(|r| (r.id, r)).collect();
        let actor_role_ids = self.repo.list_member_role_ids(community_id, actor_id).await?;

        let mut actor_role_positions = Vec::with_capacity(actor_role_ids.len());
        let mut actor_role_permissions = Vec::with_capacity(actor_role_ids.len());
        for role_id in &actor_role_ids {
            if let Some(role) = role_map.get(role_id) {
                actor_role_positions.push(role.position);
                actor_role_permissions.push(role.permissions_bitmask);
            }
        }

        let actor_top_pos =
            compute_actor_top_position(actor_id, community.owner_id, &actor_role_positions);
        let actor_community_perms = resolve_community_permissions(
            actor_id,
            community.owner_id,
            true,
            false,
            everyone_permissions,
            &actor_role_permissions,
        );
        let actor_mute = self.repo.get_member_mute(community_id, actor_id).await?;
        let is_owner = actor_id == community.owner_id;

        Ok(ActorContext {
            community,
            roles,
            everyone_role_id,
            everyone_permissions,
            actor_role_ids,
            actor_role_permissions,
            actor_top_pos,
            actor_community_perms,
            actor_mute,
            is_owner,
        })
    }

    fn resolve_channel_perms_with_overwrites(
        &self,
        ctx: &ActorContext,
        actor_id: Uuid,
        channel: &CommunityChannel,
        overwrites: &[ChannelPermissionOverwrite],
    ) -> i64 {
        let rules: Vec<ChannelOverwriteRule> =
            overwrites.iter().map(ChannelOverwriteRule::from).collect();
        resolve_channel_permissions(&ResolveChannelPermissionsInput {
            actor_id,
            owner_id: ctx.community.owner_id,
            is_member: true,
            is_banned: false,
            everyone_role_id: ctx.everyone_role_id,
            everyone_permissions: ctx.everyone_permissions,
            member_role_ids: &ctx.actor_role_ids,
            member_role_permissions: &ctx.actor_role_permissions,
            is_private: channel.is_private,
            is_read_only: channel.is_read_only,
            overwrites: &rules,
            text_muted_until: ctx.actor_mute.as_ref().and_then(|m| m.text_muted_until),
            voice_muted_until: ctx.actor_mute.as_ref().and_then(|m| m.voice_muted_until),
            server_voice_muted: ctx
                .actor_mute
                .as_ref()
                .map_or(false, |m| m.server_voice_muted),
            now: Utc::now(),
        })
    }

    async fn resolve_actor_channel_perms(
        &self,
        ctx: &ActorContext,
        actor_id: Uuid,
        channel: &CommunityChannel,
    ) -> Result<(i64, Vec<ChannelPermissionOverwrite>), AppError> {
        let overwrites = self.repo.list_channel_overwrites(channel.id).await?;
        let perms = self.resolve_channel_perms_with_overwrites(ctx, actor_id, channel, &overwrites);
        Ok((perms, overwrites))
    }

    fn ensure_can_write_channel_message(
        ctx: &ActorContext,
        channel: &CommunityChannel,
        channel_perms: i64,
        action_verb: &str,
    ) -> Result<(), AppError> {
        if !has_permission(channel_perms, PERM_VIEW_CHANNEL) {
            return Err(AppError::Forbidden(
                "Você não possui acesso a este canal.".to_string(),
            ));
        }

        if !has_permission(channel_perms, PERM_SEND_MESSAGES) {
            let now = Utc::now();
            let is_text_muted = !ctx.is_owner
                && ctx
                    .actor_mute
                    .as_ref()
                    .and_then(|m| m.text_muted_until)
                    .map_or(false, |until| until > now);

            if is_text_muted {
                return Err(AppError::Forbidden(
                    "Você está silenciado em texto nesta comunidade.".to_string(),
                ));
            }
            if channel.is_read_only {
                return Err(AppError::Forbidden(
                    "Este canal é somente leitura.".to_string(),
                ));
            }
            return Err(AppError::Forbidden(format!(
                "Você não possui permissão para {} mensagens neste canal.",
                action_verb
            )));
        }

        Ok(())
    }

    async fn ensure_overwrite_target_hierarchy(
        &self,
        ctx: &ActorContext,
        actor_id: Uuid,
        target_type: &str,
        target_id: Uuid,
        require_target_exists: bool,
    ) -> Result<(), AppError> {
        match target_type {
            "role" => {
                let role = ctx.roles.iter().find(|r| r.id == target_id);
                let Some(role) = role else {
                    if require_target_exists {
                        return Err(AppError::BadRequest(
                            "O cargo alvo não pertence a esta comunidade.".to_string(),
                        ));
                    }
                    return Ok(());
                };

                if !ctx.is_owner && !role.is_default && role.position >= ctx.actor_top_pos {
                    return Err(AppError::Forbidden(
                        "Não é possível alterar sobrescritas de um cargo com posição igual ou superior à sua."
                            .to_string(),
                    ));
                }
                Ok(())
            }
            "user" => {
                if target_id == ctx.community.owner_id && !ctx.is_owner {
                    return Err(AppError::Forbidden(
                        "Não é possível alterar sobrescritas para o proprietário da comunidade."
                            .to_string(),
                    ));
                }

                let target_member = self.repo.get_member(ctx.community.id, target_id).await?;
                match target_member {
                    None if require_target_exists => Err(AppError::BadRequest(
                        "O usuário alvo não é membro desta comunidade.".to_string(),
                    )),
                    Some(member)
                        if !ctx.is_owner
                            && target_id != actor_id
                            && ctx.actor_top_pos <= member.highest_role_position =>
                    {
                        Err(AppError::Forbidden(
                            "Você não possui hierarquia suficiente para alterar sobrescritas deste membro."
                                .to_string(),
                        ))
                    }
                    _ => Ok(()),
                }
            }
            _ => Err(AppError::ValidationError(
                "Tipo de alvo inválido para sobrescrita. Valores permitidos: 'role', 'user'."
                    .to_string(),
            )),
        }
    }

    // ==========================================
    // Communities
    // ==========================================

    pub async fn create_community(
        &self,
        actor_id: Uuid,
        req: &CreateCommunityRequest,
    ) -> Result<CommunityDto, AppError> {
        req.validate()?;
        self.repo.create_community(actor_id, req).await
    }

    pub async fn list_communities(&self, actor_id: Uuid) -> Result<Vec<CommunityDto>, AppError> {
        self.repo.list_user_communities(actor_id).await
    }

    pub async fn get_snapshot(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
    ) -> Result<CommunitySnapshotDto, AppError> {
        self.repo.get_community_snapshot(community_id, actor_id).await
    }

    pub async fn update_community(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        req: &UpdateCommunityRequest,
    ) -> Result<CommunityDto, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MANAGE_COMMUNITY) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para editar esta comunidade.".to_string(),
            ));
        }

        let updated = self.repo.update_community(community_id, req).await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "community.update",
                "community",
                Some(community_id),
                None,
                json!({
                    "name": updated.name,
                    "privacy": updated.privacy,
                    "appearance_preset": updated.appearance_preset,
                }),
            )
            .await?;

        let dto = self
            .repo
            .get_community_dto(community_id, actor_id)
            .await?
            .ok_or_else(|| {
                AppError::InternalError(
                    "Falha ao carregar comunidade após atualização.".to_string(),
                )
            })?;

        self.emit_to_community(
            community_id,
            GatewayEvent::new("community_updated", json!({ "community": &dto })),
        )
        .await;

        Ok(dto)
    }

    pub async fn delete_community(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        req: &DeleteCommunityRequest,
    ) -> Result<(), AppError> {
        let community = self
            .repo
            .get_community_by_id(community_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Comunidade não encontrada.".to_string()))?;

        if community.owner_id != actor_id {
            return Err(AppError::Forbidden(
                "Apenas o proprietário pode excluir a comunidade.".to_string(),
            ));
        }

        req.validate_against(&community.name)?;

        let connected_members = self.connected_community_member_ids(community_id).await;

        let deleted = self.repo.delete_community(community_id).await?;
        if !deleted {
            return Err(AppError::NotFound("Comunidade não encontrada.".to_string()));
        }

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "community.delete",
                "community",
                Some(community_id),
                None,
                json!({ "name": community.name }),
            )
            .await?;

        self.emit_to_users(
            &connected_members,
            GatewayEvent::new(
                "community_deleted",
                json!({ "community_id": community_id }),
            ),
        )
        .await;

        Ok(())
    }

    pub async fn transfer_ownership(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        req: &TransferOwnershipRequest,
    ) -> Result<CommunityDto, AppError> {
        let community = self
            .repo
            .get_community_by_id(community_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Comunidade não encontrada.".to_string()))?;

        if community.owner_id != actor_id {
            return Err(AppError::Forbidden(
                "Apenas o proprietário atual pode transferir a propriedade da comunidade."
                    .to_string(),
            ));
        }

        req.validate_against(community.owner_id, &community.name)?;

        self.repo
            .transfer_ownership(community_id, actor_id, req.target_user_id)
            .await?;

        let dto = self
            .repo
            .get_community_dto(community_id, actor_id)
            .await?
            .ok_or_else(|| {
                AppError::InternalError(
                    "Falha ao carregar comunidade após transferência de propriedade.".to_string(),
                )
            })?;

        self.emit_to_community(
            community_id,
            GatewayEvent::new("community_updated", json!({ "community": &dto })),
        )
        .await;

        Ok(dto)
    }

    pub async fn leave_community(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
    ) -> Result<(), AppError> {
        let community = self
            .repo
            .get_community_by_id(community_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Comunidade não encontrada.".to_string()))?;

        if community.owner_id == actor_id {
            return Err(AppError::BadRequest(
                "O proprietário não pode sair da comunidade sem transferir a propriedade ou excluí-la antes."
                    .to_string(),
            ));
        }

        if !self.repo.is_member(community_id, actor_id).await? {
            return Err(AppError::Forbidden(
                "Você não é membro desta comunidade.".to_string(),
            ));
        }

        let removed = self.repo.remove_member(community_id, actor_id).await?;
        if !removed {
            return Err(AppError::NotFound(
                "Membro não encontrado na comunidade.".to_string(),
            ));
        }

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "member.leave",
                "user",
                Some(actor_id),
                None,
                json!({}),
            )
            .await?;

        self.emit_to_user(
            actor_id,
            GatewayEvent::new(
                "community_access_revoked",
                json!({
                    "community_id": community_id,
                    "channel_id": serde_json::Value::Null,
                    "reason": "left",
                }),
            ),
        )
        .await;
        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_member_left",
                json!({
                    "community_id": community_id,
                    "user_id": actor_id,
                }),
            ),
        )
        .await;

        Ok(())
    }

    // ==========================================
    // Categories
    // ==========================================

    pub async fn create_category(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        req: &CreateCategoryRequest,
    ) -> Result<CommunityCategoryDto, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MANAGE_CHANNELS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para criar categorias.".to_string(),
            ));
        }

        let category = self.repo.create_category(community_id, req).await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "category.create",
                "category",
                Some(category.id),
                None,
                json!({
                    "name": category.name,
                    "position": category.position,
                }),
            )
            .await?;

        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_category_updated",
                json!({ "community_id": community_id }),
            ),
        )
        .await;

        Ok(category.into())
    }

    pub async fn update_category(
        &self,
        community_id: Uuid,
        category_id: Uuid,
        actor_id: Uuid,
        req: &UpdateCategoryRequest,
    ) -> Result<CommunityCategoryDto, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MANAGE_CHANNELS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para editar categorias.".to_string(),
            ));
        }

        let updated = self
            .repo
            .update_category(community_id, category_id, req)
            .await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "category.update",
                "category",
                Some(updated.id),
                None,
                json!({
                    "name": updated.name,
                    "position": updated.position,
                }),
            )
            .await?;

        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_category_updated",
                json!({ "community_id": community_id }),
            ),
        )
        .await;

        Ok(updated.into())
    }

    pub async fn delete_category(
        &self,
        community_id: Uuid,
        category_id: Uuid,
        actor_id: Uuid,
    ) -> Result<(), AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MANAGE_CHANNELS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para excluir categorias.".to_string(),
            ));
        }

        let existing = self
            .repo
            .get_category(community_id, category_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Categoria não encontrada.".to_string()))?;

        let deleted = self.repo.delete_category(community_id, category_id).await?;
        if !deleted {
            return Err(AppError::NotFound("Categoria não encontrada.".to_string()));
        }

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "category.delete",
                "category",
                Some(category_id),
                None,
                json!({ "name": existing.name }),
            )
            .await?;

        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_category_updated",
                json!({ "community_id": community_id }),
            ),
        )
        .await;

        Ok(())
    }

    pub async fn reorder_categories(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        req: &ReorderCategoriesRequest,
    ) -> Result<Vec<CommunityCategoryDto>, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MANAGE_CHANNELS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para reordenar categorias.".to_string(),
            ));
        }

        let categories = self.repo.reorder_categories(community_id, req).await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "category.reorder",
                "community",
                Some(community_id),
                None,
                json!({ "count": req.items.len() }),
            )
            .await?;

        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_category_updated",
                json!({ "community_id": community_id }),
            ),
        )
        .await;

        Ok(categories.into_iter().map(Into::into).collect())
    }

    // ==========================================
    // Channels & Overwrites
    // ==========================================

    pub async fn create_channel(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        req: &CreateChannelRequest,
    ) -> Result<CommunityChannelDto, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MANAGE_CHANNELS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para criar canais.".to_string(),
            ));
        }

        let channel = self.repo.create_channel(community_id, req).await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "channel.create",
                "channel",
                Some(channel.id),
                None,
                json!({
                    "name": channel.name,
                    "channel_type": channel.channel_type,
                    "is_private": channel.is_private,
                    "is_read_only": channel.is_read_only,
                }),
            )
            .await?;

        let (perms, overwrites) = self
            .resolve_actor_channel_perms(&ctx, actor_id, &channel)
            .await?;

        self.emit_channel_dto_authorized(
            community_id,
            &channel,
            &overwrites,
            "community_channel_created",
        )
        .await;

        let ow_dtos = overwrites.into_iter().map(Into::into).collect();
        Ok(CommunityChannelDto::from_model(channel, perms, 0, ow_dtos))
    }

    pub async fn update_channel(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        actor_id: Uuid,
        req: &UpdateChannelRequest,
    ) -> Result<CommunityChannelDto, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MANAGE_CHANNELS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para editar canais.".to_string(),
            ));
        }

        let before_viewers: HashSet<Uuid> = if self.presence_mgr.is_some() {
            if let Ok(Some(prev_channel)) = self.repo.get_channel(community_id, channel_id).await {
                let prev_ow = self
                    .repo
                    .list_channel_overwrites(channel_id)
                    .await
                    .unwrap_or_default();
                self.connected_channel_member_perms(community_id, &prev_channel, &prev_ow, None)
                    .await
                    .into_iter()
                    .filter_map(|(uid, p)| has_permission(p, PERM_VIEW_CHANNEL).then_some(uid))
                    .collect()
            } else {
                HashSet::new()
            }
        } else {
            HashSet::new()
        };

        let updated = self
            .repo
            .update_channel(community_id, channel_id, req)
            .await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "channel.update",
                "channel",
                Some(updated.id),
                None,
                json!({
                    "name": updated.name,
                    "is_private": updated.is_private,
                    "is_read_only": updated.is_read_only,
                }),
            )
            .await?;

        let (perms, overwrites) = self
            .resolve_actor_channel_perms(&ctx, actor_id, &updated)
            .await?;

        if self.presence_mgr.is_some() {
            let after_perms = self
                .connected_channel_member_perms(community_id, &updated, &overwrites, None)
                .await;
            for uid in &before_viewers {
                let still_views = after_perms
                    .get(uid)
                    .map_or(false, |p| has_permission(*p, PERM_VIEW_CHANNEL));
                if !still_views {
                    self.emit_to_user(
                        *uid,
                        GatewayEvent::new(
                            "community_access_revoked",
                            json!({
                                "community_id": community_id,
                                "channel_id": channel_id,
                                "reason": "channel_access_revoked",
                            }),
                        ),
                    )
                    .await;
                }
            }
            self.emit_channel_dto_authorized(
                community_id,
                &updated,
                &overwrites,
                "community_channel_updated",
            )
            .await;
        }

        let ow_dtos = overwrites.into_iter().map(Into::into).collect();
        Ok(CommunityChannelDto::from_model(updated, perms, 0, ow_dtos))
    }

    pub async fn delete_channel(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        actor_id: Uuid,
    ) -> Result<(), AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MANAGE_CHANNELS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para excluir canais.".to_string(),
            ));
        }

        let existing = self
            .repo
            .get_channel(community_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Canal não encontrado nesta comunidade.".to_string()))?;

        let authorized_viewers: Vec<Uuid> = if self.presence_mgr.is_some() {
            let ow = self
                .repo
                .list_channel_overwrites(channel_id)
                .await
                .unwrap_or_default();
            self.connected_channel_member_perms(community_id, &existing, &ow, None)
                .await
                .into_iter()
                .filter_map(|(uid, p)| has_permission(p, PERM_VIEW_CHANNEL).then_some(uid))
                .collect()
        } else {
            Vec::new()
        };

        let deleted = self.repo.delete_channel(community_id, channel_id).await?;
        if !deleted {
            return Err(AppError::NotFound(
                "Canal não encontrado nesta comunidade.".to_string(),
            ));
        }

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "channel.delete",
                "channel",
                Some(channel_id),
                None,
                json!({ "name": existing.name }),
            )
            .await?;

        self.emit_to_users(
            &authorized_viewers,
            GatewayEvent::new(
                "community_channel_deleted",
                json!({
                    "community_id": community_id,
                    "channel_id": channel_id,
                }),
            ),
        )
        .await;

        Ok(())
    }

    pub async fn reorder_channels(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        req: &ReorderChannelsRequest,
    ) -> Result<Vec<CommunityChannelDto>, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MANAGE_CHANNELS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para reordenar canais.".to_string(),
            ));
        }

        let channels = self.repo.reorder_channels(community_id, req).await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "channel.reorder",
                "community",
                Some(community_id),
                None,
                json!({ "count": req.items.len() }),
            )
            .await?;

        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_category_updated",
                json!({ "community_id": community_id }),
            ),
        )
        .await;

        let mut dtos = Vec::with_capacity(channels.len());
        for ch in channels {
            let (perms, overwrites) = self.resolve_actor_channel_perms(&ctx, actor_id, &ch).await?;
            if has_permission(perms, PERM_VIEW_CHANNEL) {
                let ow_dtos = overwrites.into_iter().map(Into::into).collect();
                dtos.push(CommunityChannelDto::from_model(ch, perms, 0, ow_dtos));
            }
        }

        Ok(dtos)
    }

    pub async fn list_channel_overwrites(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        actor_id: Uuid,
    ) -> Result<Vec<ChannelPermissionOverwriteDto>, AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;
        let channel = self
            .repo
            .get_channel(community_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Canal não encontrado nesta comunidade.".to_string()))?;

        let (perms, overwrites) = self
            .resolve_actor_channel_perms(&ctx, actor_id, &channel)
            .await?;

        let can_manage = (ctx.actor_community_perms
            & (PERM_MANAGE_CHANNELS | PERM_MANAGE_ROLES | PERM_ADMINISTRATOR))
            != 0;
        if !can_manage && !has_permission(perms, PERM_VIEW_CHANNEL) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para visualizar sobrescritas deste canal.".to_string(),
            ));
        }

        Ok(overwrites.into_iter().map(Into::into).collect())
    }

    pub async fn upsert_channel_overwrite(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        actor_id: Uuid,
        req: &UpsertChannelOverwriteRequest,
    ) -> Result<ChannelPermissionOverwriteDto, AppError> {
        req.validate()?;
        let (allow_bitmask, deny_bitmask) = req.resolve_masks()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        let channel = self
            .repo
            .get_channel(community_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Canal não encontrado nesta comunidade.".to_string()))?;

        ensure_can_manage_channel_overwrite(
            actor_id,
            ctx.community.owner_id,
            ctx.actor_community_perms,
            allow_bitmask,
            deny_bitmask,
        )?;

        self.ensure_overwrite_target_hierarchy(
            &ctx,
            actor_id,
            req.target_type.trim(),
            req.target_id,
            true,
        )
        .await?;

        let before_viewers: HashSet<Uuid> = if self.presence_mgr.is_some() {
            let prev_ow = self
                .repo
                .list_channel_overwrites(channel_id)
                .await
                .unwrap_or_default();
            self.connected_channel_member_perms(community_id, &channel, &prev_ow, None)
                .await
                .into_iter()
                .filter_map(|(uid, p)| has_permission(p, PERM_VIEW_CHANNEL).then_some(uid))
                .collect()
        } else {
            HashSet::new()
        };

        let overwrite = self
            .repo
            .upsert_channel_overwrite(community_id, channel_id, req)
            .await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "channel.overwrite.upsert",
                "channel",
                Some(channel_id),
                None,
                json!({
                    "target_type": overwrite.target_type,
                    "target_id": overwrite.target_id,
                    "allow_bitmask": overwrite.allow_bitmask.to_string(),
                    "deny_bitmask": overwrite.deny_bitmask.to_string(),
                }),
            )
            .await?;

        if self.presence_mgr.is_some() {
            let updated_ow = self
                .repo
                .list_channel_overwrites(channel_id)
                .await
                .unwrap_or_default();
            let after_perms = self
                .connected_channel_member_perms(community_id, &channel, &updated_ow, None)
                .await;
            for uid in &before_viewers {
                let still_views = after_perms
                    .get(uid)
                    .map_or(false, |p| has_permission(*p, PERM_VIEW_CHANNEL));
                if !still_views {
                    self.emit_to_user(
                        *uid,
                        GatewayEvent::new(
                            "community_access_revoked",
                            json!({
                                "community_id": community_id,
                                "channel_id": channel_id,
                                "reason": "overwrite_updated",
                            }),
                        ),
                    )
                    .await;
                }
            }
            self.emit_channel_dto_authorized(
                community_id,
                &channel,
                &updated_ow,
                "community_channel_updated",
            )
            .await;
        }

        Ok(overwrite.into())
    }

    pub async fn delete_channel_overwrite(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        actor_id: Uuid,
        target_type: &str,
        target_id: Uuid,
    ) -> Result<(), AppError> {
        let clean_type = target_type.trim();
        validate_overwrite_target_type(clean_type)?;

        let ctx = self.load_actor_context(community_id, actor_id).await?;
        let channel = self
            .repo
            .get_channel(community_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Canal não encontrado nesta comunidade.".to_string()))?;

        ensure_can_manage_channel_overwrite(
            actor_id,
            ctx.community.owner_id,
            ctx.actor_community_perms,
            0,
            0,
        )?;

        self.ensure_overwrite_target_hierarchy(&ctx, actor_id, clean_type, target_id, false)
            .await?;

        let before_viewers: HashSet<Uuid> = if self.presence_mgr.is_some() {
            let prev_ow = self
                .repo
                .list_channel_overwrites(channel_id)
                .await
                .unwrap_or_default();
            self.connected_channel_member_perms(community_id, &channel, &prev_ow, None)
                .await
                .into_iter()
                .filter_map(|(uid, p)| has_permission(p, PERM_VIEW_CHANNEL).then_some(uid))
                .collect()
        } else {
            HashSet::new()
        };

        let deleted = self
            .repo
            .delete_channel_overwrite(community_id, channel_id, clean_type, target_id)
            .await?;

        if !deleted {
            return Err(AppError::NotFound(
                "Sobrescrita de permissão não encontrada.".to_string(),
            ));
        }

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "channel.overwrite.delete",
                "channel",
                Some(channel_id),
                None,
                json!({
                    "target_type": clean_type,
                    "target_id": target_id,
                }),
            )
            .await?;

        if self.presence_mgr.is_some() {
            let updated_ow = self
                .repo
                .list_channel_overwrites(channel_id)
                .await
                .unwrap_or_default();
            let after_perms = self
                .connected_channel_member_perms(community_id, &channel, &updated_ow, None)
                .await;
            for uid in &before_viewers {
                let still_views = after_perms
                    .get(uid)
                    .map_or(false, |p| has_permission(*p, PERM_VIEW_CHANNEL));
                if !still_views {
                    self.emit_to_user(
                        *uid,
                        GatewayEvent::new(
                            "community_access_revoked",
                            json!({
                                "community_id": community_id,
                                "channel_id": channel_id,
                                "reason": "overwrite_updated",
                            }),
                        ),
                    )
                    .await;
                }
            }
            self.emit_channel_dto_authorized(
                community_id,
                &channel,
                &updated_ow,
                "community_channel_updated",
            )
            .await;
        }

        Ok(())
    }

    // ==========================================
    // Messages & Read States
    // ==========================================

    pub async fn list_channel_messages(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        actor_id: Uuid,
        query: &ChannelMessagesQuery,
    ) -> Result<ChannelMessagesPageDto, AppError> {
        query.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;
        let channel = self
            .repo
            .get_channel(community_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Canal não encontrado nesta comunidade.".to_string()))?;

        let (perms, _) = self
            .resolve_actor_channel_perms(&ctx, actor_id, &channel)
            .await?;

        if !has_permission(perms, PERM_VIEW_CHANNEL | PERM_READ_MESSAGE_HISTORY) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para ler o histórico deste canal.".to_string(),
            ));
        }

        self.repo
            .list_channel_messages(channel_id, actor_id, query)
            .await
    }

    pub async fn send_channel_message(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        actor_id: Uuid,
        req: &SendChannelMessageRequest,
    ) -> Result<ChannelMessageDto, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;
        let channel = self
            .repo
            .get_channel(community_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Canal não encontrado nesta comunidade.".to_string()))?;

        let (perms, _) = self
            .resolve_actor_channel_perms(&ctx, actor_id, &channel)
            .await?;
        Self::ensure_can_write_channel_message(&ctx, &channel, perms, "enviar")?;

        let (dto, is_new) = self
            .repo
            .send_channel_message(community_id, channel_id, actor_id, req)
            .await?;

        if is_new {
            self.emit_channel_event_authorized(
                community_id,
                &channel,
                GatewayEvent::new(
                    "community_message_created",
                    json!({
                        "community_id": community_id,
                        "channel_id": channel_id,
                        "message": &dto,
                    }),
                ),
            )
            .await;
        }

        Ok(dto)
    }

    pub async fn edit_channel_message(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        message_id: Uuid,
        actor_id: Uuid,
        req: &EditChannelMessageRequest,
    ) -> Result<ChannelMessageDto, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;
        let channel = self
            .repo
            .get_channel(community_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Canal não encontrado nesta comunidade.".to_string()))?;

        let (perms, _) = self
            .resolve_actor_channel_perms(&ctx, actor_id, &channel)
            .await?;
        Self::ensure_can_write_channel_message(&ctx, &channel, perms, "editar")?;

        let dto = self
            .repo
            .edit_channel_message(channel_id, message_id, actor_id, req)
            .await?;

        self.emit_channel_event_authorized(
            community_id,
            &channel,
            GatewayEvent::new(
                "community_message_updated",
                json!({
                    "community_id": community_id,
                    "channel_id": channel_id,
                    "message": &dto,
                }),
            ),
        )
        .await;

        Ok(dto)
    }

    pub async fn delete_channel_message(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        message_id: Uuid,
        actor_id: Uuid,
    ) -> Result<(), AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;
        let channel = self
            .repo
            .get_channel(community_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Canal não encontrado nesta comunidade.".to_string()))?;

        let (perms, _) = self
            .resolve_actor_channel_perms(&ctx, actor_id, &channel)
            .await?;

        if !has_permission(perms, PERM_VIEW_CHANNEL) {
            return Err(AppError::Forbidden(
                "Você não possui acesso a este canal.".to_string(),
            ));
        }

        let msg = self
            .repo
            .get_channel_message(channel_id, message_id, actor_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Mensagem não encontrada.".to_string()))?;

        if msg.sender_id != actor_id {
            if !has_permission(perms, PERM_MANAGE_MESSAGES) {
                return Err(AppError::Forbidden(
                    "Você não possui permissão para excluir mensagens de outros membros."
                        .to_string(),
                ));
            }

            if !ctx.is_owner {
                if msg.sender_id == ctx.community.owner_id {
                    return Err(AppError::Forbidden(
                        "Não é possível excluir mensagens do proprietário da comunidade."
                            .to_string(),
                    ));
                }

                if let Some(author_member) =
                    self.repo.get_member(community_id, msg.sender_id).await?
                {
                    if ctx.actor_top_pos <= author_member.highest_role_position {
                        return Err(AppError::Forbidden(
                            "Você não possui hierarquia suficiente para excluir mensagens deste membro."
                                .to_string(),
                        ));
                    }
                }
            }
        }

        let deleted = self
            .repo
            .soft_delete_channel_message(channel_id, message_id)
            .await?;
        if !deleted {
            return Err(AppError::NotFound("Mensagem não encontrada.".to_string()));
        }

        if msg.sender_id != actor_id {
            self.repo
                .insert_audit_log(
                    community_id,
                    actor_id,
                    "message.delete",
                    "message",
                    Some(message_id),
                    None,
                    json!({
                        "channel_id": channel_id,
                        "author_id": msg.sender_id,
                    }),
                )
                .await?;
        }

        self.emit_channel_event_authorized(
            community_id,
            &channel,
            GatewayEvent::new(
                "community_message_deleted",
                json!({
                    "community_id": community_id,
                    "channel_id": channel_id,
                    "message_id": message_id,
                }),
            ),
        )
        .await;

        Ok(())
    }

    pub async fn mark_channel_read(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        actor_id: Uuid,
        req: &MarkChannelReadRequest,
    ) -> Result<ChannelReadStateDto, AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;
        let channel = self
            .repo
            .get_channel(community_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Canal não encontrado nesta comunidade.".to_string()))?;

        let (perms, _) = self
            .resolve_actor_channel_perms(&ctx, actor_id, &channel)
            .await?;

        if !has_permission(perms, PERM_VIEW_CHANNEL) {
            return Err(AppError::Forbidden(
                "Você não possui acesso a este canal.".to_string(),
            ));
        }

        self.repo
            .mark_channel_read(channel_id, actor_id, req.last_read_message_id)
            .await
    }

    // ==========================================
    // Roles & Members
    // ==========================================

    pub async fn list_roles(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
    ) -> Result<Vec<CommunityRoleDto>, AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;
        Ok(ctx.roles.into_iter().map(Into::into).collect())
    }

    pub async fn create_role(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        req: &CreateRoleRequest,
    ) -> Result<CommunityRoleDto, AppError> {
        req.validate()?;
        let requested_perms = req.resolve_permissions()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        // When non-owners omit position, place the role below actor_top_pos instead of above max_pos.
        let mut effective_req = req.clone();
        if effective_req.position.is_none() && !ctx.is_owner {
            let safe_pos = if ctx.actor_top_pos > 1 {
                ctx.actor_top_pos - 1
            } else {
                1
            };
            effective_req.position = Some(safe_pos);
        }

        ensure_can_manage_role(
            actor_id,
            ctx.community.owner_id,
            ctx.actor_top_pos,
            ctx.actor_community_perms,
            None,
            effective_req.position,
            Some(requested_perms),
            false,
        )?;

        let role = self.repo.create_role(community_id, &effective_req).await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "role.create",
                "role",
                Some(role.id),
                None,
                json!({
                    "name": role.name,
                    "position": role.position,
                    "permissions_bitmask": role.permissions_bitmask.to_string(),
                }),
            )
            .await?;

        let role_dto: CommunityRoleDto = role.into();
        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_role_updated",
                json!({
                    "community_id": community_id,
                    "action": "created",
                    "role": &role_dto,
                }),
            ),
        )
        .await;

        Ok(role_dto)
    }

    pub async fn update_role(
        &self,
        community_id: Uuid,
        role_id: Uuid,
        actor_id: Uuid,
        req: &UpdateRoleRequest,
    ) -> Result<CommunityRoleDto, AppError> {
        req.validate()?;
        let requested_perms = req.resolve_permissions()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        let target_role = ctx
            .roles
            .iter()
            .find(|r| r.id == role_id)
            .ok_or_else(|| AppError::NotFound("Cargo não encontrado.".to_string()))?;

        ensure_can_manage_role(
            actor_id,
            ctx.community.owner_id,
            ctx.actor_top_pos,
            ctx.actor_community_perms,
            Some(target_role.position),
            req.position,
            requested_perms,
            target_role.is_default,
        )?;

        let before_views = self
            .connected_all_channels_view_map(community_id, None)
            .await;

        let updated = self.repo.update_role(community_id, role_id, req).await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "role.update",
                "role",
                Some(updated.id),
                None,
                json!({
                    "name": updated.name,
                    "position": updated.position,
                    "permissions_bitmask": updated.permissions_bitmask.to_string(),
                }),
            )
            .await?;

        if self.presence_mgr.is_some() {
            let after_views = self
                .connected_all_channels_view_map(community_id, None)
                .await;
            self.emit_revoked_for_lost_channels(
                community_id,
                before_views,
                after_views,
                "role_updated",
            )
            .await;
        }

        let role_dto: CommunityRoleDto = updated.into();
        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_role_updated",
                json!({
                    "community_id": community_id,
                    "action": "updated",
                    "role": &role_dto,
                }),
            ),
        )
        .await;

        Ok(role_dto)
    }

    pub async fn delete_role(
        &self,
        community_id: Uuid,
        role_id: Uuid,
        actor_id: Uuid,
    ) -> Result<(), AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        let target_role = ctx
            .roles
            .iter()
            .find(|r| r.id == role_id)
            .ok_or_else(|| AppError::NotFound("Cargo não encontrado.".to_string()))?
            .clone();

        ensure_can_delete_role(
            actor_id,
            ctx.community.owner_id,
            ctx.actor_top_pos,
            ctx.actor_community_perms,
            target_role.position,
            target_role.is_default,
        )?;

        let before_views = self
            .connected_all_channels_view_map(community_id, None)
            .await;

        let deleted = self.repo.delete_role(community_id, role_id).await?;
        if !deleted {
            return Err(AppError::NotFound("Cargo não encontrado.".to_string()));
        }

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "role.delete",
                "role",
                Some(role_id),
                None,
                json!({ "name": target_role.name }),
            )
            .await?;

        if self.presence_mgr.is_some() {
            let after_views = self
                .connected_all_channels_view_map(community_id, None)
                .await;
            self.emit_revoked_for_lost_channels(
                community_id,
                before_views,
                after_views,
                "role_updated",
            )
            .await;
        }

        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_role_updated",
                json!({
                    "community_id": community_id,
                    "action": "deleted",
                    "role_id": role_id,
                }),
            ),
        )
        .await;

        Ok(())
    }

    pub async fn reorder_roles(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        req: &ReorderRolesRequest,
    ) -> Result<Vec<CommunityRoleDto>, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        let role_map: HashMap<Uuid, &CommunityRole> =
            ctx.roles.iter().map(|r| (r.id, r)).collect();

        for item in &req.items {
            let role = role_map.get(&item.id).ok_or_else(|| {
                AppError::BadRequest("Um ou mais cargos não pertencem a esta comunidade.".to_string())
            })?;

            ensure_can_manage_role(
                actor_id,
                ctx.community.owner_id,
                ctx.actor_top_pos,
                ctx.actor_community_perms,
                Some(role.position),
                Some(item.position),
                None,
                role.is_default,
            )?;
        }

        let roles = self.repo.reorder_roles(community_id, req).await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "role.reorder",
                "community",
                Some(community_id),
                None,
                json!({ "count": req.items.len() }),
            )
            .await?;

        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_role_updated",
                json!({
                    "community_id": community_id,
                    "action": "reordered",
                }),
            ),
        )
        .await;

        Ok(roles.into_iter().map(Into::into).collect())
    }

    pub async fn list_members(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
    ) -> Result<Vec<CommunityMemberDto>, AppError> {
        let _ctx = self.load_actor_context(community_id, actor_id).await?;
        self.repo.list_members_with_roles(community_id).await
    }

    pub async fn update_member(
        &self,
        community_id: Uuid,
        target_user_id: Uuid,
        actor_id: Uuid,
        req: &UpdateMemberRequest,
    ) -> Result<CommunityMemberDto, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        let target_member = self
            .repo
            .get_member(community_id, target_user_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Membro não encontrado na comunidade.".to_string()))?;

        if req.nickname.is_some() && target_user_id != actor_id {
            if !has_permission(ctx.actor_community_perms, PERM_MODERATE_MEMBERS) {
                return Err(AppError::Forbidden(
                    "Você não possui permissão para alterar o apelido de outros membros."
                        .to_string(),
                ));
            }

            ensure_can_moderate_member(
                actor_id,
                ctx.community.owner_id,
                ctx.actor_top_pos,
                target_user_id,
                target_member.highest_role_position,
            )?;
        }

        if let Some(ref desired_role_ids) = req.role_ids {
            if !ctx.is_owner && !has_permission(ctx.actor_community_perms, PERM_MANAGE_ROLES) {
                return Err(AppError::Forbidden(
                    "Você não possui permissão para gerenciar cargos de membros.".to_string(),
                ));
            }

            if !ctx.is_owner && target_user_id == ctx.community.owner_id {
                return Err(AppError::Forbidden(
                    "Não é possível alterar os cargos do proprietário da comunidade.".to_string(),
                ));
            }

            let target_effective_top_pos = if target_user_id == ctx.community.owner_id {
                i32::MAX
            } else {
                target_member.highest_role_position
            };

            if !ctx.is_owner && ctx.actor_top_pos <= target_effective_top_pos {
                return Err(AppError::Forbidden(
                    "Você não possui hierarquia suficiente para alterar os cargos deste membro."
                        .to_string(),
                ));
            }

            let role_map: HashMap<Uuid, &CommunityRole> =
                ctx.roles.iter().map(|r| (r.id, r)).collect();
            let current_ids: HashSet<Uuid> = target_member.roles.iter().map(|r| r.id).collect();
            let desired_ids: HashSet<Uuid> = desired_role_ids.iter().copied().collect();

            // Validate all requested roles and all roles being added or removed.
            for role_id in desired_ids.union(&current_ids) {
                let role = role_map.get(role_id).ok_or_else(|| {
                    AppError::BadRequest(
                        "Um ou mais cargos não pertencem a esta comunidade.".to_string(),
                    )
                })?;

                ensure_can_assign_role(
                    actor_id,
                    ctx.community.owner_id,
                    ctx.actor_top_pos,
                    target_effective_top_pos,
                    role.position,
                    role.permissions_bitmask,
                    ctx.actor_community_perms,
                    role.is_default,
                )?;
            }
        }

        let before_views = if req.role_ids.is_some() && self.presence_mgr.is_some() {
            self.connected_all_channels_view_map(community_id, Some(&[target_user_id]))
                .await
        } else {
            HashMap::new()
        };

        let updated = self
            .repo
            .update_member(community_id, target_user_id, actor_id, req)
            .await?;

        if let Some(ref nick) = req.nickname {
            self.repo
                .insert_audit_log(
                    community_id,
                    actor_id,
                    "member.nickname.update",
                    "user",
                    Some(target_user_id),
                    None,
                    json!({ "nickname": nick }),
                )
                .await?;
        }

        if let Some(ref role_ids) = req.role_ids {
            self.repo
                .insert_audit_log(
                    community_id,
                    actor_id,
                    "member.roles.set",
                    "user",
                    Some(target_user_id),
                    None,
                    json!({ "role_ids": role_ids }),
                )
                .await?;

            if self.presence_mgr.is_some() {
                let after_views = self
                    .connected_all_channels_view_map(community_id, Some(&[target_user_id]))
                    .await;
                self.emit_revoked_for_lost_channels(
                    community_id,
                    before_views,
                    after_views,
                    "role_updated",
                )
                .await;
            }
        }

        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_member_updated",
                json!({
                    "community_id": community_id,
                    "member": &updated,
                }),
            ),
        )
        .await;

        Ok(updated)
    }

    pub async fn set_member_roles(
        &self,
        community_id: Uuid,
        target_user_id: Uuid,
        actor_id: Uuid,
        role_ids: &[Uuid],
    ) -> Result<CommunityMemberDto, AppError> {
        let req = UpdateMemberRequest {
            nickname: None,
            role_ids: Some(role_ids.to_vec()),
        };
        self.update_member(community_id, target_user_id, actor_id, &req)
            .await
    }

    fn ensure_member_role_change_allowed(
        ctx: &ActorContext,
        actor_id: Uuid,
        target_user_id: Uuid,
        target_member_top_pos: i32,
        role: &CommunityRole,
    ) -> Result<(), AppError> {
        if !ctx.is_owner && target_user_id == ctx.community.owner_id {
            return Err(AppError::Forbidden(
                "Não é possível alterar os cargos do proprietário da comunidade.".to_string(),
            ));
        }

        let target_effective_top_pos = if target_user_id == ctx.community.owner_id {
            i32::MAX
        } else {
            target_member_top_pos
        };

        ensure_can_assign_role(
            actor_id,
            ctx.community.owner_id,
            ctx.actor_top_pos,
            target_effective_top_pos,
            role.position,
            role.permissions_bitmask,
            ctx.actor_community_perms,
            role.is_default,
        )
    }

    pub async fn add_member_role(
        &self,
        community_id: Uuid,
        target_user_id: Uuid,
        role_id: Uuid,
        actor_id: Uuid,
    ) -> Result<CommunityMemberDto, AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        let target_member = self
            .repo
            .get_member(community_id, target_user_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Membro não encontrado na comunidade.".to_string()))?;

        let role = ctx
            .roles
            .iter()
            .find(|r| r.id == role_id)
            .ok_or_else(|| AppError::NotFound("Cargo não encontrado nesta comunidade.".to_string()))?;

        Self::ensure_member_role_change_allowed(
            &ctx,
            actor_id,
            target_user_id,
            target_member.highest_role_position,
            role,
        )?;

        let before_views = if self.presence_mgr.is_some() {
            self.connected_all_channels_view_map(community_id, Some(&[target_user_id]))
                .await
        } else {
            HashMap::new()
        };

        let added = self
            .repo
            .add_member_role(community_id, target_user_id, role_id, Some(actor_id))
            .await?;

        if added {
            self.repo
                .insert_audit_log(
                    community_id,
                    actor_id,
                    "member.role.add",
                    "user",
                    Some(target_user_id),
                    None,
                    json!({
                        "role_id": role_id,
                        "role_name": role.name,
                    }),
                )
                .await?;
        }

        let member = self
            .repo
            .get_member(community_id, target_user_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Membro não encontrado na comunidade.".to_string()))?;

        if added {
            if self.presence_mgr.is_some() {
                let after_views = self
                    .connected_all_channels_view_map(community_id, Some(&[target_user_id]))
                    .await;
                self.emit_revoked_for_lost_channels(
                    community_id,
                    before_views,
                    after_views,
                    "role_updated",
                )
                .await;
            }
            self.emit_to_community(
                community_id,
                GatewayEvent::new(
                    "community_member_updated",
                    json!({
                        "community_id": community_id,
                        "member": &member,
                    }),
                ),
            )
            .await;
        }

        Ok(member)
    }

    pub async fn remove_member_role(
        &self,
        community_id: Uuid,
        target_user_id: Uuid,
        role_id: Uuid,
        actor_id: Uuid,
    ) -> Result<CommunityMemberDto, AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        let target_member = self
            .repo
            .get_member(community_id, target_user_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Membro não encontrado na comunidade.".to_string()))?;

        let role = ctx
            .roles
            .iter()
            .find(|r| r.id == role_id)
            .ok_or_else(|| AppError::NotFound("Cargo não encontrado nesta comunidade.".to_string()))?;

        Self::ensure_member_role_change_allowed(
            &ctx,
            actor_id,
            target_user_id,
            target_member.highest_role_position,
            role,
        )?;

        let before_views = if self.presence_mgr.is_some() {
            self.connected_all_channels_view_map(community_id, Some(&[target_user_id]))
                .await
        } else {
            HashMap::new()
        };

        let removed = self
            .repo
            .remove_member_role(community_id, target_user_id, role_id)
            .await?;

        if removed {
            self.repo
                .insert_audit_log(
                    community_id,
                    actor_id,
                    "member.role.remove",
                    "user",
                    Some(target_user_id),
                    None,
                    json!({
                        "role_id": role_id,
                        "role_name": role.name,
                    }),
                )
                .await?;
        }

        let member = self
            .repo
            .get_member(community_id, target_user_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Membro não encontrado na comunidade.".to_string()))?;

        if removed {
            if self.presence_mgr.is_some() {
                let after_views = self
                    .connected_all_channels_view_map(community_id, Some(&[target_user_id]))
                    .await;
                self.emit_revoked_for_lost_channels(
                    community_id,
                    before_views,
                    after_views,
                    "role_updated",
                )
                .await;
            }
            self.emit_to_community(
                community_id,
                GatewayEvent::new(
                    "community_member_updated",
                    json!({
                        "community_id": community_id,
                        "member": &member,
                    }),
                ),
            )
            .await;
        }

        Ok(member)
    }

    // ==========================================
    // Moderation & Audit Logs
    // ==========================================

    pub async fn kick_member(
        &self,
        community_id: Uuid,
        target_user_id: Uuid,
        actor_id: Uuid,
        req: &KickMemberRequest,
    ) -> Result<(), AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MODERATE_MEMBERS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para expulsar membros.".to_string(),
            ));
        }

        let target_member = self
            .repo
            .get_member(community_id, target_user_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Membro não encontrado na comunidade.".to_string()))?;

        ensure_can_moderate_member(
            actor_id,
            ctx.community.owner_id,
            ctx.actor_top_pos,
            target_user_id,
            target_member.highest_role_position,
        )?;

        self.repo
            .kick_member(community_id, actor_id, target_user_id, req)
            .await?;

        self.emit_to_user(
            target_user_id,
            GatewayEvent::new(
                "community_access_revoked",
                json!({
                    "community_id": community_id,
                    "channel_id": serde_json::Value::Null,
                    "reason": "kicked",
                }),
            ),
        )
        .await;
        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_member_left",
                json!({
                    "community_id": community_id,
                    "user_id": target_user_id,
                }),
            ),
        )
        .await;

        Ok(())
    }

    pub async fn ban_member(
        &self,
        community_id: Uuid,
        target_user_id: Uuid,
        actor_id: Uuid,
        req: &BanMemberRequest,
    ) -> Result<CommunityBan, AppError> {
        req.validate_with_now(Utc::now())?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MODERATE_MEMBERS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para banir membros.".to_string(),
            ));
        }

        let target_top_pos = self
            .repo
            .get_member(community_id, target_user_id)
            .await?
            .map_or(0, |m| m.highest_role_position);

        ensure_can_moderate_member(
            actor_id,
            ctx.community.owner_id,
            ctx.actor_top_pos,
            target_user_id,
            target_top_pos,
        )?;

        let ban = self
            .repo
            .ban_member(community_id, actor_id, target_user_id, req)
            .await?;

        self.emit_to_user(
            target_user_id,
            GatewayEvent::new(
                "community_access_revoked",
                json!({
                    "community_id": community_id,
                    "channel_id": serde_json::Value::Null,
                    "reason": "banned",
                }),
            ),
        )
        .await;
        self.emit_to_community(
            community_id,
            GatewayEvent::new(
                "community_member_left",
                json!({
                    "community_id": community_id,
                    "user_id": target_user_id,
                }),
            ),
        )
        .await;

        Ok(ban)
    }

    pub async fn unban_member(
        &self,
        community_id: Uuid,
        target_user_id: Uuid,
        actor_id: Uuid,
    ) -> Result<(), AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MODERATE_MEMBERS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para revogar banimentos.".to_string(),
            ));
        }

        let unbanned = self
            .repo
            .unban_member(community_id, actor_id, target_user_id)
            .await?;

        if !unbanned {
            return Err(AppError::NotFound(
                "Banimento não encontrado para este usuário.".to_string(),
            ));
        }

        Ok(())
    }

    pub async fn list_bans(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
    ) -> Result<Vec<CommunityBanDto>, AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if !has_permission(ctx.actor_community_perms, PERM_MODERATE_MEMBERS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para visualizar banimentos.".to_string(),
            ));
        }

        self.repo.list_bans(community_id).await
    }

    pub async fn mute_member(
        &self,
        community_id: Uuid,
        target_user_id: Uuid,
        actor_id: Uuid,
        req: &MuteMemberRequest,
    ) -> Result<CommunityMemberMuteDto, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        let modifies_text = req.text_muted_until.is_some();
        let modifies_voice = req.voice_muted_until.is_some() || req.server_voice_muted.is_some();

        if modifies_text && !has_permission(ctx.actor_community_perms, PERM_MODERATE_MEMBERS) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para silenciar membros em texto.".to_string(),
            ));
        }

        let can_mute_voice = (ctx.actor_community_perms
            & (PERM_MODERATE_MEMBERS | PERM_MUTE_MEMBERS_VOICE | PERM_ADMINISTRATOR))
            != 0;
        if (modifies_voice || !modifies_text) && !can_mute_voice {
            return Err(AppError::Forbidden(
                "Você não possui permissão para silenciar membros.".to_string(),
            ));
        }

        let target_member = self
            .repo
            .get_member(community_id, target_user_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Membro não encontrado na comunidade.".to_string()))?;

        ensure_can_moderate_member(
            actor_id,
            ctx.community.owner_id,
            ctx.actor_top_pos,
            target_user_id,
            target_member.highest_role_position,
        )?;

        let mute = self
            .repo
            .upsert_member_mute(community_id, target_user_id, actor_id, req)
            .await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "member.mute",
                "user",
                Some(target_user_id),
                req.reason.as_deref(),
                json!({
                    "text_muted_until": mute.text_muted_until,
                    "voice_muted_until": mute.voice_muted_until,
                    "server_voice_muted": mute.server_voice_muted,
                }),
            )
            .await?;

        if self.presence_mgr.is_some() {
            if let Ok(Some(member)) = self.repo.get_member(community_id, target_user_id).await {
                self.emit_to_community(
                    community_id,
                    GatewayEvent::new(
                        "community_member_updated",
                        json!({
                            "community_id": community_id,
                            "member": &member,
                        }),
                    ),
                )
                .await;
            }
        }

        Ok(mute.into())
    }

    pub async fn list_audit_logs(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        query: &AuditLogsQuery,
    ) -> Result<Vec<CommunityAuditLogDto>, AppError> {
        query.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        let can_view = (ctx.actor_community_perms
            & (PERM_VIEW_AUDIT_LOG | PERM_MANAGE_COMMUNITY | PERM_ADMINISTRATOR))
            != 0;
        if !can_view {
            return Err(AppError::Forbidden(
                "Você não possui permissão para consultar os logs de auditoria.".to_string(),
            ));
        }

        self.repo.list_audit_logs(community_id, query).await
    }

    // ==========================================
    // Invites
    // ==========================================

    pub async fn create_invite(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        req: &CreateInviteRequest,
    ) -> Result<CommunityInviteDto, AppError> {
        req.validate()?;
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        if let Some(channel_id) = req.channel_id {
            let channel = self
                .repo
                .get_channel(community_id, channel_id)
                .await?
                .ok_or_else(|| {
                    AppError::BadRequest(
                        "Canal informado não pertence a esta comunidade.".to_string(),
                    )
                })?;

            let (perms, _) = self
                .resolve_actor_channel_perms(&ctx, actor_id, &channel)
                .await?;
            if !has_permission(perms, PERM_VIEW_CHANNEL | PERM_CREATE_INVITES) {
                return Err(AppError::Forbidden(
                    "Você não possui permissão para criar convites para este canal.".to_string(),
                ));
            }
        } else if !has_permission(ctx.actor_community_perms, PERM_CREATE_INVITES) {
            return Err(AppError::Forbidden(
                "Você não possui permissão para criar convites nesta comunidade.".to_string(),
            ));
        }

        let invite = self.repo.create_invite(community_id, actor_id, req).await?;

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "invite.create",
                "invite",
                Some(invite.id),
                None,
                json!({
                    "code": invite.code,
                    "channel_id": invite.channel_id,
                    "max_uses": invite.max_uses,
                    "expires_at": invite.expires_at,
                }),
            )
            .await?;

        Ok(invite.into())
    }

    pub async fn list_invites(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
    ) -> Result<Vec<CommunityInviteDto>, AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        let can_view = (ctx.actor_community_perms
            & (PERM_MANAGE_COMMUNITY | PERM_CREATE_INVITES | PERM_ADMINISTRATOR))
            != 0;
        if !can_view {
            return Err(AppError::Forbidden(
                "Você não possui permissão para visualizar os convites desta comunidade."
                    .to_string(),
            ));
        }

        let invites = self.repo.list_community_invites(community_id).await?;
        Ok(invites.into_iter().map(Into::into).collect())
    }

    pub async fn revoke_invite(
        &self,
        community_id: Uuid,
        invite_id: Uuid,
        actor_id: Uuid,
    ) -> Result<(), AppError> {
        let ctx = self.load_actor_context(community_id, actor_id).await?;

        let invites = self.repo.list_community_invites(community_id).await?;
        let invite = invites
            .into_iter()
            .find(|i| i.id == invite_id)
            .ok_or_else(|| AppError::NotFound("Convite não encontrado.".to_string()))?;

        let can_revoke = has_permission(ctx.actor_community_perms, PERM_MANAGE_COMMUNITY)
            || (invite.inviter_id == actor_id
                && has_permission(ctx.actor_community_perms, PERM_CREATE_INVITES));

        if !can_revoke {
            return Err(AppError::Forbidden(
                "Você não possui permissão para revogar este convite.".to_string(),
            ));
        }

        if invite.revoked_at.is_some() {
            return Err(AppError::NotFound(
                "Convite já foi revogado ou não existe.".to_string(),
            ));
        }

        let revoked = self
            .repo
            .revoke_invite(community_id, invite_id, actor_id)
            .await?;
        if !revoked {
            return Err(AppError::NotFound("Convite não encontrado.".to_string()));
        }

        self.repo
            .insert_audit_log(
                community_id,
                actor_id,
                "invite.revoke",
                "invite",
                Some(invite_id),
                None,
                json!({ "code": invite.code }),
            )
            .await?;

        Ok(())
    }

    pub async fn get_invite_preview(
        &self,
        code: &str,
        actor_id: Uuid,
    ) -> Result<InvitePreviewDto, AppError> {
        let trimmed = code.trim();
        if trimmed.is_empty() {
            return Err(AppError::ValidationError(
                "Código de convite inválido.".to_string(),
            ));
        }

        let preview = self
            .repo
            .get_invite_preview_by_code(trimmed)
            .await?
            .ok_or_else(|| AppError::NotFound("Convite não encontrado.".to_string()))?;

        if self
            .repo
            .get_active_ban(preview.community_id, actor_id)
            .await?
            .is_some()
        {
            return Err(AppError::Forbidden(
                "Você está banido desta comunidade.".to_string(),
            ));
        }

        if let Some(invite) = self.repo.get_invite_by_code(trimmed).await? {
            if let Some(community) = self
                .repo
                .get_community_by_id(preview.community_id)
                .await?
            {
                let is_blocked: bool = sqlx::query_scalar(
                    r#"
                    SELECT EXISTS(
                        SELECT 1
                        FROM user_blocks
                        WHERE (blocker_id = $1 AND blocked_id IN ($2, $3))
                           OR (blocked_id = $1 AND blocker_id IN ($2, $3))
                    )
                    "#,
                )
                .bind(actor_id)
                .bind(community.owner_id)
                .bind(invite.inviter_id)
                .fetch_one(self.repo.pool())
                .await?;

                if is_blocked {
                    return Err(AppError::Forbidden(
                        "Não é possível visualizar este convite devido a um bloqueio entre usuários."
                            .to_string(),
                    ));
                }
            }
        }

        Ok(preview)
    }

    pub async fn accept_invite(
        &self,
        code: &str,
        actor_id: Uuid,
    ) -> Result<AcceptInviteResponse, AppError> {
        let trimmed = code.trim();
        if trimmed.is_empty() {
            return Err(AppError::ValidationError(
                "Código de convite inválido.".to_string(),
            ));
        }

        let response = self.repo.accept_invite(trimmed, actor_id).await?;

        if !response.already_member {
            self.repo
                .insert_audit_log(
                    response.community.id,
                    actor_id,
                    "invite.accept",
                    "user",
                    Some(actor_id),
                    None,
                    json!({
                        "code": trimmed,
                        "channel_id": response.channel_id,
                    }),
                )
                .await?;

            if self.presence_mgr.is_some() {
                if let Ok(Some(member)) =
                    self.repo.get_member(response.community.id, actor_id).await
                {
                    self.emit_to_community(
                        response.community.id,
                        GatewayEvent::new(
                            "community_member_joined",
                            json!({
                                "community_id": response.community.id,
                                "member": &member,
                            }),
                        ),
                    )
                    .await;
                }
            }
        }

        Ok(response)
    }
}
