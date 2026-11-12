use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::{
    derive_community_initials, validate_overwrite_target_type, AcceptInviteResponse,
    AuditLogsQuery, BanMemberRequest, ChannelMessage, ChannelMessageAuthorDto, ChannelMessageDto,
    ChannelMessagesPageDto, ChannelMessagesQuery, ChannelPermissionOverwrite,
    ChannelPermissionOverwriteDto, ChannelReadState, ChannelReadStateDto, Community,
    CommunityAuditLog, CommunityAuditLogDto, CommunityBan, CommunityBanDto, CommunityCategory,
    CommunityChannel, CommunityChannelDto, CommunityDto, CommunityInvite, CommunityMember,
    CommunityMemberDto, CommunityMemberMute, CommunityMemberRoleDto,
    CommunityRole, CommunitySnapshotDto, CreateCategoryRequest,
    CreateChannelRequest, CreateCommunityRequest, CreateInviteRequest, CreateRoleRequest,
    EditChannelMessageRequest, InvitePreviewDto, KickMemberRequest, MuteMemberRequest,
    ReorderCategoriesRequest, ReorderChannelsRequest, ReorderRolesRequest,
    SendChannelMessageRequest, UpdateCategoryRequest, UpdateChannelRequest,
    UpdateCommunityRequest, UpdateMemberRequest, UpdateRoleRequest, UpsertChannelOverwriteRequest,
};
use crate::services::community_permissions::{
    has_permission, resolve_channel_permissions, resolve_community_permissions,
    ChannelOverwriteRule, ResolveChannelPermissionsInput, ALL_DEFINED_PERMISSIONS,
    DEFAULT_EVERYONE_PERMISSIONS, PERM_VIEW_CHANNEL,
};

const INVITE_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const INVITE_CODE_LEN: usize = 8;
const INVITE_CODE_MAX_RETRIES: usize = 5;

fn generate_invite_code() -> String {
    let mut rng = rand::thread_rng();
    let mut code = String::with_capacity(INVITE_CODE_LEN);
    for _ in 0..INVITE_CODE_LEN {
        let idx = rng.gen_range(0..INVITE_CODE_ALPHABET.len());
        code.push(INVITE_CODE_ALPHABET[idx] as char);
    }
    code
}

fn pg_err_code(err: &sqlx::Error) -> Option<String> {
    match err {
        sqlx::Error::Database(db_err) => db_err.code().map(|c| c.into_owned()),
        _ => None,
    }
}

fn map_sqlx_error(err: sqlx::Error, conflict_msg: &str, fk_msg: &str) -> AppError {
    match pg_err_code(&err).as_deref() {
        Some("23505") => AppError::Conflict(conflict_msg.to_string()),
        Some("23503") => AppError::BadRequest(fk_msg.to_string()),
        Some("23514") => {
            AppError::ValidationError("Os dados violam uma restrição de integridade.".to_string())
        }
        Some("22P02") => AppError::BadRequest("Identificador ou formato inválido.".to_string()),
        _ => AppError::DatabaseError(err),
    }
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[derive(Debug, sqlx::FromRow)]
struct UserCommunityRow {
    id: Uuid,
    owner_id: Uuid,
    name: String,
    description: Option<String>,
    icon_url: Option<String>,
    initials: String,
    icon_bg: String,
    accent_color: String,
    appearance_preset: String,
    privacy: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
    member_count: i64,
    everyone_role_id: Option<Uuid>,
    everyone_permissions: i64,
}

impl UserCommunityRow {
    fn into_community(self) -> (Community, i64, Option<Uuid>, i64) {
        let count = self.member_count;
        let everyone_role_id = self.everyone_role_id;
        let everyone_perms = self.everyone_permissions;
        let community = Community {
            id: self.id,
            owner_id: self.owner_id,
            name: self.name,
            description: self.description,
            icon_url: self.icon_url,
            initials: self.initials,
            icon_bg: self.icon_bg,
            accent_color: self.accent_color,
            appearance_preset: self.appearance_preset,
            privacy: self.privacy,
            created_at: self.created_at,
            updated_at: self.updated_at,
            deleted_at: self.deleted_at,
        };
        (community, count, everyone_role_id, everyone_perms)
    }
}

#[derive(Debug, sqlx::FromRow)]
struct MemberRolePairRow {
    community_id: Uuid,
    role_id: Uuid,
    permissions_bitmask: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct ChannelUnreadRow {
    id: Uuid,
    community_id: Uuid,
    is_private: bool,
    is_read_only: bool,
    unread_count: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct MemberWithProfileRow {
    community_id: Uuid,
    user_id: Uuid,
    username: String,
    display_name: String,
    avatar_url: Option<String>,
    status: String,
    custom_status: Option<String>,
    nickname: Option<String>,
    is_owner: bool,
    joined_at: DateTime<Utc>,
    text_muted_until: Option<DateTime<Utc>>,
    voice_muted_until: Option<DateTime<Utc>>,
    server_voice_muted: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct MemberRoleJoinRow {
    user_id: Uuid,
    role_id: Uuid,
    name: String,
    color: Option<String>,
    position: i32,
    is_hoisted: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct ChannelMessageWithAuthorRow {
    id: Uuid,
    channel_id: Uuid,
    community_id: Uuid,
    sender_id: Uuid,
    reply_to_message_id: Option<Uuid>,
    content: String,
    client_message_id: Option<String>,
    attachments_json: serde_json::Value,
    created_at: DateTime<Utc>,
    edited_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
    author_username: Option<String>,
    author_display_name: Option<String>,
    author_avatar_url: Option<String>,
    author_nickname: Option<String>,
    author_role_color: Option<String>,
}

impl ChannelMessageWithAuthorRow {
    fn into_dto(self, viewer_id: Uuid) -> ChannelMessageDto {
        let author = self.author_username.map(|username| ChannelMessageAuthorDto {
            id: self.sender_id,
            username,
            display_name: self.author_display_name.unwrap_or_default(),
            avatar_url: self.author_avatar_url,
            nickname: self.author_nickname,
            role_color: self.author_role_color,
        });

        ChannelMessageDto {
            id: self.id,
            channel_id: self.channel_id,
            community_id: self.community_id,
            sender_id: self.sender_id,
            author,
            reply_to_message_id: self.reply_to_message_id,
            content: self.content,
            client_message_id: self.client_message_id,
            attachments: self.attachments_json,
            created_at: self.created_at,
            edited_at: self.edited_at,
            deleted_at: self.deleted_at,
            is_mine: self.sender_id == viewer_id,
        }
    }
}

#[derive(Debug, sqlx::FromRow)]
struct MessageCursorRow {
    created_at: DateTime<Utc>,
    id: Uuid,
}

#[derive(Debug, sqlx::FromRow)]
struct InvitePreviewRow {
    code: String,
    community_id: Uuid,
    community_name: String,
    community_description: Option<String>,
    community_icon_url: Option<String>,
    community_initials: String,
    community_icon_bg: String,
    community_accent_color: String,
    community_privacy: String,
    channel_id: Option<Uuid>,
    member_count: i64,
    expires_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
    max_uses: Option<i32>,
    uses_count: i32,
}

#[derive(Debug, sqlx::FromRow)]
struct BanWithProfileRow {
    community_id: Uuid,
    user_id: Uuid,
    username: Option<String>,
    display_name: Option<String>,
    banned_by: Uuid,
    reason: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
struct AuditLogWithActorRow {
    id: Uuid,
    community_id: Uuid,
    actor_id: Uuid,
    actor_username: Option<String>,
    action: String,
    target_type: String,
    target_id: Option<Uuid>,
    reason: Option<String>,
    metadata_json: serde_json::Value,
    created_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct CommunityRepository {
    pool: PgPool,
}

impl CommunityRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    // ==========================================
    // Communities
    // ==========================================

    /// Creates a community atomically with its `@everyone` role, owner membership,
    /// default `Canais de Texto` category, default `#geral` text channel, and `community.create` audit log.
    pub async fn create_community(
        &self,
        owner_id: Uuid,
        req: &CreateCommunityRequest,
    ) -> Result<CommunityDto, AppError> {
        req.validate()?;

        let name = req.name.trim();
        let description = normalize_optional_text(req.description.as_deref());
        let icon_url = normalize_optional_text(req.icon_url.as_deref());
        let initials = normalize_optional_text(req.initials.as_deref())
            .map(|s| s.to_uppercase())
            .unwrap_or_else(|| derive_community_initials(name));
        let icon_bg = req
            .icon_bg
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("#1f2937");
        let accent_color = req
            .accent_color
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("#38bdf8");
        let appearance_preset = req
            .appearance_preset
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("steam-dark");
        let privacy = req
            .privacy
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("invite_only");

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let community = sqlx::query_as::<_, Community>(
            r#"
            INSERT INTO communities (
                owner_id, name, description, icon_url, initials,
                icon_bg, accent_color, appearance_preset, privacy
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING
                id, owner_id, name, description, icon_url, initials,
                icon_bg, accent_color, appearance_preset, privacy,
                created_at, updated_at, deleted_at
            "#,
        )
        .bind(owner_id)
        .bind(name)
        .bind(description)
        .bind(icon_url)
        .bind(initials)
        .bind(icon_bg)
        .bind(accent_color)
        .bind(appearance_preset)
        .bind(privacy)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| {
            map_sqlx_error(
                e,
                "Conflito ao criar comunidade.",
                "Proprietário informado não existe.",
            )
        })?;

        sqlx::query(
            r#"
            INSERT INTO community_roles (
                community_id, name, position, permissions_bitmask,
                is_default, is_hoisted, is_mentionable
            )
            VALUES ($1, '@everyone', 0, $2, TRUE, FALSE, FALSE)
            "#,
        )
        .bind(community.id)
        .bind(DEFAULT_EVERYONE_PERMISSIONS)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO community_members (community_id, user_id)
            VALUES ($1, $2)
            "#,
        )
        .bind(community.id)
        .bind(owner_id)
        .execute(&mut *tx)
        .await?;

        let category_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO community_categories (community_id, name, position)
            VALUES ($1, 'Canais de Texto', 0)
            RETURNING id
            "#,
        )
        .bind(community.id)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO community_channels (
                community_id, category_id, name, channel_type, position, is_private, is_read_only
            )
            VALUES ($1, $2, 'geral', 'text', 0, FALSE, FALSE)
            "#,
        )
        .bind(community.id)
        .bind(category_id)
        .execute(&mut *tx)
        .await?;

        Self::insert_audit_log_tx(
            &mut tx,
            community.id,
            owner_id,
            "community.create",
            "community",
            Some(community.id),
            None,
            serde_json::json!({
                "name": community.name,
                "privacy": community.privacy,
            }),
        )
        .await?;

        tx.commit().await?;

        Ok(CommunityDto::from_model(
            community,
            ALL_DEFINED_PERMISSIONS,
            0,
            1,
        ))
    }

    pub async fn get_community_by_id(
        &self,
        community_id: Uuid,
    ) -> Result<Option<Community>, AppError> {
        let community = sqlx::query_as::<_, Community>(
            r#"
            SELECT
                id, owner_id, name, description, icon_url, initials,
                icon_bg, accent_color, appearance_preset, privacy,
                created_at, updated_at, deleted_at
            FROM communities
            WHERE id = $1 AND deleted_at IS NULL
            "#,
        )
        .bind(community_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(community)
    }

    pub async fn get_community_dto(
        &self,
        community_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<CommunityDto>, AppError> {
        let mut items = self
            .load_user_communities_filtered(user_id, Some(community_id))
            .await?;
        Ok(items.pop())
    }

    pub async fn list_user_communities(&self, user_id: Uuid) -> Result<Vec<CommunityDto>, AppError> {
        self.load_user_communities_filtered(user_id, None).await
    }

    async fn load_user_communities_filtered(
        &self,
        user_id: Uuid,
        only_community_id: Option<Uuid>,
    ) -> Result<Vec<CommunityDto>, AppError> {
        let rows = sqlx::query_as::<_, UserCommunityRow>(
            r#"
            SELECT
                c.id,
                c.owner_id,
                c.name,
                c.description,
                c.icon_url,
                c.initials,
                c.icon_bg,
                c.accent_color,
                c.appearance_preset,
                c.privacy,
                c.created_at,
                c.updated_at,
                c.deleted_at,
                (
                    SELECT COUNT(*)::bigint
                    FROM community_members m2
                    WHERE m2.community_id = c.id
                ) AS member_count,
                ev.id AS everyone_role_id,
                COALESCE(ev.permissions_bitmask, 0) AS everyone_permissions
            FROM communities c
            JOIN community_members cm
              ON cm.community_id = c.id AND cm.user_id = $1
            LEFT JOIN community_roles ev
              ON ev.community_id = c.id AND ev.is_default = TRUE
            WHERE c.deleted_at IS NULL
              AND ($2::uuid IS NULL OR c.id = $2)
              AND NOT EXISTS (
                  SELECT 1
                  FROM community_bans b
                  WHERE b.community_id = c.id
                    AND b.user_id = $1
                    AND (b.expires_at IS NULL OR b.expires_at > NOW())
              )
            ORDER BY c.created_at ASC
            "#,
        )
        .bind(user_id)
        .bind(only_community_id)
        .fetch_all(&self.pool)
        .await?;

        if rows.is_empty() {
            return Ok(Vec::new());
        }

        let community_ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();

        let member_role_rows = sqlx::query_as::<_, MemberRolePairRow>(
            r#"
            SELECT
                cmr.community_id,
                cmr.role_id,
                cr.permissions_bitmask
            FROM community_member_roles cmr
            JOIN community_roles cr ON cr.id = cmr.role_id
            WHERE cmr.user_id = $1
              AND cmr.community_id = ANY($2)
            "#,
        )
        .bind(user_id)
        .bind(&community_ids)
        .fetch_all(&self.pool)
        .await?;

        let mut role_ids_by_comm: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
        let mut role_perms_by_comm: HashMap<Uuid, Vec<i64>> = HashMap::new();
        for mr in member_role_rows {
            role_ids_by_comm
                .entry(mr.community_id)
                .or_default()
                .push(mr.role_id);
            role_perms_by_comm
                .entry(mr.community_id)
                .or_default()
                .push(mr.permissions_bitmask);
        }

        let channel_rows = sqlx::query_as::<_, ChannelUnreadRow>(
            r#"
            SELECT
                ch.id,
                ch.community_id,
                ch.is_private,
                ch.is_read_only,
                (
                    SELECT COUNT(*)::bigint
                    FROM channel_messages m
                    LEFT JOIN channel_read_states crs
                      ON crs.channel_id = ch.id AND crs.user_id = $1
                    LEFT JOIN channel_messages lm
                      ON lm.id = crs.last_read_message_id
                    WHERE m.channel_id = ch.id
                      AND m.deleted_at IS NULL
                      AND m.sender_id <> $1
                      AND (
                          (lm.id IS NOT NULL AND (m.created_at, m.id) > (lm.created_at, lm.id))
                          OR (lm.id IS NULL AND m.created_at > COALESCE(crs.last_read_at, cm.joined_at))
                      )
                ) AS unread_count
            FROM community_channels ch
            JOIN community_members cm
              ON cm.community_id = ch.community_id AND cm.user_id = $1
            WHERE ch.community_id = ANY($2)
              AND ch.deleted_at IS NULL
            "#,
        )
        .bind(user_id)
        .bind(&community_ids)
        .fetch_all(&self.pool)
        .await?;

        let channel_ids: Vec<Uuid> = channel_rows.iter().map(|c| c.id).collect();
        let overwrites_map = if channel_ids.is_empty() {
            HashMap::new()
        } else {
            let ow_rows = sqlx::query_as::<_, ChannelPermissionOverwrite>(
                r#"
                SELECT
                    id, channel_id, target_type, target_id,
                    allow_bitmask, deny_bitmask, created_at, updated_at
                FROM channel_permission_overwrites
                WHERE channel_id = ANY($1)
                "#,
            )
            .bind(&channel_ids)
            .fetch_all(&self.pool)
            .await?;

            let mut map: HashMap<Uuid, Vec<ChannelOverwriteRule>> = HashMap::new();
            for ow in ow_rows {
                map.entry(ow.channel_id)
                    .or_default()
                    .push(ChannelOverwriteRule::from(&ow));
            }
            map
        };

        let mutes = sqlx::query_as::<_, CommunityMemberMute>(
            r#"
            SELECT
                community_id, user_id, muted_by, reason,
                text_muted_until, voice_muted_until, server_voice_muted, updated_at
            FROM community_member_mutes
            WHERE user_id = $1
              AND community_id = ANY($2)
            "#,
        )
        .bind(user_id)
        .bind(&community_ids)
        .fetch_all(&self.pool)
        .await?;

        let mute_by_comm: HashMap<Uuid, CommunityMemberMute> =
            mutes.into_iter().map(|m| (m.community_id, m)).collect();

        let mut channels_by_comm: HashMap<Uuid, Vec<ChannelUnreadRow>> = HashMap::new();
        for ch in channel_rows {
            channels_by_comm
                .entry(ch.community_id)
                .or_default()
                .push(ch);
        }

        let now = Utc::now();
        let mut dtos = Vec::with_capacity(rows.len());

        for row in rows {
            let (community, member_count, everyone_role_id, everyone_permissions) =
                row.into_community();
            let member_role_ids = role_ids_by_comm
                .get(&community.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let member_role_permissions = role_perms_by_comm
                .get(&community.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);

            let effective_perms = resolve_community_permissions(
                user_id,
                community.owner_id,
                true,
                false,
                everyone_permissions,
                member_role_permissions,
            );

            let mute = mute_by_comm.get(&community.id);
            let mut unread_total = 0_i64;
            if let Some(ch_list) = channels_by_comm.get(&community.id) {
                for ch in ch_list {
                    let ows = overwrites_map
                        .get(&ch.id)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]);
                    let ch_perms = resolve_channel_permissions(&ResolveChannelPermissionsInput {
                        actor_id: user_id,
                        owner_id: community.owner_id,
                        is_member: true,
                        is_banned: false,
                        everyone_role_id,
                        everyone_permissions,
                        member_role_ids,
                        member_role_permissions,
                        is_private: ch.is_private,
                        is_read_only: ch.is_read_only,
                        overwrites: ows,
                        text_muted_until: mute.and_then(|m| m.text_muted_until),
                        voice_muted_until: mute.and_then(|m| m.voice_muted_until),
                        server_voice_muted: mute.map_or(false, |m| m.server_voice_muted),
                        now,
                    });
                    if has_permission(ch_perms, PERM_VIEW_CHANNEL) {
                        unread_total += ch.unread_count;
                    }
                }
            }

            dtos.push(CommunityDto::from_model(
                community,
                effective_perms,
                unread_total,
                member_count,
            ));
        }

        Ok(dtos)
    }

    pub async fn get_community_snapshot(
        &self,
        community_id: Uuid,
        user_id: Uuid,
    ) -> Result<CommunitySnapshotDto, AppError> {
        let community = self
            .get_community_by_id(community_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Comunidade não encontrada.".to_string()))?;

        if self.get_active_ban(community_id, user_id).await?.is_some() {
            return Err(AppError::Forbidden(
                "Você está banido desta comunidade.".to_string(),
            ));
        }

        if !self.is_member(community_id, user_id).await? {
            return Err(AppError::Forbidden(
                "Você não é membro desta comunidade.".to_string(),
            ));
        }

        let roles = self.list_roles(community_id).await?;
        let categories = self.list_categories(community_id).await?;
        let channels = self.list_channels(community_id).await?;
        let members = self.list_members_with_roles(community_id).await?;
        let my_mute = self.get_member_mute(community_id, user_id).await?;

        let everyone_role = roles.iter().find(|r| r.is_default);
        let everyone_role_id = everyone_role.map(|r| r.id);
        let everyone_permissions = everyone_role.map_or(0, |r| r.permissions_bitmask);

        let member_role_ids = self.list_member_role_ids(community_id, user_id).await?;
        let role_perm_map: HashMap<Uuid, i64> = roles
            .iter()
            .map(|r| (r.id, r.permissions_bitmask))
            .collect();
        let member_role_permissions: Vec<i64> = member_role_ids
            .iter()
            .filter_map(|id| role_perm_map.get(id).copied())
            .collect();

        let effective_community_perms = resolve_community_permissions(
            user_id,
            community.owner_id,
            true,
            false,
            everyone_permissions,
            &member_role_permissions,
        );

        let channel_ids: Vec<Uuid> = channels.iter().map(|c| c.id).collect();

        let overwrites_by_channel = if channel_ids.is_empty() {
            HashMap::new()
        } else {
            let ow_rows = sqlx::query_as::<_, ChannelPermissionOverwrite>(
                r#"
                SELECT
                    id, channel_id, target_type, target_id,
                    allow_bitmask, deny_bitmask, created_at, updated_at
                FROM channel_permission_overwrites
                WHERE channel_id = ANY($1)
                ORDER BY target_type ASC, created_at ASC
                "#,
            )
            .bind(&channel_ids)
            .fetch_all(&self.pool)
            .await?;

            let mut map: HashMap<Uuid, Vec<ChannelPermissionOverwrite>> = HashMap::new();
            for ow in ow_rows {
                map.entry(ow.channel_id).or_default().push(ow);
            }
            map
        };

        let unread_rows = if channel_ids.is_empty() {
            Vec::new()
        } else {
            sqlx::query_as::<_, ChannelUnreadRow>(
                r#"
                SELECT
                    ch.id,
                    ch.community_id,
                    ch.is_private,
                    ch.is_read_only,
                    (
                        SELECT COUNT(*)::bigint
                        FROM channel_messages m
                        LEFT JOIN channel_read_states crs
                          ON crs.channel_id = ch.id AND crs.user_id = $1
                        LEFT JOIN channel_messages lm
                          ON lm.id = crs.last_read_message_id
                        WHERE m.channel_id = ch.id
                          AND m.deleted_at IS NULL
                          AND m.sender_id <> $1
                          AND (
                              (lm.id IS NOT NULL AND (m.created_at, m.id) > (lm.created_at, lm.id))
                              OR (lm.id IS NULL AND m.created_at > COALESCE(crs.last_read_at, cm.joined_at))
                          )
                    ) AS unread_count
                FROM community_channels ch
                JOIN community_members cm
                  ON cm.community_id = ch.community_id AND cm.user_id = $1
                WHERE ch.id = ANY($2)
                  AND ch.deleted_at IS NULL
                "#,
            )
            .bind(user_id)
            .bind(&channel_ids)
            .fetch_all(&self.pool)
            .await?
        };
        let unread_map: HashMap<Uuid, i64> = unread_rows
            .into_iter()
            .map(|r| (r.id, r.unread_count))
            .collect();

        let now = Utc::now();
        let mut channel_dtos = Vec::with_capacity(channels.len());
        let mut total_unread = 0_i64;

        for ch in channels {
            let ows = overwrites_by_channel
                .get(&ch.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let ow_rules: Vec<ChannelOverwriteRule> =
                ows.iter().map(ChannelOverwriteRule::from).collect();

            let ch_perms = resolve_channel_permissions(&ResolveChannelPermissionsInput {
                actor_id: user_id,
                owner_id: community.owner_id,
                is_member: true,
                is_banned: false,
                everyone_role_id,
                everyone_permissions,
                member_role_ids: &member_role_ids,
                member_role_permissions: &member_role_permissions,
                is_private: ch.is_private,
                is_read_only: ch.is_read_only,
                overwrites: &ow_rules,
                text_muted_until: my_mute.as_ref().and_then(|m| m.text_muted_until),
                voice_muted_until: my_mute.as_ref().and_then(|m| m.voice_muted_until),
                server_voice_muted: my_mute.as_ref().map_or(false, |m| m.server_voice_muted),
                now,
            });

            if !has_permission(ch_perms, PERM_VIEW_CHANNEL) {
                continue;
            }

            let ch_unread = unread_map.get(&ch.id).copied().unwrap_or(0);
            total_unread += ch_unread;
            let ow_dtos: Vec<ChannelPermissionOverwriteDto> =
                ows.iter().cloned().map(Into::into).collect();
            channel_dtos.push(CommunityChannelDto::from_model(
                ch, ch_perms, ch_unread, ow_dtos,
            ));
        }

        let member_count = members.len() as i64;
        let community_dto = CommunityDto::from_model(
            community,
            effective_community_perms,
            total_unread,
            member_count,
        );

        Ok(CommunitySnapshotDto {
            community: community_dto,
            categories: categories.into_iter().map(Into::into).collect(),
            channels: channel_dtos,
            roles: roles.into_iter().map(Into::into).collect(),
            members,
            my_mute: my_mute.map(Into::into),
        })
    }

    pub async fn update_community(
        &self,
        community_id: Uuid,
        req: &UpdateCommunityRequest,
    ) -> Result<Community, AppError> {
        req.validate()?;

        let name = req.name.as_deref().map(|s| s.trim().to_string());
        let (set_description, description) = match &req.description {
            None => (false, None),
            Some(opt) => (true, normalize_optional_text(opt.as_deref())),
        };
        let (set_icon_url, icon_url) = match &req.icon_url {
            None => (false, None),
            Some(opt) => (true, normalize_optional_text(opt.as_deref())),
        };
        let initials = normalize_optional_text(req.initials.as_deref()).map(|s| s.to_uppercase());
        let icon_bg = req.icon_bg.as_deref().map(|s| s.trim().to_string());
        let accent_color = req.accent_color.as_deref().map(|s| s.trim().to_string());
        let appearance_preset = req
            .appearance_preset
            .as_deref()
            .map(|s| s.trim().to_string());
        let privacy = req.privacy.as_deref().map(|s| s.trim().to_string());

        let updated = sqlx::query_as::<_, Community>(
            r#"
            UPDATE communities
            SET
                name = COALESCE($2, name),
                description = CASE WHEN $3 THEN $4 ELSE description END,
                icon_url = CASE WHEN $5 THEN $6 ELSE icon_url END,
                initials = COALESCE($7, initials),
                icon_bg = COALESCE($8, icon_bg),
                accent_color = COALESCE($9, accent_color),
                appearance_preset = COALESCE($10, appearance_preset),
                privacy = COALESCE($11, privacy),
                updated_at = NOW()
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING
                id, owner_id, name, description, icon_url, initials,
                icon_bg, accent_color, appearance_preset, privacy,
                created_at, updated_at, deleted_at
            "#,
        )
        .bind(community_id)
        .bind(name)
        .bind(set_description)
        .bind(description)
        .bind(set_icon_url)
        .bind(icon_url)
        .bind(initials)
        .bind(icon_bg)
        .bind(accent_color)
        .bind(appearance_preset)
        .bind(privacy)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| map_sqlx_error(e, "Conflito ao atualizar comunidade.", "Referência inválida."))?;

        updated.ok_or_else(|| AppError::NotFound("Comunidade não encontrada.".to_string()))
    }

    pub async fn delete_community(&self, community_id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query(
            r#"
            UPDATE communities
            SET deleted_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND deleted_at IS NULL
            "#,
        )
        .bind(community_id)
        .execute(&self.pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    pub async fn transfer_ownership(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        target_user_id: Uuid,
    ) -> Result<Community, AppError> {
        if actor_id == target_user_id {
            return Err(AppError::BadRequest(
                "O usuário de destino já é o proprietário da comunidade.".to_string(),
            ));
        }

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let community = sqlx::query_as::<_, Community>(
            r#"
            SELECT
                id, owner_id, name, description, icon_url, initials,
                icon_bg, accent_color, appearance_preset, privacy,
                created_at, updated_at, deleted_at
            FROM communities
            WHERE id = $1 AND deleted_at IS NULL
            FOR UPDATE
            "#,
        )
        .bind(community_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Comunidade não encontrada.".to_string()))?;

        if community.owner_id != actor_id {
            return Err(AppError::Forbidden(
                "Apenas o proprietário atual pode transferir a propriedade da comunidade."
                    .to_string(),
            ));
        }

        let target_is_member: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM community_members
                WHERE community_id = $1 AND user_id = $2
            )
            "#,
        )
        .bind(community_id)
        .bind(target_user_id)
        .fetch_one(&mut *tx)
        .await?;

        if !target_is_member {
            return Err(AppError::BadRequest(
                "O usuário de destino deve ser membro da comunidade.".to_string(),
            ));
        }

        let target_banned: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM community_bans
                WHERE community_id = $1
                  AND user_id = $2
                  AND (expires_at IS NULL OR expires_at > NOW())
            )
            "#,
        )
        .bind(community_id)
        .bind(target_user_id)
        .fetch_one(&mut *tx)
        .await?;

        if target_banned {
            return Err(AppError::BadRequest(
                "Não é possível transferir a propriedade para um usuário banido.".to_string(),
            ));
        }

        let updated = sqlx::query_as::<_, Community>(
            r#"
            UPDATE communities
            SET owner_id = $2, updated_at = NOW()
            WHERE id = $1
            RETURNING
                id, owner_id, name, description, icon_url, initials,
                icon_bg, accent_color, appearance_preset, privacy,
                created_at, updated_at, deleted_at
            "#,
        )
        .bind(community_id)
        .bind(target_user_id)
        .fetch_one(&mut *tx)
        .await?;

        Self::insert_audit_log_tx(
            &mut tx,
            community_id,
            actor_id,
            "community.transfer_ownership",
            "user",
            Some(target_user_id),
            None,
            serde_json::json!({
                "previous_owner_id": actor_id,
                "new_owner_id": target_user_id,
            }),
        )
        .await?;

        tx.commit().await?;

        Ok(updated)
    }

    // ==========================================
    // Members & Roles
    // ==========================================

    pub async fn is_member(&self, community_id: Uuid, user_id: Uuid) -> Result<bool, AppError> {
        let exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM community_members cm
                JOIN communities c ON c.id = cm.community_id
                WHERE cm.community_id = $1
                  AND cm.user_id = $2
                  AND c.deleted_at IS NULL
            )
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;

        Ok(exists)
    }

    pub async fn get_member(
        &self,
        community_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<CommunityMemberDto>, AppError> {
        let row = sqlx::query_as::<_, MemberWithProfileRow>(
            r#"
            SELECT
                cm.community_id,
                cm.user_id,
                u.username,
                p.display_name,
                p.avatar_url,
                p.status,
                p.custom_status,
                cm.nickname,
                (c.owner_id = cm.user_id) AS is_owner,
                cm.joined_at,
                mm.text_muted_until,
                mm.voice_muted_until,
                COALESCE(mm.server_voice_muted, FALSE) AS server_voice_muted
            FROM community_members cm
            JOIN communities c ON c.id = cm.community_id AND c.deleted_at IS NULL
            JOIN users u ON u.id = cm.user_id
            JOIN user_profiles p ON p.user_id = cm.user_id
            LEFT JOIN community_member_mutes mm
              ON mm.community_id = cm.community_id AND mm.user_id = cm.user_id
            WHERE cm.community_id = $1 AND cm.user_id = $2
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;

        let Some(m) = row else {
            return Ok(None);
        };

        let role_rows = sqlx::query_as::<_, MemberRoleJoinRow>(
            r#"
            SELECT
                cmr.user_id,
                cr.id AS role_id,
                cr.name,
                cr.color,
                cr.position,
                cr.is_hoisted
            FROM community_member_roles cmr
            JOIN community_roles cr ON cr.id = cmr.role_id
            WHERE cmr.community_id = $1 AND cmr.user_id = $2
            ORDER BY cr.position DESC, cr.created_at ASC
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;

        let roles: Vec<CommunityMemberRoleDto> = role_rows
            .into_iter()
            .map(|r| CommunityMemberRoleDto {
                id: r.role_id,
                name: r.name,
                color: r.color,
                position: r.position,
                is_hoisted: r.is_hoisted,
            })
            .collect();
        let highest_role_position = roles.iter().map(|r| r.position).max().unwrap_or(0);

        Ok(Some(CommunityMemberDto {
            community_id: m.community_id,
            user_id: m.user_id,
            username: m.username,
            display_name: m.display_name,
            avatar_url: m.avatar_url,
            status: m.status,
            custom_status: m.custom_status,
            nickname: m.nickname,
            is_owner: m.is_owner,
            roles,
            highest_role_position,
            joined_at: m.joined_at,
            text_muted_until: m.text_muted_until,
            voice_muted_until: m.voice_muted_until,
            server_voice_muted: m.server_voice_muted,
        }))
    }

    pub async fn list_members_with_roles(
        &self,
        community_id: Uuid,
    ) -> Result<Vec<CommunityMemberDto>, AppError> {
        let member_rows = sqlx::query_as::<_, MemberWithProfileRow>(
            r#"
            SELECT
                cm.community_id,
                cm.user_id,
                u.username,
                p.display_name,
                p.avatar_url,
                p.status,
                p.custom_status,
                cm.nickname,
                (c.owner_id = cm.user_id) AS is_owner,
                cm.joined_at,
                mm.text_muted_until,
                mm.voice_muted_until,
                COALESCE(mm.server_voice_muted, FALSE) AS server_voice_muted
            FROM community_members cm
            JOIN communities c ON c.id = cm.community_id AND c.deleted_at IS NULL
            JOIN users u ON u.id = cm.user_id
            JOIN user_profiles p ON p.user_id = cm.user_id
            LEFT JOIN community_member_mutes mm
              ON mm.community_id = cm.community_id AND mm.user_id = cm.user_id
            WHERE cm.community_id = $1
            ORDER BY cm.joined_at ASC
            "#,
        )
        .bind(community_id)
        .fetch_all(&self.pool)
        .await?;

        if member_rows.is_empty() {
            return Ok(Vec::new());
        }

        let role_rows = sqlx::query_as::<_, MemberRoleJoinRow>(
            r#"
            SELECT
                cmr.user_id,
                cr.id AS role_id,
                cr.name,
                cr.color,
                cr.position,
                cr.is_hoisted
            FROM community_member_roles cmr
            JOIN community_roles cr ON cr.id = cmr.role_id
            WHERE cmr.community_id = $1
            ORDER BY cr.position DESC, cr.created_at ASC
            "#,
        )
        .bind(community_id)
        .fetch_all(&self.pool)
        .await?;

        let mut roles_by_user: HashMap<Uuid, Vec<CommunityMemberRoleDto>> = HashMap::new();
        for r in role_rows {
            roles_by_user
                .entry(r.user_id)
                .or_default()
                .push(CommunityMemberRoleDto {
                    id: r.role_id,
                    name: r.name,
                    color: r.color,
                    position: r.position,
                    is_hoisted: r.is_hoisted,
                });
        }

        let mut dtos: Vec<CommunityMemberDto> = member_rows
            .into_iter()
            .map(|m| {
                let roles = roles_by_user.remove(&m.user_id).unwrap_or_default();
                let highest_role_position = roles.iter().map(|r| r.position).max().unwrap_or(0);
                CommunityMemberDto {
                    community_id: m.community_id,
                    user_id: m.user_id,
                    username: m.username,
                    display_name: m.display_name,
                    avatar_url: m.avatar_url,
                    status: m.status,
                    custom_status: m.custom_status,
                    nickname: m.nickname,
                    is_owner: m.is_owner,
                    roles,
                    highest_role_position,
                    joined_at: m.joined_at,
                    text_muted_until: m.text_muted_until,
                    voice_muted_until: m.voice_muted_until,
                    server_voice_muted: m.server_voice_muted,
                }
            })
            .collect();

        dtos.sort_by(|a, b| {
            b.is_owner
                .cmp(&a.is_owner)
                .then_with(|| b.highest_role_position.cmp(&a.highest_role_position))
                .then_with(|| {
                    a.display_name
                        .to_lowercase()
                        .cmp(&b.display_name.to_lowercase())
                })
        });

        Ok(dtos)
    }

    pub async fn list_member_role_ids(
        &self,
        community_id: Uuid,
        user_id: Uuid,
    ) -> Result<Vec<Uuid>, AppError> {
        let ids = sqlx::query_scalar::<_, Uuid>(
            r#"
            SELECT cmr.role_id
            FROM community_member_roles cmr
            JOIN community_roles cr ON cr.id = cmr.role_id
            WHERE cmr.community_id = $1 AND cmr.user_id = $2
            ORDER BY cr.position DESC, cr.created_at ASC
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(ids)
    }

    pub async fn update_member(
        &self,
        community_id: Uuid,
        user_id: Uuid,
        actor_id: Uuid,
        req: &UpdateMemberRequest,
    ) -> Result<CommunityMemberDto, AppError> {
        req.validate()?;

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let member = sqlx::query_as::<_, CommunityMember>(
            r#"
            SELECT cm.community_id, cm.user_id, cm.nickname, cm.joined_at
            FROM community_members cm
            JOIN communities c ON c.id = cm.community_id AND c.deleted_at IS NULL
            WHERE cm.community_id = $1 AND cm.user_id = $2
            FOR UPDATE
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;

        if member.is_none() {
            return Err(AppError::NotFound(
                "Membro não encontrado na comunidade.".to_string(),
            ));
        }

        if let Some(nick_opt) = &req.nickname {
            let clean_nick = normalize_optional_text(nick_opt.as_deref());
            sqlx::query(
                r#"
                UPDATE community_members
                SET nickname = $3
                WHERE community_id = $1 AND user_id = $2
                "#,
            )
            .bind(community_id)
            .bind(user_id)
            .bind(clean_nick)
            .execute(&mut *tx)
            .await?;
        }

        if let Some(role_ids) = &req.role_ids {
            Self::set_member_roles_tx(&mut tx, community_id, user_id, role_ids, Some(actor_id))
                .await?;
        }

        tx.commit().await?;

        self.get_member(community_id, user_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Membro não encontrado na comunidade.".to_string()))
    }

    pub async fn remove_member(&self, community_id: Uuid, user_id: Uuid) -> Result<bool, AppError> {
        let owner_id: Option<Uuid> = sqlx::query_scalar(
            r#"
            SELECT owner_id FROM communities WHERE id = $1 AND deleted_at IS NULL
            "#,
        )
        .bind(community_id)
        .fetch_optional(&self.pool)
        .await?;

        let Some(owner_id) = owner_id else {
            return Ok(false);
        };

        if owner_id == user_id {
            return Err(AppError::BadRequest(
                "O proprietário da comunidade não pode ser removido sem transferir a propriedade."
                    .to_string(),
            ));
        }

        let res = sqlx::query(
            r#"
            DELETE FROM community_members
            WHERE community_id = $1 AND user_id = $2
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .execute(&self.pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    pub async fn create_role(
        &self,
        community_id: Uuid,
        req: &CreateRoleRequest,
    ) -> Result<CommunityRole, AppError> {
        req.validate()?;

        let perms = req.resolve_permissions()?;
        let name = req.name.trim();
        let color = req.color.as_deref().map(|s| s.trim().to_string());
        let is_hoisted = req.is_hoisted.unwrap_or(false);
        let is_mentionable = req.is_mentionable.unwrap_or(false);

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM communities WHERE id = $1 AND deleted_at IS NULL)",
        )
        .bind(community_id)
        .fetch_one(&mut *tx)
        .await?;

        if !exists {
            return Err(AppError::NotFound("Comunidade não encontrada.".to_string()));
        }

        let position = match req.position {
            Some(pos) => pos,
            None => {
                let max_pos: i32 = sqlx::query_scalar(
                    "SELECT COALESCE(MAX(position), 0) FROM community_roles WHERE community_id = $1",
                )
                .bind(community_id)
                .fetch_one(&mut *tx)
                .await?;
                max_pos.saturating_add(1).max(1)
            }
        };

        let role = sqlx::query_as::<_, CommunityRole>(
            r#"
            INSERT INTO community_roles (
                community_id, name, color, position, permissions_bitmask,
                is_default, is_hoisted, is_mentionable
            )
            VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7)
            RETURNING
                id, community_id, name, color, position, permissions_bitmask,
                is_default, is_hoisted, is_mentionable, created_at, updated_at
            "#,
        )
        .bind(community_id)
        .bind(name)
        .bind(color)
        .bind(position)
        .bind(perms)
        .bind(is_hoisted)
        .bind(is_mentionable)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| map_sqlx_error(e, "Conflito ao criar cargo.", "Comunidade não encontrada."))?;

        tx.commit().await?;

        Ok(role)
    }

    pub async fn get_role(
        &self,
        community_id: Uuid,
        role_id: Uuid,
    ) -> Result<Option<CommunityRole>, AppError> {
        let role = sqlx::query_as::<_, CommunityRole>(
            r#"
            SELECT
                id, community_id, name, color, position, permissions_bitmask,
                is_default, is_hoisted, is_mentionable, created_at, updated_at
            FROM community_roles
            WHERE community_id = $1 AND id = $2
            "#,
        )
        .bind(community_id)
        .bind(role_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(role)
    }

    pub async fn list_roles(&self, community_id: Uuid) -> Result<Vec<CommunityRole>, AppError> {
        let roles = sqlx::query_as::<_, CommunityRole>(
            r#"
            SELECT
                id, community_id, name, color, position, permissions_bitmask,
                is_default, is_hoisted, is_mentionable, created_at, updated_at
            FROM community_roles
            WHERE community_id = $1
            ORDER BY position DESC, created_at ASC
            "#,
        )
        .bind(community_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(roles)
    }

    pub async fn update_role(
        &self,
        community_id: Uuid,
        role_id: Uuid,
        req: &UpdateRoleRequest,
    ) -> Result<CommunityRole, AppError> {
        req.validate()?;
        let new_perms = req.resolve_permissions()?;

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let existing = sqlx::query_as::<_, CommunityRole>(
            r#"
            SELECT
                id, community_id, name, color, position, permissions_bitmask,
                is_default, is_hoisted, is_mentionable, created_at, updated_at
            FROM community_roles
            WHERE community_id = $1 AND id = $2
            FOR UPDATE
            "#,
        )
        .bind(community_id)
        .bind(role_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Cargo não encontrado.".to_string()))?;

        if let Some(pos) = req.position {
            if existing.is_default && pos != 0 {
                return Err(AppError::BadRequest(
                    "Não é possível alterar a posição do cargo padrão @everyone.".to_string(),
                ));
            }
            if !existing.is_default && pos == 0 {
                return Err(AppError::ValidationError(
                    "Cargos personalizados devem possuir posição maior ou igual a 1.".to_string(),
                ));
            }
        }

        let name = req.name.as_deref().map(|s| s.trim().to_string());
        let (set_color, color) = match &req.color {
            None => (false, None),
            Some(opt) => (true, normalize_optional_text(opt.as_deref())),
        };

        let updated = sqlx::query_as::<_, CommunityRole>(
            r#"
            UPDATE community_roles
            SET
                name = COALESCE($3, name),
                color = CASE WHEN $4 THEN $5 ELSE color END,
                position = COALESCE($6, position),
                permissions_bitmask = COALESCE($7, permissions_bitmask),
                is_hoisted = COALESCE($8, is_hoisted),
                is_mentionable = COALESCE($9, is_mentionable),
                updated_at = NOW()
            WHERE community_id = $1 AND id = $2
            RETURNING
                id, community_id, name, color, position, permissions_bitmask,
                is_default, is_hoisted, is_mentionable, created_at, updated_at
            "#,
        )
        .bind(community_id)
        .bind(role_id)
        .bind(name)
        .bind(set_color)
        .bind(color)
        .bind(req.position)
        .bind(new_perms)
        .bind(req.is_hoisted)
        .bind(req.is_mentionable)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(updated)
    }

    pub async fn delete_role(&self, community_id: Uuid, role_id: Uuid) -> Result<bool, AppError> {
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let is_default: Option<bool> = sqlx::query_scalar(
            r#"
            SELECT is_default
            FROM community_roles
            WHERE community_id = $1 AND id = $2
            FOR UPDATE
            "#,
        )
        .bind(community_id)
        .bind(role_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(is_default) = is_default else {
            return Ok(false);
        };

        if is_default {
            return Err(AppError::BadRequest(
                "Não é permitido excluir o cargo padrão @everyone.".to_string(),
            ));
        }

        let res = sqlx::query(
            r#"
            DELETE FROM community_roles
            WHERE community_id = $1 AND id = $2 AND is_default = FALSE
            "#,
        )
        .bind(community_id)
        .bind(role_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn reorder_roles(
        &self,
        community_id: Uuid,
        req: &ReorderRolesRequest,
    ) -> Result<Vec<CommunityRole>, AppError> {
        req.validate()?;

        let role_ids: Vec<Uuid> = req.items.iter().map(|i| i.id).collect();
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        #[derive(sqlx::FromRow)]
        struct RoleCheckRow {
            id: Uuid,
            is_default: bool,
        }

        let found = sqlx::query_as::<_, RoleCheckRow>(
            r#"
            SELECT id, is_default
            FROM community_roles
            WHERE community_id = $1 AND id = ANY($2)
            FOR UPDATE
            "#,
        )
        .bind(community_id)
        .bind(&role_ids)
        .fetch_all(&mut *tx)
        .await?;

        if found.len() != role_ids.len() {
            return Err(AppError::BadRequest(
                "Um ou mais cargos não pertencem a esta comunidade.".to_string(),
            ));
        }

        if found.iter().any(|r| r.is_default) {
            return Err(AppError::BadRequest(
                "Não é possível reordenar o cargo padrão @everyone.".to_string(),
            ));
        }

        for item in &req.items {
            sqlx::query(
                r#"
                UPDATE community_roles
                SET position = $3, updated_at = NOW()
                WHERE community_id = $1 AND id = $2
                "#,
            )
            .bind(community_id)
            .bind(item.id)
            .bind(item.position)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;

        self.list_roles(community_id).await
    }

    async fn set_member_roles_tx(
        tx: &mut Transaction<'_, Postgres>,
        community_id: Uuid,
        user_id: Uuid,
        role_ids: &[Uuid],
        assigned_by: Option<Uuid>,
    ) -> Result<Vec<Uuid>, AppError> {
        let mut seen = HashSet::with_capacity(role_ids.len());
        for id in role_ids {
            if !seen.insert(*id) {
                return Err(AppError::ValidationError(
                    "A lista de cargos contém IDs duplicados.".to_string(),
                ));
            }
        }

        if !role_ids.is_empty() {
            #[derive(sqlx::FromRow)]
            struct RoleCheckRow {
                id: Uuid,
                is_default: bool,
            }

            let found = sqlx::query_as::<_, RoleCheckRow>(
                r#"
                SELECT id, is_default
                FROM community_roles
                WHERE community_id = $1 AND id = ANY($2)
                "#,
            )
            .bind(community_id)
            .bind(role_ids)
            .fetch_all(&mut **tx)
            .await?;

            if found.len() != role_ids.len() {
                return Err(AppError::BadRequest(
                    "Um ou mais cargos não pertencem a esta comunidade.".to_string(),
                ));
            }

            if found.iter().any(|r| r.is_default) {
                return Err(AppError::BadRequest(
                    "Não é permitido atribuir ou remover o cargo padrão @everyone.".to_string(),
                ));
            }
        }

        sqlx::query(
            r#"
            DELETE FROM community_member_roles
            WHERE community_id = $1 AND user_id = $2
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;

        for role_id in role_ids {
            sqlx::query(
                r#"
                INSERT INTO community_member_roles (community_id, user_id, role_id, assigned_by)
                VALUES ($1, $2, $3, $4)
                "#,
            )
            .bind(community_id)
            .bind(user_id)
            .bind(role_id)
            .bind(assigned_by)
            .execute(&mut **tx)
            .await
            .map_err(|e| {
                map_sqlx_error(
                    e,
                    "Cargo já atribuído ao membro.",
                    "Membro ou cargo inválido para esta comunidade.",
                )
            })?;
        }

        Ok(role_ids.to_vec())
    }

    pub async fn set_member_roles(
        &self,
        community_id: Uuid,
        user_id: Uuid,
        role_ids: &[Uuid],
        assigned_by: Option<Uuid>,
    ) -> Result<Vec<Uuid>, AppError> {
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let member_exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM community_members cm
                JOIN communities c ON c.id = cm.community_id AND c.deleted_at IS NULL
                WHERE cm.community_id = $1 AND cm.user_id = $2
            )
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

        if !member_exists {
            return Err(AppError::NotFound(
                "Membro não encontrado na comunidade.".to_string(),
            ));
        }

        let result =
            Self::set_member_roles_tx(&mut tx, community_id, user_id, role_ids, assigned_by)
                .await?;

        tx.commit().await?;
        Ok(result)
    }

    pub async fn add_member_role(
        &self,
        community_id: Uuid,
        user_id: Uuid,
        role_id: Uuid,
        assigned_by: Option<Uuid>,
    ) -> Result<bool, AppError> {
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let member_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2)",
        )
        .bind(community_id)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

        if !member_exists {
            return Err(AppError::NotFound(
                "Membro não encontrado na comunidade.".to_string(),
            ));
        }

        let is_default: Option<bool> = sqlx::query_scalar(
            "SELECT is_default FROM community_roles WHERE community_id = $1 AND id = $2",
        )
        .bind(community_id)
        .bind(role_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(is_default) = is_default else {
            return Err(AppError::NotFound(
                "Cargo não encontrado nesta comunidade.".to_string(),
            ));
        };

        if is_default {
            return Err(AppError::BadRequest(
                "Não é permitido atribuir manualmente o cargo padrão @everyone.".to_string(),
            ));
        }

        let res = sqlx::query(
            r#"
            INSERT INTO community_member_roles (community_id, user_id, role_id, assigned_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (community_id, user_id, role_id) DO NOTHING
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .bind(role_id)
        .bind(assigned_by)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            map_sqlx_error(
                e,
                "Cargo já atribuído ao membro.",
                "Membro ou cargo inválido para esta comunidade.",
            )
        })?;

        tx.commit().await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn remove_member_role(
        &self,
        community_id: Uuid,
        user_id: Uuid,
        role_id: Uuid,
    ) -> Result<bool, AppError> {
        let is_default: Option<bool> = sqlx::query_scalar(
            "SELECT is_default FROM community_roles WHERE community_id = $1 AND id = $2",
        )
        .bind(community_id)
        .bind(role_id)
        .fetch_optional(&self.pool)
        .await?;

        let Some(is_default) = is_default else {
            return Err(AppError::NotFound(
                "Cargo não encontrado nesta comunidade.".to_string(),
            ));
        };

        if is_default {
            return Err(AppError::BadRequest(
                "Não é permitido remover o cargo padrão @everyone.".to_string(),
            ));
        }

        let res = sqlx::query(
            r#"
            DELETE FROM community_member_roles
            WHERE community_id = $1 AND user_id = $2 AND role_id = $3
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .bind(role_id)
        .execute(&self.pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    // ==========================================
    // Categories, Channels & Overwrites
    // ==========================================

    pub async fn create_category(
        &self,
        community_id: Uuid,
        req: &CreateCategoryRequest,
    ) -> Result<CommunityCategory, AppError> {
        req.validate()?;
        let name = req.name.trim();

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM communities WHERE id = $1 AND deleted_at IS NULL)",
        )
        .bind(community_id)
        .fetch_one(&mut *tx)
        .await?;

        if !exists {
            return Err(AppError::NotFound("Comunidade não encontrada.".to_string()));
        }

        let position = match req.position {
            Some(pos) => pos,
            None => {
                let next_pos: i32 = sqlx::query_scalar(
                    "SELECT COALESCE(MAX(position) + 1, 0) FROM community_categories WHERE community_id = $1",
                )
                .bind(community_id)
                .fetch_one(&mut *tx)
                .await?;
                next_pos
            }
        };

        let category = sqlx::query_as::<_, CommunityCategory>(
            r#"
            INSERT INTO community_categories (community_id, name, position)
            VALUES ($1, $2, $3)
            RETURNING id, community_id, name, position, created_at, updated_at
            "#,
        )
        .bind(community_id)
        .bind(name)
        .bind(position)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| {
            map_sqlx_error(
                e,
                "Conflito ao criar categoria.",
                "Comunidade não encontrada.",
            )
        })?;

        tx.commit().await?;
        Ok(category)
    }

    pub async fn get_category(
        &self,
        community_id: Uuid,
        category_id: Uuid,
    ) -> Result<Option<CommunityCategory>, AppError> {
        let cat = sqlx::query_as::<_, CommunityCategory>(
            r#"
            SELECT id, community_id, name, position, created_at, updated_at
            FROM community_categories
            WHERE community_id = $1 AND id = $2
            "#,
        )
        .bind(community_id)
        .bind(category_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(cat)
    }

    pub async fn list_categories(
        &self,
        community_id: Uuid,
    ) -> Result<Vec<CommunityCategory>, AppError> {
        let categories = sqlx::query_as::<_, CommunityCategory>(
            r#"
            SELECT id, community_id, name, position, created_at, updated_at
            FROM community_categories
            WHERE community_id = $1
            ORDER BY position ASC, created_at ASC
            "#,
        )
        .bind(community_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(categories)
    }

    pub async fn update_category(
        &self,
        community_id: Uuid,
        category_id: Uuid,
        req: &UpdateCategoryRequest,
    ) -> Result<CommunityCategory, AppError> {
        req.validate()?;
        let name = req.name.as_deref().map(|s| s.trim().to_string());

        let updated = sqlx::query_as::<_, CommunityCategory>(
            r#"
            UPDATE community_categories
            SET
                name = COALESCE($3, name),
                position = COALESCE($4, position),
                updated_at = NOW()
            WHERE community_id = $1 AND id = $2
            RETURNING id, community_id, name, position, created_at, updated_at
            "#,
        )
        .bind(community_id)
        .bind(category_id)
        .bind(name)
        .bind(req.position)
        .fetch_optional(&self.pool)
        .await?;

        updated.ok_or_else(|| AppError::NotFound("Categoria não encontrada.".to_string()))
    }

    pub async fn delete_category(
        &self,
        community_id: Uuid,
        category_id: Uuid,
    ) -> Result<bool, AppError> {
        let res = sqlx::query(
            r#"
            DELETE FROM community_categories
            WHERE community_id = $1 AND id = $2
            "#,
        )
        .bind(community_id)
        .bind(category_id)
        .execute(&self.pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    pub async fn reorder_categories(
        &self,
        community_id: Uuid,
        req: &ReorderCategoriesRequest,
    ) -> Result<Vec<CommunityCategory>, AppError> {
        req.validate()?;
        let ids: Vec<Uuid> = req.items.iter().map(|i| i.id).collect();

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM community_categories
            WHERE community_id = $1 AND id = ANY($2)
            "#,
        )
        .bind(community_id)
        .bind(&ids)
        .fetch_one(&mut *tx)
        .await?;

        if count != ids.len() as i64 {
            return Err(AppError::BadRequest(
                "Uma ou mais categorias não pertencem a esta comunidade.".to_string(),
            ));
        }

        for item in &req.items {
            sqlx::query(
                r#"
                UPDATE community_categories
                SET position = $3, updated_at = NOW()
                WHERE community_id = $1 AND id = $2
                "#,
            )
            .bind(community_id)
            .bind(item.id)
            .bind(item.position)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        self.list_categories(community_id).await
    }

    pub async fn create_channel(
        &self,
        community_id: Uuid,
        req: &CreateChannelRequest,
    ) -> Result<CommunityChannel, AppError> {
        req.validate()?;

        let name = req.name.trim();
        let channel_type = req.channel_type.trim();
        let topic = normalize_optional_text(req.topic.as_deref());
        let is_private = req.is_private.unwrap_or(false);
        let is_read_only = req.is_read_only.unwrap_or(false);

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let comm_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM communities WHERE id = $1 AND deleted_at IS NULL)",
        )
        .bind(community_id)
        .fetch_one(&mut *tx)
        .await?;

        if !comm_exists {
            return Err(AppError::NotFound("Comunidade não encontrada.".to_string()));
        }

        if let Some(cat_id) = req.category_id {
            let cat_ok: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM community_categories WHERE id = $1 AND community_id = $2)",
            )
            .bind(cat_id)
            .bind(community_id)
            .fetch_one(&mut *tx)
            .await?;

            if !cat_ok {
                return Err(AppError::BadRequest(
                    "Categoria informada não pertence a esta comunidade.".to_string(),
                ));
            }
        }

        let position = match req.position {
            Some(pos) => pos,
            None => {
                let next_pos: i32 = sqlx::query_scalar(
                    r#"
                    SELECT COALESCE(MAX(position) + 1, 0)
                    FROM community_channels
                    WHERE community_id = $1
                      AND category_id IS NOT DISTINCT FROM $2
                      AND deleted_at IS NULL
                    "#,
                )
                .bind(community_id)
                .bind(req.category_id)
                .fetch_one(&mut *tx)
                .await?;
                next_pos
            }
        };

        let channel = sqlx::query_as::<_, CommunityChannel>(
            r#"
            INSERT INTO community_channels (
                community_id, category_id, name, channel_type, topic, position,
                is_private, is_read_only, voice_bitrate_bps, voice_user_limit
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING
                id, community_id, category_id, name, channel_type, topic, position,
                is_private, is_read_only, voice_bitrate_bps, voice_user_limit,
                created_at, updated_at, deleted_at
            "#,
        )
        .bind(community_id)
        .bind(req.category_id)
        .bind(name)
        .bind(channel_type)
        .bind(topic)
        .bind(position)
        .bind(is_private)
        .bind(is_read_only)
        .bind(req.voice_bitrate_bps)
        .bind(req.voice_user_limit)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| {
            map_sqlx_error(
                e,
                "Conflito ao criar canal.",
                "Comunidade ou categoria inválida.",
            )
        })?;

        tx.commit().await?;
        Ok(channel)
    }

    pub async fn get_channel(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
    ) -> Result<Option<CommunityChannel>, AppError> {
        let ch = sqlx::query_as::<_, CommunityChannel>(
            r#"
            SELECT
                id, community_id, category_id, name, channel_type, topic, position,
                is_private, is_read_only, voice_bitrate_bps, voice_user_limit,
                created_at, updated_at, deleted_at
            FROM community_channels
            WHERE community_id = $1 AND id = $2 AND deleted_at IS NULL
            "#,
        )
        .bind(community_id)
        .bind(channel_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(ch)
    }

    pub async fn get_channel_by_id(
        &self,
        channel_id: Uuid,
    ) -> Result<Option<CommunityChannel>, AppError> {
        let ch = sqlx::query_as::<_, CommunityChannel>(
            r#"
            SELECT
                ch.id, ch.community_id, ch.category_id, ch.name, ch.channel_type, ch.topic, ch.position,
                ch.is_private, ch.is_read_only, ch.voice_bitrate_bps, ch.voice_user_limit,
                ch.created_at, ch.updated_at, ch.deleted_at
            FROM community_channels ch
            JOIN communities c ON c.id = ch.community_id AND c.deleted_at IS NULL
            WHERE ch.id = $1 AND ch.deleted_at IS NULL
            "#,
        )
        .bind(channel_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(ch)
    }

    pub async fn list_channels(
        &self,
        community_id: Uuid,
    ) -> Result<Vec<CommunityChannel>, AppError> {
        let channels = sqlx::query_as::<_, CommunityChannel>(
            r#"
            SELECT
                id, community_id, category_id, name, channel_type, topic, position,
                is_private, is_read_only, voice_bitrate_bps, voice_user_limit,
                created_at, updated_at, deleted_at
            FROM community_channels
            WHERE community_id = $1 AND deleted_at IS NULL
            ORDER BY category_id NULLS FIRST, position ASC, created_at ASC
            "#,
        )
        .bind(community_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(channels)
    }

    pub async fn update_channel(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        req: &UpdateChannelRequest,
    ) -> Result<CommunityChannel, AppError> {
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let existing = sqlx::query_as::<_, CommunityChannel>(
            r#"
            SELECT
                id, community_id, category_id, name, channel_type, topic, position,
                is_private, is_read_only, voice_bitrate_bps, voice_user_limit,
                created_at, updated_at, deleted_at
            FROM community_channels
            WHERE community_id = $1 AND id = $2 AND deleted_at IS NULL
            FOR UPDATE
            "#,
        )
        .bind(community_id)
        .bind(channel_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Canal não encontrado.".to_string()))?;

        req.validate_for_channel_type(&existing.channel_type)?;

        if let Some(Some(cat_id)) = req.category_id {
            let cat_ok: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM community_categories WHERE id = $1 AND community_id = $2)",
            )
            .bind(cat_id)
            .bind(community_id)
            .fetch_one(&mut *tx)
            .await?;

            if !cat_ok {
                return Err(AppError::BadRequest(
                    "Categoria informada não pertence a esta comunidade.".to_string(),
                ));
            }
        }

        let (set_category_id, category_id) = match req.category_id {
            None => (false, None),
            Some(opt) => (true, opt),
        };
        let name = req.name.as_deref().map(|s| s.trim().to_string());
        let (set_topic, topic) = match &req.topic {
            None => (false, None),
            Some(opt) => (true, normalize_optional_text(opt.as_deref())),
        };
        let (set_bitrate, voice_bitrate_bps) = match req.voice_bitrate_bps {
            None => (false, None),
            Some(opt) => (true, opt),
        };
        let (set_user_limit, voice_user_limit) = match req.voice_user_limit {
            None => (false, None),
            Some(opt) => (true, opt),
        };

        let updated = sqlx::query_as::<_, CommunityChannel>(
            r#"
            UPDATE community_channels
            SET
                category_id = CASE WHEN $3 THEN $4 ELSE category_id END,
                name = COALESCE($5, name),
                topic = CASE WHEN $6 THEN $7 ELSE topic END,
                position = COALESCE($8, position),
                is_private = COALESCE($9, is_private),
                is_read_only = COALESCE($10, is_read_only),
                voice_bitrate_bps = CASE WHEN $11 THEN $12 ELSE voice_bitrate_bps END,
                voice_user_limit = CASE WHEN $13 THEN $14 ELSE voice_user_limit END,
                updated_at = NOW()
            WHERE community_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING
                id, community_id, category_id, name, channel_type, topic, position,
                is_private, is_read_only, voice_bitrate_bps, voice_user_limit,
                created_at, updated_at, deleted_at
            "#,
        )
        .bind(community_id)
        .bind(channel_id)
        .bind(set_category_id)
        .bind(category_id)
        .bind(name)
        .bind(set_topic)
        .bind(topic)
        .bind(req.position)
        .bind(req.is_private)
        .bind(req.is_read_only)
        .bind(set_bitrate)
        .bind(voice_bitrate_bps)
        .bind(set_user_limit)
        .bind(voice_user_limit)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(updated)
    }

    pub async fn delete_channel(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
    ) -> Result<bool, AppError> {
        let res = sqlx::query(
            r#"
            UPDATE community_channels
            SET deleted_at = NOW(), updated_at = NOW()
            WHERE community_id = $1 AND id = $2 AND deleted_at IS NULL
            "#,
        )
        .bind(community_id)
        .bind(channel_id)
        .execute(&self.pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    pub async fn reorder_channels(
        &self,
        community_id: Uuid,
        req: &ReorderChannelsRequest,
    ) -> Result<Vec<CommunityChannel>, AppError> {
        req.validate()?;
        let channel_ids: Vec<Uuid> = req.items.iter().map(|i| i.id).collect();
        let cat_ids: Vec<Uuid> = req
            .items
            .iter()
            .filter_map(|i| i.category_id)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let ch_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM community_channels
            WHERE community_id = $1 AND id = ANY($2) AND deleted_at IS NULL
            "#,
        )
        .bind(community_id)
        .bind(&channel_ids)
        .fetch_one(&mut *tx)
        .await?;

        if ch_count != channel_ids.len() as i64 {
            return Err(AppError::BadRequest(
                "Um ou mais canais não pertencem a esta comunidade.".to_string(),
            ));
        }

        if !cat_ids.is_empty() {
            let cat_count: i64 = sqlx::query_scalar(
                r#"
                SELECT COUNT(*)::bigint
                FROM community_categories
                WHERE community_id = $1 AND id = ANY($2)
                "#,
            )
            .bind(community_id)
            .bind(&cat_ids)
            .fetch_one(&mut *tx)
            .await?;

            if cat_count != cat_ids.len() as i64 {
                return Err(AppError::BadRequest(
                    "Uma ou mais categorias não pertencem a esta comunidade.".to_string(),
                ));
            }
        }

        for item in &req.items {
            sqlx::query(
                r#"
                UPDATE community_channels
                SET category_id = $3, position = $4, updated_at = NOW()
                WHERE community_id = $1 AND id = $2 AND deleted_at IS NULL
                "#,
            )
            .bind(community_id)
            .bind(item.id)
            .bind(item.category_id)
            .bind(item.position)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        self.list_channels(community_id).await
    }

    pub async fn list_channel_overwrites(
        &self,
        channel_id: Uuid,
    ) -> Result<Vec<ChannelPermissionOverwrite>, AppError> {
        let rows = sqlx::query_as::<_, ChannelPermissionOverwrite>(
            r#"
            SELECT
                id, channel_id, target_type, target_id,
                allow_bitmask, deny_bitmask, created_at, updated_at
            FROM channel_permission_overwrites
            WHERE channel_id = $1
            ORDER BY target_type ASC, created_at ASC
            "#,
        )
        .bind(channel_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    pub async fn upsert_channel_overwrite(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        req: &UpsertChannelOverwriteRequest,
    ) -> Result<ChannelPermissionOverwrite, AppError> {
        req.validate()?;
        let (allow_bitmask, deny_bitmask) = req.resolve_masks()?;
        let target_type = req.target_type.trim();

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let channel_exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM community_channels
                WHERE id = $1 AND community_id = $2 AND deleted_at IS NULL
            )
            "#,
        )
        .bind(channel_id)
        .bind(community_id)
        .fetch_one(&mut *tx)
        .await?;

        if !channel_exists {
            return Err(AppError::NotFound(
                "Canal não encontrado nesta comunidade.".to_string(),
            ));
        }

        match target_type {
            "role" => {
                let role_ok: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM community_roles WHERE id = $1 AND community_id = $2)",
                )
                .bind(req.target_id)
                .bind(community_id)
                .fetch_one(&mut *tx)
                .await?;
                if !role_ok {
                    return Err(AppError::BadRequest(
                        "O cargo alvo não pertence a esta comunidade.".to_string(),
                    ));
                }
            }
            "user" => {
                let member_ok: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM community_members WHERE user_id = $1 AND community_id = $2)",
                )
                .bind(req.target_id)
                .bind(community_id)
                .fetch_one(&mut *tx)
                .await?;
                if !member_ok {
                    return Err(AppError::BadRequest(
                        "O usuário alvo não é membro desta comunidade.".to_string(),
                    ));
                }
            }
            _ => unreachable!("validated by UpsertChannelOverwriteRequest::validate"),
        }

        let overwrite = sqlx::query_as::<_, ChannelPermissionOverwrite>(
            r#"
            INSERT INTO channel_permission_overwrites (
                channel_id, target_type, target_id, allow_bitmask, deny_bitmask
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (channel_id, target_type, target_id)
            DO UPDATE SET
                allow_bitmask = EXCLUDED.allow_bitmask,
                deny_bitmask = EXCLUDED.deny_bitmask,
                updated_at = NOW()
            RETURNING
                id, channel_id, target_type, target_id,
                allow_bitmask, deny_bitmask, created_at, updated_at
            "#,
        )
        .bind(channel_id)
        .bind(target_type)
        .bind(req.target_id)
        .bind(allow_bitmask)
        .bind(deny_bitmask)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(overwrite)
    }

    pub async fn delete_channel_overwrite(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        target_type: &str,
        target_id: Uuid,
    ) -> Result<bool, AppError> {
        let target_type = target_type.trim();
        validate_overwrite_target_type(target_type)?;

        let res = sqlx::query(
            r#"
            DELETE FROM channel_permission_overwrites o
            USING community_channels ch
            WHERE o.channel_id = ch.id
              AND ch.community_id = $1
              AND ch.deleted_at IS NULL
              AND o.channel_id = $2
              AND o.target_type = $3
              AND o.target_id = $4
            "#,
        )
        .bind(community_id)
        .bind(channel_id)
        .bind(target_type)
        .bind(target_id)
        .execute(&self.pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    // ==========================================
    // Messages & Read States
    // ==========================================

    async fn fetch_channel_message_with_author(
        &self,
        channel_id: Uuid,
        message_id: Uuid,
        viewer_id: Uuid,
        include_deleted: bool,
    ) -> Result<Option<ChannelMessageDto>, AppError> {
        let row = sqlx::query_as::<_, ChannelMessageWithAuthorRow>(
            r#"
            SELECT
                m.id,
                m.channel_id,
                m.community_id,
                m.sender_id,
                m.reply_to_message_id,
                m.content,
                m.client_message_id,
                m.attachments_json,
                m.created_at,
                m.edited_at,
                m.deleted_at,
                u.username AS author_username,
                p.display_name AS author_display_name,
                p.avatar_url AS author_avatar_url,
                cm.nickname AS author_nickname,
                (
                    SELECT cr.color
                    FROM community_member_roles cmr
                    JOIN community_roles cr ON cr.id = cmr.role_id
                    WHERE cmr.community_id = m.community_id
                      AND cmr.user_id = m.sender_id
                      AND cr.color IS NOT NULL
                    ORDER BY cr.position DESC, cr.created_at ASC
                    LIMIT 1
                ) AS author_role_color
            FROM channel_messages m
            LEFT JOIN users u ON u.id = m.sender_id
            LEFT JOIN user_profiles p ON p.user_id = m.sender_id
            LEFT JOIN community_members cm
              ON cm.community_id = m.community_id AND cm.user_id = m.sender_id
            WHERE m.channel_id = $1
              AND m.id = $2
              AND ($3::boolean OR m.deleted_at IS NULL)
            "#,
        )
        .bind(channel_id)
        .bind(message_id)
        .bind(include_deleted)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| r.into_dto(viewer_id)))
    }

    /// Persists a channel message, idempotently returning the existing message with author metadata
    /// when `(channel_id, author_id, client_message_id)` matches an existing submission.
    /// Returns `(ChannelMessageDto, is_new)`.
    pub async fn send_channel_message(
        &self,
        community_id: Uuid,
        channel_id: Uuid,
        author_id: Uuid,
        req: &SendChannelMessageRequest,
    ) -> Result<(ChannelMessageDto, bool), AppError> {
        req.validate()?;

        let content = req.content.trim();
        let client_message_id = normalize_optional_text(req.client_message_id.as_deref());
        let attachments = req
            .attachments
            .clone()
            .unwrap_or_else(|| serde_json::json!([]));

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let channel_ok: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM community_channels ch
                JOIN communities c ON c.id = ch.community_id AND c.deleted_at IS NULL
                WHERE ch.id = $1 AND ch.community_id = $2 AND ch.deleted_at IS NULL
            )
            "#,
        )
        .bind(channel_id)
        .bind(community_id)
        .fetch_one(&mut *tx)
        .await?;

        if !channel_ok {
            return Err(AppError::NotFound(
                "Canal não encontrado nesta comunidade.".to_string(),
            ));
        }

        if let Some(reply_id) = req.reply_to_message_id {
            let reply_ok: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM channel_messages WHERE id = $1 AND channel_id = $2)",
            )
            .bind(reply_id)
            .bind(channel_id)
            .fetch_one(&mut *tx)
            .await?;

            if !reply_ok {
                return Err(AppError::BadRequest(
                    "A mensagem respondida não pertence a este canal.".to_string(),
                ));
            }
        }

        if let Some(ref cid) = client_message_id {
            let inserted = sqlx::query_as::<_, ChannelMessage>(
                r#"
                INSERT INTO channel_messages (
                    channel_id, community_id, sender_id, reply_to_message_id,
                    content, client_message_id, attachments_json
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (sender_id, client_message_id)
                WHERE client_message_id IS NOT NULL
                DO NOTHING
                RETURNING
                    id, channel_id, community_id, sender_id, reply_to_message_id,
                    content, client_message_id, attachments_json,
                    created_at, edited_at, deleted_at
                "#,
            )
            .bind(channel_id)
            .bind(community_id)
            .bind(author_id)
            .bind(req.reply_to_message_id)
            .bind(content)
            .bind(cid)
            .bind(&attachments)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| {
                map_sqlx_error(
                    e,
                    "Conflito de idempotência na mensagem.",
                    "Canal, comunidade ou autor inválido.",
                )
            })?;

            if let Some(msg) = inserted {
                tx.commit().await?;
                let dto = self
                    .fetch_channel_message_with_author(channel_id, msg.id, author_id, true)
                    .await?
                    .ok_or_else(|| {
                        AppError::InternalError(
                            "Falha ao carregar mensagem recém-criada.".to_string(),
                        )
                    })?;
                return Ok((dto, true));
            }

            tx.rollback().await?;

            #[derive(sqlx::FromRow)]
            struct ExistingClientMessageRow {
                id: Uuid,
                channel_id: Uuid,
            }

            let existing = sqlx::query_as::<_, ExistingClientMessageRow>(
                r#"
                SELECT id, channel_id
                FROM channel_messages
                WHERE sender_id = $1 AND client_message_id = $2
                "#,
            )
            .bind(author_id)
            .bind(cid)
            .fetch_one(&self.pool)
            .await?;

            if existing.channel_id != channel_id {
                return Err(AppError::Conflict(
                    "client_message_id já utilizado em outro canal.".to_string(),
                ));
            }

            let dto = self
                .fetch_channel_message_with_author(channel_id, existing.id, author_id, true)
                .await?
                .ok_or_else(|| {
                    AppError::InternalError("Falha ao carregar mensagem existente.".to_string())
                })?;

            return Ok((dto, false));
        }

        let msg = sqlx::query_as::<_, ChannelMessage>(
            r#"
            INSERT INTO channel_messages (
                channel_id, community_id, sender_id, reply_to_message_id,
                content, client_message_id, attachments_json
            )
            VALUES ($1, $2, $3, $4, $5, NULL, $6)
            RETURNING
                id, channel_id, community_id, sender_id, reply_to_message_id,
                content, client_message_id, attachments_json,
                created_at, edited_at, deleted_at
            "#,
        )
        .bind(channel_id)
        .bind(community_id)
        .bind(author_id)
        .bind(req.reply_to_message_id)
        .bind(content)
        .bind(&attachments)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| {
            map_sqlx_error(
                e,
                "Conflito ao enviar mensagem.",
                "Canal, comunidade ou autor inválido.",
            )
        })?;

        tx.commit().await?;

        let dto = self
            .fetch_channel_message_with_author(channel_id, msg.id, author_id, true)
            .await?
            .ok_or_else(|| {
                AppError::InternalError("Falha ao carregar mensagem recém-criada.".to_string())
            })?;

        Ok((dto, true))
    }

    pub async fn list_channel_messages(
        &self,
        channel_id: Uuid,
        viewer_id: Uuid,
        query: &ChannelMessagesQuery,
    ) -> Result<ChannelMessagesPageDto, AppError> {
        query.validate()?;
        let limit = query.effective_limit();
        let fetch_limit = limit + 1;

        let cursor = if let Some(before_id) = query.before {
            let row = sqlx::query_as::<_, MessageCursorRow>(
                "SELECT created_at, id FROM channel_messages WHERE id = $1 AND channel_id = $2",
            )
            .bind(before_id)
            .bind(channel_id)
            .fetch_optional(&self.pool)
            .await?;

            if row.is_none() {
                return Ok(ChannelMessagesPageDto {
                    messages: Vec::new(),
                    has_more: false,
                    next_before: None,
                });
            }
            row
        } else {
            None
        };

        let rows = sqlx::query_as::<_, ChannelMessageWithAuthorRow>(
            r#"
            SELECT
                m.id,
                m.channel_id,
                m.community_id,
                m.sender_id,
                m.reply_to_message_id,
                m.content,
                m.client_message_id,
                m.attachments_json,
                m.created_at,
                m.edited_at,
                m.deleted_at,
                u.username AS author_username,
                p.display_name AS author_display_name,
                p.avatar_url AS author_avatar_url,
                cm.nickname AS author_nickname,
                (
                    SELECT cr.color
                    FROM community_member_roles cmr
                    JOIN community_roles cr ON cr.id = cmr.role_id
                    WHERE cmr.community_id = m.community_id
                      AND cmr.user_id = m.sender_id
                      AND cr.color IS NOT NULL
                    ORDER BY cr.position DESC, cr.created_at ASC
                    LIMIT 1
                ) AS author_role_color
            FROM channel_messages m
            LEFT JOIN users u ON u.id = m.sender_id
            LEFT JOIN user_profiles p ON p.user_id = m.sender_id
            LEFT JOIN community_members cm
              ON cm.community_id = m.community_id AND cm.user_id = m.sender_id
            WHERE m.channel_id = $1
              AND m.deleted_at IS NULL
              AND (
                  $2::timestamptz IS NULL
                  OR (m.created_at, m.id) < ($2::timestamptz, $3::uuid)
              )
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT $4
            "#,
        )
        .bind(channel_id)
        .bind(cursor.as_ref().map(|c| c.created_at))
        .bind(cursor.as_ref().map(|c| c.id))
        .bind(fetch_limit)
        .fetch_all(&self.pool)
        .await?;

        let has_more = rows.len() > limit as usize;
        let mut dtos: Vec<ChannelMessageDto> = rows
            .into_iter()
            .take(limit as usize)
            .map(|r| r.into_dto(viewer_id))
            .collect();

        dtos.reverse();
        let next_before = if has_more {
            dtos.first().map(|m| m.id)
        } else {
            None
        };

        Ok(ChannelMessagesPageDto {
            messages: dtos,
            has_more,
            next_before,
        })
    }

    pub async fn get_channel_message(
        &self,
        channel_id: Uuid,
        message_id: Uuid,
        viewer_id: Uuid,
    ) -> Result<Option<ChannelMessageDto>, AppError> {
        self.fetch_channel_message_with_author(channel_id, message_id, viewer_id, false)
            .await
    }

    pub async fn edit_channel_message(
        &self,
        channel_id: Uuid,
        message_id: Uuid,
        editor_id: Uuid,
        req: &EditChannelMessageRequest,
    ) -> Result<ChannelMessageDto, AppError> {
        req.validate()?;
        let content = req.content.trim();

        let updated_id: Option<Uuid> = sqlx::query_scalar(
            r#"
            UPDATE channel_messages
            SET content = $4, edited_at = NOW()
            WHERE channel_id = $1 AND id = $2 AND sender_id = $3 AND deleted_at IS NULL
            RETURNING id
            "#,
        )
        .bind(channel_id)
        .bind(message_id)
        .bind(editor_id)
        .bind(content)
        .fetch_optional(&self.pool)
        .await?;

        let Some(msg_id) = updated_id else {
            #[derive(sqlx::FromRow)]
            struct MsgStateRow {
                sender_id: Uuid,
                deleted_at: Option<DateTime<Utc>>,
            }

            let state = sqlx::query_as::<_, MsgStateRow>(
                "SELECT sender_id, deleted_at FROM channel_messages WHERE channel_id = $1 AND id = $2",
            )
            .bind(channel_id)
            .bind(message_id)
            .fetch_optional(&self.pool)
            .await?;

            return match state {
                None => Err(AppError::NotFound("Mensagem não encontrada.".to_string())),
                Some(s) if s.sender_id != editor_id => Err(AppError::Forbidden(
                    "Você só pode editar mensagens de sua autoria.".to_string(),
                )),
                Some(_) => Err(AppError::BadRequest(
                    "Mensagens excluídas não podem ser editadas.".to_string(),
                )),
            };
        };

        self.fetch_channel_message_with_author(channel_id, msg_id, editor_id, false)
            .await?
            .ok_or_else(|| AppError::NotFound("Mensagem não encontrada.".to_string()))
    }

    pub async fn soft_delete_channel_message(
        &self,
        channel_id: Uuid,
        message_id: Uuid,
    ) -> Result<bool, AppError> {
        let res = sqlx::query(
            r#"
            UPDATE channel_messages
            SET deleted_at = NOW()
            WHERE channel_id = $1 AND id = $2 AND deleted_at IS NULL
            "#,
        )
        .bind(channel_id)
        .bind(message_id)
        .execute(&self.pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    pub async fn mark_channel_read(
        &self,
        channel_id: Uuid,
        user_id: Uuid,
        last_read_message_id: Option<Uuid>,
    ) -> Result<ChannelReadStateDto, AppError> {
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let channel_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM community_channels WHERE id = $1 AND deleted_at IS NULL)",
        )
        .bind(channel_id)
        .fetch_one(&mut *tx)
        .await?;

        if !channel_exists {
            return Err(AppError::NotFound("Canal não encontrado.".to_string()));
        }

        let resolved_msg_id = match last_read_message_id {
            Some(msg_id) => {
                let msg_ok: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM channel_messages WHERE id = $1 AND channel_id = $2)",
                )
                .bind(msg_id)
                .bind(channel_id)
                .fetch_one(&mut *tx)
                .await?;

                if !msg_ok {
                    return Err(AppError::NotFound(
                        "Mensagem de referência não encontrada neste canal.".to_string(),
                    ));
                }
                Some(msg_id)
            }
            None => {
                sqlx::query_scalar::<_, Uuid>(
                    r#"
                    SELECT id
                    FROM channel_messages
                    WHERE channel_id = $1 AND deleted_at IS NULL
                    ORDER BY created_at DESC, id DESC
                    LIMIT 1
                    "#,
                )
                .bind(channel_id)
                .fetch_optional(&mut *tx)
                .await?
            }
        };

        let state = sqlx::query_as::<_, ChannelReadState>(
            r#"
            INSERT INTO channel_read_states (channel_id, user_id, last_read_message_id, last_read_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (channel_id, user_id)
            DO UPDATE SET
                last_read_message_id = COALESCE(EXCLUDED.last_read_message_id, channel_read_states.last_read_message_id),
                last_read_at = NOW()
            RETURNING channel_id, user_id, last_read_message_id, last_read_at
            "#,
        )
        .bind(channel_id)
        .bind(user_id)
        .bind(resolved_msg_id)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(state.into())
    }

    pub async fn list_channel_read_states_for_user(
        &self,
        community_id: Uuid,
        user_id: Uuid,
    ) -> Result<Vec<ChannelReadStateDto>, AppError> {
        let rows = sqlx::query_as::<_, ChannelReadState>(
            r#"
            SELECT crs.channel_id, crs.user_id, crs.last_read_message_id, crs.last_read_at
            FROM channel_read_states crs
            JOIN community_channels ch ON ch.id = crs.channel_id
            WHERE ch.community_id = $1
              AND ch.deleted_at IS NULL
              AND crs.user_id = $2
            ORDER BY crs.last_read_at DESC
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(Into::into).collect())
    }

    // ==========================================
    // Invites
    // ==========================================

    pub async fn create_invite(
        &self,
        community_id: Uuid,
        inviter_id: Uuid,
        req: &CreateInviteRequest,
    ) -> Result<CommunityInvite, AppError> {
        req.validate()?;

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let comm_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM communities WHERE id = $1 AND deleted_at IS NULL)",
        )
        .bind(community_id)
        .fetch_one(&mut *tx)
        .await?;

        if !comm_exists {
            return Err(AppError::NotFound("Comunidade não encontrada.".to_string()));
        }

        if let Some(ch_id) = req.channel_id {
            let ch_ok: bool = sqlx::query_scalar(
                r#"
                SELECT EXISTS(
                    SELECT 1 FROM community_channels
                    WHERE id = $1 AND community_id = $2 AND deleted_at IS NULL
                )
                "#,
            )
            .bind(ch_id)
            .bind(community_id)
            .fetch_one(&mut *tx)
            .await?;

            if !ch_ok {
                return Err(AppError::BadRequest(
                    "Canal informado não pertence a esta comunidade.".to_string(),
                ));
            }
        }

        let expires_at = req
            .expires_in_secs
            .map(|secs| Utc::now() + Duration::seconds(secs));

        tx.commit().await?;

        for attempt in 0..INVITE_CODE_MAX_RETRIES {
            let code = generate_invite_code();
            let res = sqlx::query_as::<_, CommunityInvite>(
                r#"
                INSERT INTO community_invites (
                    community_id, channel_id, inviter_id, code, max_uses, expires_at
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING
                    id, community_id, channel_id, inviter_id, code,
                    max_uses, uses_count, expires_at, revoked_at, revoked_by, created_at
                "#,
            )
            .bind(community_id)
            .bind(req.channel_id)
            .bind(inviter_id)
            .bind(&code)
            .bind(req.max_uses)
            .bind(expires_at)
            .fetch_one(&self.pool)
            .await;

            match res {
                Ok(invite) => return Ok(invite),
                Err(e)
                    if pg_err_code(&e).as_deref() == Some("23505")
                        && attempt + 1 < INVITE_CODE_MAX_RETRIES =>
                {
                    continue;
                }
                Err(e) => {
                    return Err(map_sqlx_error(
                        e,
                        "Não foi possível gerar um código de convite único.",
                        "Comunidade, canal ou usuário inválido.",
                    ));
                }
            }
        }

        Err(AppError::InternalError(
            "Falha ao gerar código de convite único.".to_string(),
        ))
    }

    pub async fn list_community_invites(
        &self,
        community_id: Uuid,
    ) -> Result<Vec<CommunityInvite>, AppError> {
        let invites = sqlx::query_as::<_, CommunityInvite>(
            r#"
            SELECT
                id, community_id, channel_id, inviter_id, code,
                max_uses, uses_count, expires_at, revoked_at, revoked_by, created_at
            FROM community_invites
            WHERE community_id = $1
            ORDER BY created_at DESC
            "#,
        )
        .bind(community_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(invites)
    }

    pub async fn get_invite_by_code(
        &self,
        code: &str,
    ) -> Result<Option<CommunityInvite>, AppError> {
        let trimmed = code.trim();
        let invite = sqlx::query_as::<_, CommunityInvite>(
            r#"
            SELECT
                id, community_id, channel_id, inviter_id, code,
                max_uses, uses_count, expires_at, revoked_at, revoked_by, created_at
            FROM community_invites
            WHERE code = $1
            "#,
        )
        .bind(trimmed)
        .fetch_optional(&self.pool)
        .await?;

        Ok(invite)
    }

    pub async fn get_invite_preview_by_code(
        &self,
        code: &str,
    ) -> Result<Option<InvitePreviewDto>, AppError> {
        let trimmed = code.trim();
        let row = sqlx::query_as::<_, InvitePreviewRow>(
            r#"
            SELECT
                i.code,
                c.id AS community_id,
                c.name AS community_name,
                c.description AS community_description,
                c.icon_url AS community_icon_url,
                c.initials AS community_initials,
                c.icon_bg AS community_icon_bg,
                c.accent_color AS community_accent_color,
                c.privacy AS community_privacy,
                i.channel_id,
                (
                    SELECT COUNT(*)::bigint
                    FROM community_members cm
                    WHERE cm.community_id = c.id
                ) AS member_count,
                i.expires_at,
                i.revoked_at,
                i.max_uses,
                i.uses_count
            FROM community_invites i
            JOIN communities c ON c.id = i.community_id AND c.deleted_at IS NULL
            WHERE i.code = $1
            "#,
        )
        .bind(trimmed)
        .fetch_optional(&self.pool)
        .await?;

        let now = Utc::now();
        Ok(row.map(|r| {
            let not_revoked = r.revoked_at.is_none();
            let not_expired = r.expires_at.map_or(true, |exp| exp > now);
            let has_uses = r.max_uses.map_or(true, |max| r.uses_count < max);
            InvitePreviewDto {
                code: r.code,
                community_id: r.community_id,
                community_name: r.community_name,
                community_description: r.community_description,
                community_icon_url: r.community_icon_url,
                community_initials: r.community_initials,
                community_icon_bg: r.community_icon_bg,
                community_accent_color: r.community_accent_color,
                community_privacy: r.community_privacy,
                channel_id: r.channel_id,
                member_count: r.member_count,
                expires_at: r.expires_at,
                is_valid: not_revoked && not_expired && has_uses,
            }
        }))
    }

    pub async fn revoke_invite(
        &self,
        community_id: Uuid,
        invite_id: Uuid,
        revoked_by: Uuid,
    ) -> Result<bool, AppError> {
        let res = sqlx::query(
            r#"
            UPDATE community_invites
            SET revoked_at = NOW(), revoked_by = $3
            WHERE community_id = $1 AND id = $2 AND revoked_at IS NULL
            "#,
        )
        .bind(community_id)
        .bind(invite_id)
        .bind(revoked_by)
        .execute(&self.pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    /// Atomically validates and consumes an invite under `FOR UPDATE` row lock:
    /// checks revoked/expired/exhausted, active community ban, and `user_blocks`
    /// between the accepting user and community owner/inviter.
    /// If already a member, returns `already_member: true` without incrementing `uses_count`.
    pub async fn accept_invite(
        &self,
        code: &str,
        user_id: Uuid,
    ) -> Result<AcceptInviteResponse, AppError> {
        let trimmed = code.trim();
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let invite = sqlx::query_as::<_, CommunityInvite>(
            r#"
            SELECT
                id, community_id, channel_id, inviter_id, code,
                max_uses, uses_count, expires_at, revoked_at, revoked_by, created_at
            FROM community_invites
            WHERE code = $1
            FOR UPDATE
            "#,
        )
        .bind(trimmed)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Convite não encontrado.".to_string()))?;

        let community = sqlx::query_as::<_, Community>(
            r#"
            SELECT
                id, owner_id, name, description, icon_url, initials,
                icon_bg, accent_color, appearance_preset, privacy,
                created_at, updated_at, deleted_at
            FROM communities
            WHERE id = $1 AND deleted_at IS NULL
            "#,
        )
        .bind(invite.community_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Comunidade não encontrada.".to_string()))?;

        if invite.revoked_at.is_some() {
            return Err(AppError::BadRequest("Este convite foi revogado.".to_string()));
        }

        if invite.expires_at.map_or(false, |exp| exp <= Utc::now()) {
            return Err(AppError::BadRequest("Este convite expirou.".to_string()));
        }

        if invite
            .max_uses
            .map_or(false, |max| invite.uses_count >= max)
        {
            return Err(AppError::BadRequest(
                "Este convite atingiu o limite máximo de usos.".to_string(),
            ));
        }

        let is_banned: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM community_bans
                WHERE community_id = $1
                  AND user_id = $2
                  AND (expires_at IS NULL OR expires_at > NOW())
            )
            "#,
        )
        .bind(community.id)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

        if is_banned {
            return Err(AppError::Forbidden(
                "Você está banido desta comunidade.".to_string(),
            ));
        }

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
        .bind(user_id)
        .bind(community.owner_id)
        .bind(invite.inviter_id)
        .fetch_one(&mut *tx)
        .await?;

        if is_blocked {
            return Err(AppError::Forbidden(
                "Não é possível ingressar na comunidade devido a um bloqueio entre usuários."
                    .to_string(),
            ));
        }

        let already_member: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM community_members
                WHERE community_id = $1 AND user_id = $2
            )
            "#,
        )
        .bind(community.id)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

        if !already_member {
            sqlx::query(
                r#"
                UPDATE community_invites
                SET uses_count = uses_count + 1
                WHERE id = $1
                "#,
            )
            .bind(invite.id)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                r#"
                INSERT INTO community_members (community_id, user_id)
                VALUES ($1, $2)
                ON CONFLICT (community_id, user_id) DO NOTHING
                "#,
            )
            .bind(community.id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;

        let community_dto = self
            .get_community_dto(community.id, user_id)
            .await?
            .ok_or_else(|| {
                AppError::InternalError(
                    "Falha ao carregar os dados da comunidade após ingresso.".to_string(),
                )
            })?;

        Ok(AcceptInviteResponse {
            community: community_dto,
            channel_id: invite.channel_id,
            already_member,
        })
    }

    // ==========================================
    // Moderation & Audit Logs
    // ==========================================

    pub async fn kick_member(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        target_user_id: Uuid,
        req: &KickMemberRequest,
    ) -> Result<(), AppError> {
        req.validate()?;
        let reason = normalize_optional_text(req.reason.as_deref());

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let owner_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT owner_id FROM communities WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(community_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(owner_id) = owner_id else {
            return Err(AppError::NotFound("Comunidade não encontrada.".to_string()));
        };

        if target_user_id == owner_id {
            return Err(AppError::Forbidden(
                "Não é possível expulsar o proprietário da comunidade.".to_string(),
            ));
        }

        let res = sqlx::query(
            r#"
            DELETE FROM community_members
            WHERE community_id = $1 AND user_id = $2
            "#,
        )
        .bind(community_id)
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;

        if res.rows_affected() == 0 {
            return Err(AppError::NotFound(
                "Membro não encontrado na comunidade.".to_string(),
            ));
        }

        Self::insert_audit_log_tx(
            &mut tx,
            community_id,
            actor_id,
            "member.kick",
            "user",
            Some(target_user_id),
            reason.as_deref(),
            serde_json::json!({}),
        )
        .await?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn ban_member(
        &self,
        community_id: Uuid,
        banned_by: Uuid,
        target_user_id: Uuid,
        req: &BanMemberRequest,
    ) -> Result<CommunityBan, AppError> {
        req.validate_with_now(Utc::now())?;
        let reason = normalize_optional_text(req.reason.as_deref());

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let owner_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT owner_id FROM communities WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(community_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(owner_id) = owner_id else {
            return Err(AppError::NotFound("Comunidade não encontrada.".to_string()));
        };

        if target_user_id == owner_id {
            return Err(AppError::Forbidden(
                "Não é possível banir o proprietário da comunidade.".to_string(),
            ));
        }

        let ban = sqlx::query_as::<_, CommunityBan>(
            r#"
            INSERT INTO community_bans (community_id, user_id, banned_by, reason, expires_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (community_id, user_id)
            DO UPDATE SET
                banned_by = EXCLUDED.banned_by,
                reason = EXCLUDED.reason,
                expires_at = EXCLUDED.expires_at,
                created_at = NOW()
            RETURNING community_id, user_id, banned_by, reason, expires_at, created_at
            "#,
        )
        .bind(community_id)
        .bind(target_user_id)
        .bind(banned_by)
        .bind(&reason)
        .bind(req.expires_at)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| {
            map_sqlx_error(
                e,
                "Conflito ao registrar banimento.",
                "Usuário alvo não encontrado.",
            )
        })?;

        sqlx::query(
            r#"
            DELETE FROM community_members
            WHERE community_id = $1 AND user_id = $2
            "#,
        )
        .bind(community_id)
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;

        if let Some(hours) = req.delete_message_hours {
            if hours > 0 {
                sqlx::query(
                    r#"
                    UPDATE channel_messages
                    SET deleted_at = NOW()
                    WHERE community_id = $1
                      AND sender_id = $2
                      AND deleted_at IS NULL
                      AND created_at >= NOW() - ($3::integer * INTERVAL '1 hour')
                    "#,
                )
                .bind(community_id)
                .bind(target_user_id)
                .bind(hours)
                .execute(&mut *tx)
                .await?;
            }
        }

        Self::insert_audit_log_tx(
            &mut tx,
            community_id,
            banned_by,
            "member.ban",
            "user",
            Some(target_user_id),
            reason.as_deref(),
            serde_json::json!({
                "expires_at": req.expires_at,
                "delete_message_hours": req.delete_message_hours,
            }),
        )
        .await?;

        tx.commit().await?;
        Ok(ban)
    }

    pub async fn unban_member(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        target_user_id: Uuid,
    ) -> Result<bool, AppError> {
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let res = sqlx::query(
            r#"
            DELETE FROM community_bans
            WHERE community_id = $1 AND user_id = $2
            "#,
        )
        .bind(community_id)
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;

        let removed = res.rows_affected() > 0;
        if removed {
            Self::insert_audit_log_tx(
                &mut tx,
                community_id,
                actor_id,
                "member.unban",
                "user",
                Some(target_user_id),
                None,
                serde_json::json!({}),
            )
            .await?;
        }

        tx.commit().await?;
        Ok(removed)
    }

    pub async fn list_bans(&self, community_id: Uuid) -> Result<Vec<CommunityBanDto>, AppError> {
        let rows = sqlx::query_as::<_, BanWithProfileRow>(
            r#"
            SELECT
                b.community_id,
                b.user_id,
                u.username,
                p.display_name,
                b.banned_by,
                b.reason,
                b.expires_at,
                b.created_at
            FROM community_bans b
            LEFT JOIN users u ON u.id = b.user_id
            LEFT JOIN user_profiles p ON p.user_id = b.user_id
            WHERE b.community_id = $1
              AND (b.expires_at IS NULL OR b.expires_at > NOW())
            ORDER BY b.created_at DESC
            "#,
        )
        .bind(community_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| CommunityBanDto {
                community_id: r.community_id,
                user_id: r.user_id,
                username: r.username,
                display_name: r.display_name,
                banned_by: r.banned_by,
                reason: r.reason,
                expires_at: r.expires_at,
                created_at: r.created_at,
            })
            .collect())
    }

    pub async fn get_active_ban(
        &self,
        community_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<CommunityBan>, AppError> {
        let ban = sqlx::query_as::<_, CommunityBan>(
            r#"
            SELECT community_id, user_id, banned_by, reason, expires_at, created_at
            FROM community_bans
            WHERE community_id = $1
              AND user_id = $2
              AND (expires_at IS NULL OR expires_at > NOW())
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(ban)
    }

    pub async fn upsert_member_mute(
        &self,
        community_id: Uuid,
        user_id: Uuid,
        muted_by: Uuid,
        req: &MuteMemberRequest,
    ) -> Result<CommunityMemberMute, AppError> {
        req.validate()?;
        let reason = normalize_optional_text(req.reason.as_deref());

        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        let member_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2)",
        )
        .bind(community_id)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

        if !member_exists {
            return Err(AppError::NotFound(
                "Membro não encontrado na comunidade.".to_string(),
            ));
        }

        let (set_text, text_until) = match req.text_muted_until {
            None => (false, None),
            Some(opt) => (true, opt),
        };
        let (set_voice, voice_until) = match req.voice_muted_until {
            None => (false, None),
            Some(opt) => (true, opt),
        };
        let (set_server_voice, server_voice_muted) = match req.server_voice_muted {
            None => (false, false),
            Some(v) => (true, v),
        };

        let mute = sqlx::query_as::<_, CommunityMemberMute>(
            r#"
            INSERT INTO community_member_mutes (
                community_id, user_id, muted_by, reason,
                text_muted_until, voice_muted_until, server_voice_muted, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (community_id, user_id)
            DO UPDATE SET
                muted_by = EXCLUDED.muted_by,
                reason = COALESCE(EXCLUDED.reason, community_member_mutes.reason),
                text_muted_until = CASE WHEN $8 THEN EXCLUDED.text_muted_until ELSE community_member_mutes.text_muted_until END,
                voice_muted_until = CASE WHEN $9 THEN EXCLUDED.voice_muted_until ELSE community_member_mutes.voice_muted_until END,
                server_voice_muted = CASE WHEN $10 THEN EXCLUDED.server_voice_muted ELSE community_member_mutes.server_voice_muted END,
                updated_at = NOW()
            RETURNING
                community_id, user_id, muted_by, reason,
                text_muted_until, voice_muted_until, server_voice_muted, updated_at
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .bind(muted_by)
        .bind(reason)
        .bind(text_until)
        .bind(voice_until)
        .bind(server_voice_muted)
        .bind(set_text)
        .bind(set_voice)
        .bind(set_server_voice)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(mute)
    }

    pub async fn get_member_mute(
        &self,
        community_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<CommunityMemberMute>, AppError> {
        let mute = sqlx::query_as::<_, CommunityMemberMute>(
            r#"
            SELECT
                community_id, user_id, muted_by, reason,
                text_muted_until, voice_muted_until, server_voice_muted, updated_at
            FROM community_member_mutes
            WHERE community_id = $1 AND user_id = $2
            "#,
        )
        .bind(community_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(mute)
    }

    pub async fn list_member_mutes(
        &self,
        community_id: Uuid,
    ) -> Result<Vec<CommunityMemberMute>, AppError> {
        let mutes = sqlx::query_as::<_, CommunityMemberMute>(
            r#"
            SELECT
                community_id, user_id, muted_by, reason,
                text_muted_until, voice_muted_until, server_voice_muted, updated_at
            FROM community_member_mutes
            WHERE community_id = $1
            ORDER BY updated_at DESC
            "#,
        )
        .bind(community_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(mutes)
    }

    async fn insert_audit_log_tx(
        tx: &mut Transaction<'_, Postgres>,
        community_id: Uuid,
        actor_id: Uuid,
        action: &str,
        target_type: &str,
        target_id: Option<Uuid>,
        reason: Option<&str>,
        metadata: serde_json::Value,
    ) -> Result<CommunityAuditLog, AppError> {
        let log = sqlx::query_as::<_, CommunityAuditLog>(
            r#"
            INSERT INTO community_audit_logs (
                community_id, actor_id, action, target_type, target_id, reason, metadata_json
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING
                id, community_id, actor_id, action, target_type,
                target_id, reason, metadata_json, created_at
            "#,
        )
        .bind(community_id)
        .bind(actor_id)
        .bind(action)
        .bind(target_type)
        .bind(target_id)
        .bind(reason)
        .bind(metadata)
        .fetch_one(&mut **tx)
        .await?;

        Ok(log)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_audit_log(
        &self,
        community_id: Uuid,
        actor_id: Uuid,
        action: &str,
        target_type: &str,
        target_id: Option<Uuid>,
        reason: Option<&str>,
        metadata: serde_json::Value,
    ) -> Result<CommunityAuditLog, AppError> {
        let clean_reason = normalize_optional_text(reason);
        let log = sqlx::query_as::<_, CommunityAuditLog>(
            r#"
            INSERT INTO community_audit_logs (
                community_id, actor_id, action, target_type, target_id, reason, metadata_json
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING
                id, community_id, actor_id, action, target_type,
                target_id, reason, metadata_json, created_at
            "#,
        )
        .bind(community_id)
        .bind(actor_id)
        .bind(action)
        .bind(target_type)
        .bind(target_id)
        .bind(clean_reason)
        .bind(metadata)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| {
            map_sqlx_error(
                e,
                "Conflito ao registrar log de auditoria.",
                "Comunidade ou ator inválido.",
            )
        })?;

        Ok(log)
    }

    pub async fn list_audit_logs(
        &self,
        community_id: Uuid,
        query: &AuditLogsQuery,
    ) -> Result<Vec<CommunityAuditLogDto>, AppError> {
        query.validate()?;
        let limit = query.effective_limit();
        let action_filter = normalize_optional_text(query.action.as_deref());

        let cursor = if let Some(before_id) = query.before {
            let row = sqlx::query_as::<_, MessageCursorRow>(
                "SELECT created_at, id FROM community_audit_logs WHERE id = $1 AND community_id = $2",
            )
            .bind(before_id)
            .bind(community_id)
            .fetch_optional(&self.pool)
            .await?;

            if row.is_none() {
                return Ok(Vec::new());
            }
            row
        } else {
            None
        };

        let rows = sqlx::query_as::<_, AuditLogWithActorRow>(
            r#"
            SELECT
                l.id,
                l.community_id,
                l.actor_id,
                u.username AS actor_username,
                l.action,
                l.target_type,
                l.target_id,
                l.reason,
                l.metadata_json,
                l.created_at
            FROM community_audit_logs l
            LEFT JOIN users u ON u.id = l.actor_id
            WHERE l.community_id = $1
              AND ($2::text IS NULL OR l.action = $2)
              AND ($3::uuid IS NULL OR l.actor_id = $3)
              AND (
                  $4::timestamptz IS NULL
                  OR (l.created_at, l.id) < ($4::timestamptz, $5::uuid)
              )
            ORDER BY l.created_at DESC, l.id DESC
            LIMIT $6
            "#,
        )
        .bind(community_id)
        .bind(action_filter)
        .bind(query.actor_id)
        .bind(cursor.as_ref().map(|c| c.created_at))
        .bind(cursor.as_ref().map(|c| c.id))
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| CommunityAuditLogDto {
                id: r.id,
                community_id: r.community_id,
                actor_id: r.actor_id,
                actor_username: r.actor_username,
                action: r.action,
                target_type: r.target_type,
                target_id: r.target_id,
                reason: r.reason,
                metadata: r.metadata_json,
                created_at: r.created_at,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_code_generator_produces_valid_alphanumeric_codes() {
        for _ in 0..32 {
            let code = generate_invite_code();
            assert_eq!(code.len(), INVITE_CODE_LEN);
            assert!(code.bytes().all(|b| INVITE_CODE_ALPHABET.contains(&b)));
        }
    }

    #[test]
    fn normalize_optional_text_trims_and_filters_empty() {
        assert_eq!(normalize_optional_text(None), None);
        assert_eq!(normalize_optional_text(Some("   ")), None);
        assert_eq!(
            normalize_optional_text(Some("  hello nexus  ")),
            Some("hello nexus".to_string())
        );
    }

    #[test]
    fn sqlx_error_mapper_handles_non_database_errors() {
        let mapped = map_sqlx_error(
            sqlx::Error::RowNotFound,
            "conflict",
            "fk",
        );
        assert!(matches!(mapped, AppError::DatabaseError(_)));
    }
}
