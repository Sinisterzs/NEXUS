use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::ChannelPermissionOverwrite;

// ==========================================
// 63-bit Permission Constants & Bitmask Helpers (re-exported from models)
// ==========================================

pub use crate::models::communities::{
    bitmask_to_flags, flags_to_bitmask, format_bitmask_str, has_permission, parse_bitmask_str,
    try_bitmask_to_flags, validate_bitmask, ALL_DEFINED_PERMISSIONS, DEFAULT_ADMIN_PERMISSIONS,
    DEFAULT_EVERYONE_PERMISSIONS, DEFAULT_MODERATOR_PERMISSIONS, PERMISSION_DEFINITIONS,
    PERM_ADMINISTRATOR, PERM_CONNECT_VOICE, PERM_CREATE_INVITES, PERM_MANAGE_CHANNELS,
    PERM_MANAGE_COMMUNITY, PERM_MANAGE_MESSAGES, PERM_MANAGE_ROLES, PERM_MODERATE_MEMBERS,
    PERM_MUTE_MEMBERS_VOICE, PERM_READ_MESSAGE_HISTORY, PERM_SCREEN_SHARE, PERM_SEND_MESSAGES,
    PERM_SPEAK, PERM_VIEW_AUDIT_LOG, PERM_VIEW_CHANNEL,
};

const PRIVATE_CHANNEL_HIDDEN_PERMS: i64 = PERM_SEND_MESSAGES
    | PERM_CONNECT_VOICE
    | PERM_SPEAK
    | PERM_SCREEN_SHARE
    | PERM_READ_MESSAGE_HISTORY;

// ==========================================
// Authoritative Permission Resolution
// ==========================================

#[derive(Debug, Clone)]
pub struct ChannelOverwriteRule {
    pub target_type: String,
    pub target_id: Uuid,
    pub allow_bitmask: i64,
    pub deny_bitmask: i64,
}

impl From<&ChannelPermissionOverwrite> for ChannelOverwriteRule {
    fn from(value: &ChannelPermissionOverwrite) -> Self {
        Self {
            target_type: value.target_type.clone(),
            target_id: value.target_id,
            allow_bitmask: value.allow_bitmask,
            deny_bitmask: value.deny_bitmask,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolveChannelPermissionsInput<'a> {
    pub actor_id: Uuid,
    pub owner_id: Uuid,
    pub is_member: bool,
    pub is_banned: bool,
    pub everyone_role_id: Option<Uuid>,
    pub everyone_permissions: i64,
    pub member_role_ids: &'a [Uuid],
    pub member_role_permissions: &'a [i64],
    pub is_private: bool,
    pub is_read_only: bool,
    pub overwrites: &'a [ChannelOverwriteRule],
    pub text_muted_until: Option<DateTime<Utc>>,
    pub voice_muted_until: Option<DateTime<Utc>>,
    pub server_voice_muted: bool,
    pub now: DateTime<Utc>,
}

/// Resolves community-wide effective permissions for a member.
pub fn resolve_community_permissions(
    actor_id: Uuid,
    owner_id: Uuid,
    is_member: bool,
    is_banned: bool,
    everyone_permissions: i64,
    member_role_permissions: &[i64],
) -> i64 {
    if !is_member || is_banned {
        return 0;
    }

    if actor_id == owner_id {
        return ALL_DEFINED_PERMISSIONS;
    }

    let mut base = everyone_permissions & ALL_DEFINED_PERMISSIONS;
    for role_perms in member_role_permissions {
        base |= *role_perms & ALL_DEFINED_PERMISSIONS;
    }

    if (base & PERM_ADMINISTRATOR) != 0 {
        return ALL_DEFINED_PERMISSIONS;
    }

    base
}

/// Resolves effective permissions for a member inside a specific channel,
/// following Section 2.2 (owner bypass, `@everyone` + roles, `ADMINISTRATOR`,
/// channel overwrites `@everyone` -> OR roles -> `user_id`, `is_read_only`,
/// `is_private`, and active mutes).
pub fn resolve_channel_permissions(input: &ResolveChannelPermissionsInput<'_>) -> i64 {
    if !input.is_member || input.is_banned {
        return 0;
    }

    // Step 2: Owner bypasses all channel and role restrictions.
    if input.actor_id == input.owner_id {
        return ALL_DEFINED_PERMISSIONS;
    }

    // Step 3: Aggregate @everyone + member's roles.
    let mut base = input.everyone_permissions & ALL_DEFINED_PERMISSIONS;
    for role_perms in input.member_role_permissions {
        base |= *role_perms & ALL_DEFINED_PERMISSIONS;
    }

    // Step 4: ADMINISTRATOR bypasses channel overwrites, read-only, and private flags.
    let mut perms = if (base & PERM_ADMINISTRATOR) != 0 {
        ALL_DEFINED_PERMISSIONS
    } else {
        let mut current = base;

        // Defense-in-depth for private channels: require explicit overwrite grant unless
        // @everyone overwrite explicitly allows VIEW_CHANNEL.
        if input.is_private {
            current &= !PERM_VIEW_CHANNEL;
        }

        // Step 5a: @everyone overwrite
        if let Some(everyone_id) = input.everyone_role_id {
            for ow in input
                .overwrites
                .iter()
                .filter(|o| o.target_type == "role" && o.target_id == everyone_id)
            {
                let deny = ow.deny_bitmask & ALL_DEFINED_PERMISSIONS;
                let allow = ow.allow_bitmask & ALL_DEFINED_PERMISSIONS;
                current = (current & !deny) | allow;
            }
        }

        // Step 5b: Member role overwrites (excluding @everyone which was already applied in 5a)
        let mut roles_deny = 0_i64;
        let mut roles_allow = 0_i64;
        for ow in input.overwrites.iter().filter(|o| {
            o.target_type == "role"
                && Some(o.target_id) != input.everyone_role_id
                && input.member_role_ids.contains(&o.target_id)
        }) {
            roles_deny |= ow.deny_bitmask & ALL_DEFINED_PERMISSIONS;
            roles_allow |= ow.allow_bitmask & ALL_DEFINED_PERMISSIONS;
        }
        current = (current & !roles_deny) | roles_allow;

        // Step 5c: User-specific overwrite
        let mut user_deny = 0_i64;
        let mut user_allow = 0_i64;
        for ow in input
            .overwrites
            .iter()
            .filter(|o| o.target_type == "user" && o.target_id == input.actor_id)
        {
            user_deny |= ow.deny_bitmask & ALL_DEFINED_PERMISSIONS;
            user_allow |= ow.allow_bitmask & ALL_DEFINED_PERMISSIONS;
        }
        current = (current & !user_deny) | user_allow;

        // Step 6: Read-only channel rule
        if input.is_read_only
            && (current & (PERM_MANAGE_CHANNELS | PERM_MANAGE_COMMUNITY | PERM_ADMINISTRATOR)) == 0
        {
            let explicit_role_send_allow =
                (roles_allow & PERM_SEND_MESSAGES) != 0 && (user_deny & PERM_SEND_MESSAGES) == 0;
            let explicit_user_send_allow = (user_allow & PERM_SEND_MESSAGES) != 0;
            if !explicit_role_send_allow && !explicit_user_send_allow {
                current &= !PERM_SEND_MESSAGES;
            }
        }

        // Step 7: Private channel rule
        if input.is_private && (current & PERM_VIEW_CHANNEL) == 0 {
            current &= !PRIVATE_CHANNEL_HIDDEN_PERMS;
        }

        current
    };

    // Step 8: Active member mutes
    let is_text_muted = input
        .text_muted_until
        .map_or(false, |until| until > input.now);
    if is_text_muted {
        perms &= !PERM_SEND_MESSAGES;
    }

    let is_voice_muted = match input.voice_muted_until {
        Some(until) => until > input.now,
        None => input.server_voice_muted,
    };
    if is_voice_muted {
        perms &= !PERM_SPEAK;
    }

    perms
}

// ==========================================
// Hierarchy & Anti-Escalation Guards
// ==========================================

/// Computes the effective top role position for a member (`i32::MAX` for community owner).
pub fn compute_actor_top_position(actor_id: Uuid, owner_id: Uuid, role_positions: &[i32]) -> i32 {
    if actor_id == owner_id {
        return i32::MAX;
    }
    role_positions.iter().copied().max().unwrap_or(0)
}

/// Validates role creation, modification, or reordering against strict hierarchy and bit-escalation rules.
#[allow(clippy::too_many_arguments)]
pub fn ensure_can_manage_role(
    actor_id: Uuid,
    owner_id: Uuid,
    actor_top_pos: i32,
    actor_community_perms: i64,
    target_role_pos: Option<i32>,
    new_pos: Option<i32>,
    requested_perms: Option<i64>,
    is_default_role: bool,
) -> Result<(), AppError> {
    if let Some(perms) = requested_perms {
        validate_bitmask(perms)?;
    }

    if let Some(pos) = new_pos {
        if pos < 0 || pos == i32::MAX {
            return Err(AppError::ValidationError(
                "A posição do cargo deve estar entre 0 e 2147483646.".to_string(),
            ));
        }
        if is_default_role && pos != 0 {
            return Err(AppError::BadRequest(
                "Não é possível alterar a posição do cargo padrão @everyone.".to_string(),
            ));
        }
        if !is_default_role && pos == 0 {
            return Err(AppError::ValidationError(
                "Cargos personalizados devem possuir posição maior ou igual a 1.".to_string(),
            ));
        }
    }

    if actor_id == owner_id {
        return Ok(());
    }

    if (actor_community_perms & (PERM_MANAGE_ROLES | PERM_ADMINISTRATOR)) == 0 {
        return Err(AppError::Forbidden(
            "Você não possui permissão para gerenciar cargos.".to_string(),
        ));
    }

    if let Some(t_pos) = target_role_pos {
        if t_pos >= actor_top_pos {
            return Err(AppError::Forbidden(
                "Não é possível gerenciar um cargo de posição igual ou superior à sua.".to_string(),
            ));
        }
    }

    if let Some(n_pos) = new_pos {
        if n_pos >= actor_top_pos {
            return Err(AppError::Forbidden(
                "Não é possível posicionar um cargo em nível igual ou superior ao seu.".to_string(),
            ));
        }
    }

    if let Some(req_perms) = requested_perms {
        if (req_perms & PERM_ADMINISTRATOR) != 0 {
            return Err(AppError::Forbidden(
                "Apenas o proprietário da comunidade pode conceder a permissão ADMINISTRATOR."
                    .to_string(),
            ));
        }
        if (actor_community_perms & PERM_ADMINISTRATOR) == 0
            && (req_perms & !actor_community_perms) != 0
        {
            return Err(AppError::Forbidden(
                "Não é possível conceder permissões que você não possui.".to_string(),
            ));
        }
    }

    Ok(())
}

/// Validates deletion of a community role, forbidding deletion of `@everyone` and enforcing hierarchy.
pub fn ensure_can_delete_role(
    actor_id: Uuid,
    owner_id: Uuid,
    actor_top_pos: i32,
    actor_community_perms: i64,
    target_role_pos: i32,
    is_default_role: bool,
) -> Result<(), AppError> {
    if is_default_role {
        return Err(AppError::BadRequest(
            "Não é permitido excluir o cargo padrão @everyone.".to_string(),
        ));
    }

    ensure_can_manage_role(
        actor_id,
        owner_id,
        actor_top_pos,
        actor_community_perms,
        Some(target_role_pos),
        None,
        None,
        false,
    )
}

/// Validates assigning or removing a role on a member against hierarchy and bit-escalation rules.
#[allow(clippy::too_many_arguments)]
pub fn ensure_can_assign_role(
    actor_id: Uuid,
    owner_id: Uuid,
    actor_top_pos: i32,
    target_top_pos: i32,
    role_pos: i32,
    role_perms: i64,
    actor_community_perms: i64,
    is_default_role: bool,
) -> Result<(), AppError> {
    if is_default_role {
        return Err(AppError::BadRequest(
            "Não é permitido atribuir ou remover o cargo padrão @everyone.".to_string(),
        ));
    }

    validate_bitmask(role_perms)?;

    if actor_id == owner_id {
        return Ok(());
    }

    if (actor_community_perms & (PERM_MANAGE_ROLES | PERM_ADMINISTRATOR)) == 0 {
        return Err(AppError::Forbidden(
            "Você não possui permissão para atribuir ou remover cargos.".to_string(),
        ));
    }

    if actor_top_pos <= target_top_pos {
        return Err(AppError::Forbidden(
            "Você não possui hierarquia suficiente para alterar os cargos deste membro.".to_string(),
        ));
    }

    if role_pos >= actor_top_pos {
        return Err(AppError::Forbidden(
            "Não é possível atribuir ou remover um cargo de posição igual ou superior à sua."
                .to_string(),
        ));
    }

    if (role_perms & PERM_ADMINISTRATOR) != 0 {
        return Err(AppError::Forbidden(
            "Apenas o proprietário da comunidade pode atribuir cargos com ADMINISTRATOR."
                .to_string(),
        ));
    }

    if (actor_community_perms & PERM_ADMINISTRATOR) == 0
        && (role_perms & !actor_community_perms) != 0
    {
        return Err(AppError::Forbidden(
            "Não é possível atribuir um cargo com permissões que você não possui.".to_string(),
        ));
    }

    Ok(())
}

/// Validates hierarchy for moderation actions (`kick`, `ban`, `mute`) between members.
pub fn ensure_can_moderate_member(
    actor_id: Uuid,
    owner_id: Uuid,
    actor_top_pos: i32,
    target_id: Uuid,
    target_top_pos: i32,
) -> Result<(), AppError> {
    if actor_id == target_id {
        return Err(AppError::BadRequest(
            "Você não pode aplicar ações de moderação em si mesmo.".to_string(),
        ));
    }

    if target_id == owner_id {
        return Err(AppError::Forbidden(
            "Não é possível moderar o proprietário da comunidade.".to_string(),
        ));
    }

    if actor_id == owner_id {
        return Ok(());
    }

    if actor_top_pos <= target_top_pos {
        return Err(AppError::Forbidden(
            "Você não possui hierarquia suficiente para moderar este membro.".to_string(),
        ));
    }

    Ok(())
}

/// Validates creating/updating channel permission overwrites against privilege escalation.
pub fn ensure_can_manage_channel_overwrite(
    actor_id: Uuid,
    owner_id: Uuid,
    actor_community_perms: i64,
    allow_bitmask: i64,
    deny_bitmask: i64,
) -> Result<(), AppError> {
    validate_bitmask(allow_bitmask)?;
    validate_bitmask(deny_bitmask)?;

    if actor_id == owner_id {
        return Ok(());
    }

    if (actor_community_perms & (PERM_MANAGE_CHANNELS | PERM_MANAGE_ROLES | PERM_ADMINISTRATOR)) == 0
    {
        return Err(AppError::Forbidden(
            "Você não possui permissão para alterar sobrescritas de canal.".to_string(),
        ));
    }

    if (allow_bitmask & PERM_ADMINISTRATOR) != 0 {
        return Err(AppError::Forbidden(
            "A permissão ADMINISTRATOR não pode ser concedida em sobrescritas de canal."
                .to_string(),
        ));
    }

    if (actor_community_perms & PERM_ADMINISTRATOR) == 0
        && (allow_bitmask & !actor_community_perms) != 0
    {
        return Err(AppError::Forbidden(
            "Não é possível conceder em um canal permissões que você não possui.".to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn bit_constants_stay_within_63_bits() {
        assert_eq!(PERM_MANAGE_COMMUNITY, 1);
        assert_eq!(PERM_MODERATE_MEMBERS, 1 << 8);
        assert_eq!(PERM_VIEW_AUDIT_LOG, 1 << 13);
        assert_eq!(PERM_ADMINISTRATOR, 1_i64 << 62);
        assert!(ALL_DEFINED_PERMISSIONS > 0);
        assert!(PERM_ADMINISTRATOR > 0);
        assert_eq!(DEFAULT_EVERYONE_PERMISSIONS & PERM_ADMINISTRATOR, 0);
        assert_eq!(DEFAULT_EVERYONE_PERMISSIONS & PERM_MANAGE_ROLES, 0);
        assert!(has_permission(
            DEFAULT_EVERYONE_PERMISSIONS,
            PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_CONNECT_VOICE | PERM_SCREEN_SHARE
        ));
    }

    #[test]
    fn bitmask_string_and_flag_roundtrip() {
        let mask = DEFAULT_EVERYONE_PERMISSIONS;
        let s = format_bitmask_str(mask);
        assert_eq!(parse_bitmask_str(&s).unwrap(), mask);

        let flags = bitmask_to_flags(mask);
        assert_eq!(flags.len(), 7);
        assert!(flags.contains(&"VIEW_CHANNEL".to_string()));
        assert!(flags.contains(&"SEND_MESSAGES".to_string()));
        assert_eq!(flags_to_bitmask(&flags).unwrap(), mask);

        let admin_str = PERM_ADMINISTRATOR.to_string();
        assert_eq!(parse_bitmask_str(&admin_str).unwrap(), PERM_ADMINISTRATOR);
        assert_eq!(
            bitmask_to_flags(PERM_ADMINISTRATOR),
            vec!["ADMINISTRATOR".to_string()]
        );
    }

    #[test]
    fn parse_bitmask_str_rejects_negative_invalid_unknown_and_bit63() {
        assert!(parse_bitmask_str("-1").is_err());
        assert!(parse_bitmask_str("").is_err());
        assert!(parse_bitmask_str("abc").is_err());
        assert!(parse_bitmask_str("+10").is_err());
        // Bit 63 (2^63) overflows i64
        assert!(parse_bitmask_str("9223372036854775808").is_err());
        // Undefined bit 14
        assert!(parse_bitmask_str(&(1_i64 << 14).to_string()).is_err());
        // Undefined bit 61
        assert!(parse_bitmask_str(&(1_i64 << 61).to_string()).is_err());
        // Unknown flag name
        assert!(flags_to_bitmask(&["UNKNOWN_PERM"]).is_err());
    }

    #[test]
    fn community_resolution_respects_membership_ban_owner_and_admin() {
        let owner = Uuid::new_v4();
        let member = Uuid::new_v4();

        // Non-member or banned returns 0 even if roles passed
        assert_eq!(
            resolve_community_permissions(
                member,
                owner,
                false,
                false,
                DEFAULT_EVERYONE_PERMISSIONS,
                &[PERM_ADMINISTRATOR]
            ),
            0
        );
        assert_eq!(
            resolve_community_permissions(
                member,
                owner,
                true,
                true,
                DEFAULT_EVERYONE_PERMISSIONS,
                &[PERM_ADMINISTRATOR]
            ),
            0
        );

        // Owner gets ALL_DEFINED_PERMISSIONS regardless of @everyone
        assert_eq!(
            resolve_community_permissions(owner, owner, true, false, 0, &[]),
            ALL_DEFINED_PERMISSIONS
        );

        // Administrator role grants ALL_DEFINED_PERMISSIONS
        assert_eq!(
            resolve_community_permissions(
                member,
                owner,
                true,
                false,
                PERM_VIEW_CHANNEL,
                &[PERM_ADMINISTRATOR]
            ),
            ALL_DEFINED_PERMISSIONS
        );

        // Regular member gets union of @everyone + roles
        assert_eq!(
            resolve_community_permissions(
                member,
                owner,
                true,
                false,
                PERM_VIEW_CHANNEL,
                &[PERM_SEND_MESSAGES, PERM_MANAGE_MESSAGES]
            ),
            PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_MANAGE_MESSAGES
        );
    }

    #[test]
    fn channel_overwrites_precedence_everyone_roles_or_user() {
        let owner = Uuid::new_v4();
        let actor = Uuid::new_v4();
        let everyone_id = Uuid::new_v4();
        let role_a = Uuid::new_v4();
        let role_b = Uuid::new_v4();
        let now = Utc::now();

        let overwrites = vec![
            // @everyone denies SEND_MESSAGES
            ChannelOverwriteRule {
                target_type: "role".to_string(),
                target_id: everyone_id,
                allow_bitmask: 0,
                deny_bitmask: PERM_SEND_MESSAGES,
            },
            // role_a denies SCREEN_SHARE, role_b allows SEND_MESSAGES & SCREEN_SHARE -> OR allow wins over OR deny
            ChannelOverwriteRule {
                target_type: "role".to_string(),
                target_id: role_a,
                allow_bitmask: 0,
                deny_bitmask: PERM_SCREEN_SHARE,
            },
            ChannelOverwriteRule {
                target_type: "role".to_string(),
                target_id: role_b,
                allow_bitmask: PERM_SEND_MESSAGES | PERM_SCREEN_SHARE,
                deny_bitmask: 0,
            },
            // user overwrite denies SEND_MESSAGES again -> user overwrite wins over role allow
            ChannelOverwriteRule {
                target_type: "user".to_string(),
                target_id: actor,
                allow_bitmask: 0,
                deny_bitmask: PERM_SEND_MESSAGES,
            },
        ];

        let perms = resolve_channel_permissions(&ResolveChannelPermissionsInput {
            actor_id: actor,
            owner_id: owner,
            is_member: true,
            is_banned: false,
            everyone_role_id: Some(everyone_id),
            everyone_permissions: DEFAULT_EVERYONE_PERMISSIONS,
            member_role_ids: &[role_a, role_b],
            member_role_permissions: &[],
            is_private: false,
            is_read_only: false,
            overwrites: &overwrites,
            text_muted_until: None,
            voice_muted_until: None,
            server_voice_muted: false,
            now,
        });

        assert!(has_permission(perms, PERM_SCREEN_SHARE));
        assert!(!has_permission(perms, PERM_SEND_MESSAGES));
        assert!(has_permission(perms, PERM_VIEW_CHANNEL));
    }

    #[test]
    fn channel_read_only_and_private_and_mute_rules() {
        let owner = Uuid::new_v4();
        let actor = Uuid::new_v4();
        let everyone_id = Uuid::new_v4();
        let poster_role = Uuid::new_v4();
        let now = Utc::now();

        // 1. Read-only blocks normal member even with base SEND_MESSAGES
        let ro_perms = resolve_channel_permissions(&ResolveChannelPermissionsInput {
            actor_id: actor,
            owner_id: owner,
            is_member: true,
            is_banned: false,
            everyone_role_id: Some(everyone_id),
            everyone_permissions: DEFAULT_EVERYONE_PERMISSIONS,
            member_role_ids: &[],
            member_role_permissions: &[],
            is_private: false,
            is_read_only: true,
            overwrites: &[],
            text_muted_until: None,
            voice_muted_until: None,
            server_voice_muted: false,
            now,
        });
        assert!(!has_permission(ro_perms, PERM_SEND_MESSAGES));
        assert!(has_permission(ro_perms, PERM_VIEW_CHANNEL));

        // 2. Read-only allows member with explicit role overwrite SEND_MESSAGES
        let ro_allowed = resolve_channel_permissions(&ResolveChannelPermissionsInput {
            actor_id: actor,
            owner_id: owner,
            is_member: true,
            is_banned: false,
            everyone_role_id: Some(everyone_id),
            everyone_permissions: DEFAULT_EVERYONE_PERMISSIONS,
            member_role_ids: &[poster_role],
            member_role_permissions: &[],
            is_private: false,
            is_read_only: true,
            overwrites: &[ChannelOverwriteRule {
                target_type: "role".to_string(),
                target_id: poster_role,
                allow_bitmask: PERM_SEND_MESSAGES,
                deny_bitmask: 0,
            }],
            text_muted_until: None,
            voice_muted_until: None,
            server_voice_muted: false,
            now,
        });
        assert!(has_permission(ro_allowed, PERM_SEND_MESSAGES));

        // 3. Read-only allows MANAGE_CHANNELS without channel overwrite
        let ro_manager = resolve_channel_permissions(&ResolveChannelPermissionsInput {
            actor_id: actor,
            owner_id: owner,
            is_member: true,
            is_banned: false,
            everyone_role_id: Some(everyone_id),
            everyone_permissions: DEFAULT_EVERYONE_PERMISSIONS,
            member_role_ids: &[poster_role],
            member_role_permissions: &[PERM_MANAGE_CHANNELS],
            is_private: false,
            is_read_only: true,
            overwrites: &[],
            text_muted_until: None,
            voice_muted_until: None,
            server_voice_muted: false,
            now,
        });
        assert!(has_permission(ro_manager, PERM_SEND_MESSAGES));

        // 4. Private channel hides VIEW_CHANNEL and strips text/voice/history perms for uninvited members
        let priv_denied = resolve_channel_permissions(&ResolveChannelPermissionsInput {
            actor_id: actor,
            owner_id: owner,
            is_member: true,
            is_banned: false,
            everyone_role_id: Some(everyone_id),
            everyone_permissions: DEFAULT_EVERYONE_PERMISSIONS,
            member_role_ids: &[],
            member_role_permissions: &[],
            is_private: true,
            is_read_only: false,
            overwrites: &[],
            text_muted_until: None,
            voice_muted_until: None,
            server_voice_muted: false,
            now,
        });
        assert!(!has_permission(priv_denied, PERM_VIEW_CHANNEL));
        assert!(!has_permission(priv_denied, PERM_SEND_MESSAGES));
        assert!(!has_permission(priv_denied, PERM_CONNECT_VOICE));
        assert!(!has_permission(priv_denied, PERM_SPEAK));
        assert!(!has_permission(priv_denied, PERM_SCREEN_SHARE));
        assert!(!has_permission(priv_denied, PERM_READ_MESSAGE_HISTORY));

        // 5. Private channel grants access when user has explicit overwrite
        let priv_allowed = resolve_channel_permissions(&ResolveChannelPermissionsInput {
            actor_id: actor,
            owner_id: owner,
            is_member: true,
            is_banned: false,
            everyone_role_id: Some(everyone_id),
            everyone_permissions: DEFAULT_EVERYONE_PERMISSIONS,
            member_role_ids: &[],
            member_role_permissions: &[],
            is_private: true,
            is_read_only: false,
            overwrites: &[ChannelOverwriteRule {
                target_type: "user".to_string(),
                target_id: actor,
                allow_bitmask: PERM_VIEW_CHANNEL,
                deny_bitmask: 0,
            }],
            text_muted_until: None,
            voice_muted_until: None,
            server_voice_muted: false,
            now,
        });
        assert!(has_permission(priv_allowed, PERM_VIEW_CHANNEL));
        assert!(has_permission(priv_allowed, PERM_SEND_MESSAGES));

        // 6. Active mutes strip SEND_MESSAGES and SPEAK (expired mutes do not)
        let muted = resolve_channel_permissions(&ResolveChannelPermissionsInput {
            actor_id: actor,
            owner_id: owner,
            is_member: true,
            is_banned: false,
            everyone_role_id: Some(everyone_id),
            everyone_permissions: DEFAULT_EVERYONE_PERMISSIONS,
            member_role_ids: &[],
            member_role_permissions: &[],
            is_private: false,
            is_read_only: false,
            overwrites: &[],
            text_muted_until: Some(now + Duration::minutes(10)),
            voice_muted_until: Some(now + Duration::minutes(10)),
            server_voice_muted: true,
            now,
        });
        assert!(!has_permission(muted, PERM_SEND_MESSAGES));
        assert!(!has_permission(muted, PERM_SPEAK));
        assert!(has_permission(muted, PERM_CONNECT_VOICE));

        let expired_mute = resolve_channel_permissions(&ResolveChannelPermissionsInput {
            actor_id: actor,
            owner_id: owner,
            is_member: true,
            is_banned: false,
            everyone_role_id: Some(everyone_id),
            everyone_permissions: DEFAULT_EVERYONE_PERMISSIONS,
            member_role_ids: &[],
            member_role_permissions: &[],
            is_private: false,
            is_read_only: false,
            overwrites: &[],
            text_muted_until: Some(now - Duration::seconds(1)),
            voice_muted_until: Some(now - Duration::seconds(1)),
            server_voice_muted: true,
            now,
        });
        assert!(has_permission(expired_mute, PERM_SEND_MESSAGES));
        assert!(has_permission(expired_mute, PERM_SPEAK));

        // 7. Owner bypasses private, read-only, overwrites, and mutes
        let owner_perms = resolve_channel_permissions(&ResolveChannelPermissionsInput {
            actor_id: owner,
            owner_id: owner,
            is_member: true,
            is_banned: false,
            everyone_role_id: Some(everyone_id),
            everyone_permissions: 0,
            member_role_ids: &[],
            member_role_permissions: &[],
            is_private: true,
            is_read_only: true,
            overwrites: &[ChannelOverwriteRule {
                target_type: "user".to_string(),
                target_id: owner,
                allow_bitmask: 0,
                deny_bitmask: ALL_DEFINED_PERMISSIONS,
            }],
            text_muted_until: Some(now + Duration::hours(1)),
            voice_muted_until: Some(now + Duration::hours(1)),
            server_voice_muted: true,
            now,
        });
        assert_eq!(owner_perms, ALL_DEFINED_PERMISSIONS);
    }

    #[test]
    fn anti_escalation_manage_role_enforces_hierarchy_and_bits() {
        let owner = Uuid::new_v4();
        let actor = Uuid::new_v4();
        let actor_perms = DEFAULT_EVERYONE_PERMISSIONS | PERM_MANAGE_ROLES | PERM_MANAGE_MESSAGES;

        // Actor at pos 10 cannot manage role at pos 10 or 15
        assert!(ensure_can_manage_role(
            actor,
            owner,
            10,
            actor_perms,
            Some(10),
            None,
            None,
            false
        )
        .is_err());
        assert!(ensure_can_manage_role(
            actor,
            owner,
            10,
            actor_perms,
            Some(15),
            None,
            None,
            false
        )
        .is_err());

        // Cannot create/move role to >= actor_top_pos
        assert!(ensure_can_manage_role(
            actor,
            owner,
            10,
            actor_perms,
            None,
            Some(10),
            Some(PERM_VIEW_CHANNEL),
            false
        )
        .is_err());

        // Cannot grant permission bits the actor does not possess
        assert!(ensure_can_manage_role(
            actor,
            owner,
            10,
            actor_perms,
            Some(5),
            Some(5),
            Some(PERM_MODERATE_MEMBERS),
            false
        )
        .is_err());

        // Even an ADMINISTRATOR who is not owner cannot grant ADMINISTRATOR
        assert!(ensure_can_manage_role(
            actor,
            owner,
            20,
            ALL_DEFINED_PERMISSIONS,
            Some(5),
            Some(5),
            Some(PERM_ADMINISTRATOR),
            false
        )
        .is_err());

        // Valid manage within actor's bits and below actor's position
        assert!(ensure_can_manage_role(
            actor,
            owner,
            10,
            actor_perms,
            Some(5),
            Some(6),
            Some(PERM_VIEW_CHANNEL | PERM_MANAGE_MESSAGES),
            false
        )
        .is_ok());

        // Owner can grant ADMINISTRATOR to a custom role
        assert!(ensure_can_manage_role(
            owner,
            owner,
            i32::MAX,
            ALL_DEFINED_PERMISSIONS,
            None,
            Some(20),
            Some(PERM_ADMINISTRATOR),
            false
        )
        .is_ok());

        // Cannot delete @everyone even as owner
        assert!(ensure_can_delete_role(
            owner,
            owner,
            i32::MAX,
            ALL_DEFINED_PERMISSIONS,
            0,
            true
        )
        .is_err());
    }

    #[test]
    fn anti_escalation_assign_role_and_moderate_member() {
        let owner = Uuid::new_v4();
        let actor = Uuid::new_v4();
        let target = Uuid::new_v4();
        let actor_perms = DEFAULT_EVERYONE_PERMISSIONS | PERM_MANAGE_ROLES;

        // Cannot assign @everyone
        assert!(ensure_can_assign_role(
            owner,
            owner,
            i32::MAX,
            5,
            0,
            DEFAULT_EVERYONE_PERMISSIONS,
            ALL_DEFINED_PERMISSIONS,
            true
        )
        .is_err());

        // Cannot assign to equal/higher target member
        assert!(ensure_can_assign_role(
            actor,
            owner,
            10,
            10,
            5,
            PERM_VIEW_CHANNEL,
            actor_perms,
            false
        )
        .is_err());

        // Cannot assign a role >= actor_top_pos
        assert!(ensure_can_assign_role(
            actor,
            owner,
            10,
            5,
            10,
            PERM_VIEW_CHANNEL,
            actor_perms,
            false
        )
        .is_err());

        // Cannot assign a role with permissions actor does not have
        assert!(ensure_can_assign_role(
            actor,
            owner,
            10,
            5,
            4,
            PERM_MODERATE_MEMBERS,
            actor_perms,
            false
        )
        .is_err());

        // Non-owner cannot assign ADMINISTRATOR role
        assert!(ensure_can_assign_role(
            actor,
            owner,
            20,
            5,
            10,
            PERM_ADMINISTRATOR,
            ALL_DEFINED_PERMISSIONS,
            false
        )
        .is_err());

        // Valid assignment
        assert!(ensure_can_assign_role(
            actor,
            owner,
            10,
            5,
            4,
            PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES,
            actor_perms,
            false
        )
        .is_ok());

        // Moderate member checks
        assert!(ensure_can_moderate_member(actor, owner, 10, actor, 10).is_err());
        assert!(ensure_can_moderate_member(actor, owner, 10, owner, i32::MAX).is_err());
        assert!(ensure_can_moderate_member(actor, owner, 10, target, 10).is_err());
        assert!(ensure_can_moderate_member(actor, owner, 10, target, 12).is_err());
        assert!(ensure_can_moderate_member(actor, owner, 10, target, 5).is_ok());
        assert!(ensure_can_moderate_member(owner, owner, i32::MAX, target, 50).is_ok());
    }

    #[test]
    fn anti_escalation_channel_overwrites() {
        let owner = Uuid::new_v4();
        let actor = Uuid::new_v4();
        let actor_perms = DEFAULT_EVERYONE_PERMISSIONS | PERM_MANAGE_CHANNELS;

        // Cannot allow permission actor does not possess
        assert!(ensure_can_manage_channel_overwrite(
            actor,
            owner,
            actor_perms,
            PERM_MODERATE_MEMBERS,
            0
        )
        .is_err());

        // Cannot grant ADMINISTRATOR in overwrite
        assert!(ensure_can_manage_channel_overwrite(
            actor,
            owner,
            ALL_DEFINED_PERMISSIONS,
            PERM_ADMINISTRATOR,
            0
        )
        .is_err());

        // Valid overwrite
        assert!(ensure_can_manage_channel_overwrite(
            actor,
            owner,
            actor_perms,
            PERM_VIEW_CHANNEL,
            PERM_SEND_MESSAGES
        )
        .is_ok());
    }
}
