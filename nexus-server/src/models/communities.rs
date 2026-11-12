use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

use crate::errors::AppError;

// ==========================================
// 63-bit Permission Constants (bits 0..=62 in i64 >= 0)
// ==========================================

pub const PERM_MANAGE_COMMUNITY: i64 = 1_i64 << 0;
pub const PERM_MANAGE_CHANNELS: i64 = 1_i64 << 1;
pub const PERM_MANAGE_ROLES: i64 = 1_i64 << 2;
pub const PERM_CREATE_INVITES: i64 = 1_i64 << 3;
pub const PERM_SEND_MESSAGES: i64 = 1_i64 << 4;
pub const PERM_CONNECT_VOICE: i64 = 1_i64 << 5;
pub const PERM_SPEAK: i64 = 1_i64 << 6;
pub const PERM_SCREEN_SHARE: i64 = 1_i64 << 7;
pub const PERM_MODERATE_MEMBERS: i64 = 1_i64 << 8;
pub const PERM_VIEW_CHANNEL: i64 = 1_i64 << 9;
pub const PERM_READ_MESSAGE_HISTORY: i64 = 1_i64 << 10;
pub const PERM_MANAGE_MESSAGES: i64 = 1_i64 << 11;
pub const PERM_MUTE_MEMBERS_VOICE: i64 = 1_i64 << 12;
pub const PERM_VIEW_AUDIT_LOG: i64 = 1_i64 << 13;
pub const PERM_ADMINISTRATOR: i64 = 1_i64 << 62;

pub const ALL_DEFINED_PERMISSIONS: i64 = PERM_MANAGE_COMMUNITY
    | PERM_MANAGE_CHANNELS
    | PERM_MANAGE_ROLES
    | PERM_CREATE_INVITES
    | PERM_SEND_MESSAGES
    | PERM_CONNECT_VOICE
    | PERM_SPEAK
    | PERM_SCREEN_SHARE
    | PERM_MODERATE_MEMBERS
    | PERM_VIEW_CHANNEL
    | PERM_READ_MESSAGE_HISTORY
    | PERM_MANAGE_MESSAGES
    | PERM_MUTE_MEMBERS_VOICE
    | PERM_VIEW_AUDIT_LOG
    | PERM_ADMINISTRATOR;

pub const DEFAULT_EVERYONE_PERMISSIONS: i64 = PERM_VIEW_CHANNEL
    | PERM_READ_MESSAGE_HISTORY
    | PERM_CREATE_INVITES
    | PERM_SEND_MESSAGES
    | PERM_CONNECT_VOICE
    | PERM_SPEAK
    | PERM_SCREEN_SHARE;

pub const DEFAULT_MODERATOR_PERMISSIONS: i64 = DEFAULT_EVERYONE_PERMISSIONS
    | PERM_MODERATE_MEMBERS
    | PERM_MANAGE_MESSAGES
    | PERM_MUTE_MEMBERS_VOICE
    | PERM_VIEW_AUDIT_LOG;

pub const DEFAULT_ADMIN_PERMISSIONS: i64 = ALL_DEFINED_PERMISSIONS;

pub const PERMISSION_DEFINITIONS: &[(i64, &str)] = &[
    (PERM_MANAGE_COMMUNITY, "MANAGE_COMMUNITY"),
    (PERM_MANAGE_CHANNELS, "MANAGE_CHANNELS"),
    (PERM_MANAGE_ROLES, "MANAGE_ROLES"),
    (PERM_CREATE_INVITES, "CREATE_INVITES"),
    (PERM_SEND_MESSAGES, "SEND_MESSAGES"),
    (PERM_CONNECT_VOICE, "CONNECT_VOICE"),
    (PERM_SPEAK, "SPEAK"),
    (PERM_SCREEN_SHARE, "SCREEN_SHARE"),
    (PERM_MODERATE_MEMBERS, "MODERATE_MEMBERS"),
    (PERM_VIEW_CHANNEL, "VIEW_CHANNEL"),
    (PERM_READ_MESSAGE_HISTORY, "READ_MESSAGE_HISTORY"),
    (PERM_MANAGE_MESSAGES, "MANAGE_MESSAGES"),
    (PERM_MUTE_MEMBERS_VOICE, "MUTE_MEMBERS_VOICE"),
    (PERM_VIEW_AUDIT_LOG, "VIEW_AUDIT_LOG"),
    (PERM_ADMINISTRATOR, "ADMINISTRATOR"),
];

/// Validates that a raw `i64` permission bitmask is non-negative and contains only defined bits (`0..=13` or `62`).
pub fn validate_bitmask(bitmask: i64) -> Result<i64, AppError> {
    if bitmask < 0 {
        return Err(AppError::ValidationError(
            "O bitmask de permissões não pode ser negativo ou utilizar o bit 63.".to_string(),
        ));
    }
    if (bitmask & !ALL_DEFINED_PERMISSIONS) != 0 {
        return Err(AppError::ValidationError(
            "O bitmask de permissões contém bits desconhecidos ou não suportados.".to_string(),
        ));
    }
    Ok(bitmask)
}

/// Parses a JSON-safe decimal string into a validated 63-bit permission mask.
/// Rejects negative numbers, non-decimal strings, overflows (>= 2^63), and undefined bits.
pub fn parse_bitmask_str(s: &str) -> Result<i64, AppError> {
    let trimmed = s.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::ValidationError(
            "O bitmask de permissões deve ser uma string decimal inteira não negativa.".to_string(),
        ));
    }

    let parsed = trimmed.parse::<i64>().map_err(|_| {
        AppError::ValidationError(
            "O bitmask de permissões excede o limite de 63 bits.".to_string(),
        )
    })?;

    validate_bitmask(parsed)
}

/// Formats a permission bitmask as a BigInt-safe decimal string.
pub fn format_bitmask_str(bitmask: i64) -> String {
    bitmask.to_string()
}

/// Converts a bitmask into its canonical list of permission flag names.
pub fn bitmask_to_flags(bitmask: i64) -> Vec<String> {
    if bitmask <= 0 {
        return Vec::new();
    }
    PERMISSION_DEFINITIONS
        .iter()
        .filter(|(bit, _)| (bitmask & *bit) == *bit)
        .map(|(_, name)| (*name).to_string())
        .collect()
}

/// Validates and converts a bitmask into canonical flag names.
pub fn try_bitmask_to_flags(bitmask: i64) -> Result<Vec<String>, AppError> {
    validate_bitmask(bitmask)?;
    Ok(bitmask_to_flags(bitmask))
}

/// Converts canonical permission flag names into a validated bitmask.
pub fn flags_to_bitmask<S: AsRef<str>>(flags: &[S]) -> Result<i64, AppError> {
    let mut mask = 0_i64;
    for raw_flag in flags {
        let flag = raw_flag.as_ref().trim();
        let Some((bit, _)) = PERMISSION_DEFINITIONS.iter().find(|(_, name)| *name == flag) else {
            return Err(AppError::ValidationError(format!(
                "Flag de permissão desconhecida: '{}'.",
                flag
            )));
        };
        mask |= *bit;
    }
    Ok(mask)
}

/// Checks whether all bits in `required` are present in `bitmask`.
pub fn has_permission(bitmask: i64, required: i64) -> bool {
    required >= 0 && (bitmask & required) == required
}

pub const COMMUNITY_NAME_MIN_LEN: usize = 2;
pub const COMMUNITY_NAME_MAX_LEN: usize = 64;
pub const COMMUNITY_DESCRIPTION_MAX_LEN: usize = 500;
pub const COMMUNITY_INITIALS_MAX_LEN: usize = 4;
pub const COMMUNITY_ICON_URL_MAX_LEN: usize = 2048;
pub const CATEGORY_NAME_MAX_LEN: usize = 64;
pub const CHANNEL_NAME_MAX_LEN: usize = 64;
pub const CHANNEL_TOPIC_MAX_LEN: usize = 500;
pub const ROLE_NAME_MAX_LEN: usize = 48;
pub const MEMBER_NICKNAME_MAX_LEN: usize = 48;
pub const CHANNEL_MESSAGE_MAX_LEN: usize = 4000;
pub const CLIENT_MESSAGE_ID_MAX_LEN: usize = 64;
pub const MODERATION_REASON_MAX_LEN: usize = 500;
pub const VOICE_BITRATE_MIN_BPS: i32 = 16_000;
pub const VOICE_BITRATE_MAX_BPS: i32 = 512_000;
pub const VOICE_USER_LIMIT_MIN: i32 = 1;
pub const VOICE_USER_LIMIT_MAX: i32 = 99;
pub const INVITE_MAX_USES_LIMIT: i32 = 10_000;
pub const INVITE_MIN_EXPIRES_SECS: i64 = 60;
pub const INVITE_MAX_EXPIRES_SECS: i64 = 31_536_000;
pub const MAX_PAGE_LIMIT: i64 = 100;
pub const DEFAULT_PAGE_LIMIT: i64 = 50;

fn deserialize_some<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

// ==========================================
// Validation Helpers
// ==========================================

pub fn validate_hex_color(color: &str) -> Result<(), AppError> {
    let bytes = color.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' || !bytes[1..].iter().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::ValidationError(
            "A cor deve estar no formato hexadecimal #RRGGBB.".to_string(),
        ));
    }
    Ok(())
}

pub fn validate_community_privacy(privacy: &str) -> Result<(), AppError> {
    match privacy {
        "public" | "invite_only" | "private" => Ok(()),
        _ => Err(AppError::ValidationError(
            "Privacidade inválida. Valores permitidos: 'public', 'invite_only', 'private'."
                .to_string(),
        )),
    }
}

pub fn validate_channel_type(channel_type: &str) -> Result<(), AppError> {
    match channel_type {
        "text" | "voice" => Ok(()),
        _ => Err(AppError::ValidationError(
            "Tipo de canal inválido. Valores permitidos: 'text', 'voice'.".to_string(),
        )),
    }
}

pub fn validate_overwrite_target_type(target_type: &str) -> Result<(), AppError> {
    match target_type {
        "role" | "user" => Ok(()),
        _ => Err(AppError::ValidationError(
            "Tipo de alvo inválido para sobrescrita. Valores permitidos: 'role', 'user'."
                .to_string(),
        )),
    }
}

fn validate_trimmed_text_len(
    value: &str,
    field_label: &str,
    min_chars: usize,
    max_chars: usize,
    allow_newlines: bool,
) -> Result<(), AppError> {
    let trimmed = value.trim();
    let len = trimmed.chars().count();
    if len < min_chars || len > max_chars {
        return Err(AppError::ValidationError(format!(
            "{} deve ter entre {} e {} caracteres.",
            field_label, min_chars, max_chars
        )));
    }
    if trimmed.chars().any(|c| {
        if allow_newlines {
            c.is_control() && c != '\n' && c != '\r' && c != '\t'
        } else {
            c.is_control()
        }
    }) {
        return Err(AppError::ValidationError(format!(
            "{} contém caracteres de controle inválidos.",
            field_label
        )));
    }
    Ok(())
}

fn validate_optional_max_len(
    value: Option<&str>,
    field_label: &str,
    max_chars: usize,
) -> Result<(), AppError> {
    if let Some(raw) = value {
        let trimmed = raw.trim();
        if trimmed.chars().count() > max_chars {
            return Err(AppError::ValidationError(format!(
                "{} deve ter no máximo {} caracteres.",
                field_label, max_chars
            )));
        }
        if trimmed
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
        {
            return Err(AppError::ValidationError(format!(
                "{} contém caracteres de controle inválidos.",
                field_label
            )));
        }
    }
    Ok(())
}

fn validate_appearance_preset(preset: &str) -> Result<(), AppError> {
    let trimmed = preset.trim();
    if trimmed.is_empty()
        || trimmed.len() > 32
        || !trimmed
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    {
        return Err(AppError::ValidationError(
            "Preset de aparência inválido (use apenas minúsculas, dígitos, '-' ou '_', até 32 caracteres).".to_string(),
        ));
    }
    Ok(())
}

fn validate_icon_url(url: &str) -> Result<(), AppError> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if trimmed.chars().count() > COMMUNITY_ICON_URL_MAX_LEN {
        return Err(AppError::ValidationError(format!(
            "A URL do ícone deve ter no máximo {} caracteres.",
            COMMUNITY_ICON_URL_MAX_LEN
        )));
    }
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err(AppError::ValidationError(
            "A URL do ícone deve iniciar com http:// ou https://.".to_string(),
        ));
    }
    Ok(())
}

/// Derives 1..=4 uppercase initials from a community name.
pub fn derive_community_initials(name: &str) -> String {
    let initials: String = name
        .split_whitespace()
        .filter_map(|word| word.chars().find(|c| c.is_alphanumeric()))
        .take(4)
        .flat_map(|c| c.to_uppercase())
        .collect();

    if !initials.is_empty() {
        return initials.chars().take(COMMUNITY_INITIALS_MAX_LEN).collect();
    }

    let fallback: String = name
        .trim()
        .chars()
        .filter(|c| !c.is_control() && !c.is_whitespace())
        .take(2)
        .flat_map(|c| c.to_uppercase())
        .collect();

    if fallback.is_empty() {
        "NX".to_string()
    } else {
        fallback
    }
}

fn resolve_bitmask_or_flags(
    bitmask: Option<&str>,
    flags: Option<&[String]>,
    field_name: &str,
) -> Result<Option<i64>, AppError> {
    match (bitmask, flags) {
        (Some(mask_str), Some(flag_list)) => {
            let from_mask = parse_bitmask_str(mask_str)?;
            let from_flags = flags_to_bitmask(flag_list)?;
            if from_mask != from_flags {
                return Err(AppError::ValidationError(format!(
                    "{}: permissions_bitmask e permissions_flags divergem.",
                    field_name
                )));
            }
            Ok(Some(from_mask))
        }
        (Some(mask_str), None) => Ok(Some(parse_bitmask_str(mask_str)?)),
        (None, Some(flag_list)) => Ok(Some(flags_to_bitmask(flag_list)?)),
        (None, None) => Ok(None),
    }
}

fn validate_reorder_items<F>(items: &[Uuid], positions: F, label: &str) -> Result<(), AppError>
where
    F: Iterator<Item = i32>,
{
    if items.is_empty() {
        return Err(AppError::ValidationError(format!(
            "A lista de reordenação de {} não pode estar vazia.",
            label
        )));
    }
    let mut seen = std::collections::HashSet::with_capacity(items.len());
    for id in items {
        if !seen.insert(*id) {
            return Err(AppError::ValidationError(format!(
                "A lista de reordenação de {} contém identificadores duplicados.",
                label
            )));
        }
    }
    for pos in positions {
        if pos < 0 {
            return Err(AppError::ValidationError(format!(
                "As posições de {} não podem ser negativas.",
                label
            )));
        }
    }
    Ok(())
}

// ==========================================
// SQL Database Models (sqlx::FromRow)
// ==========================================

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Community {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub icon_url: Option<String>,
    pub initials: String,
    pub icon_bg: String,
    pub accent_color: String,
    pub appearance_preset: String,
    pub privacy: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommunityCategory {
    pub id: Uuid,
    pub community_id: Uuid,
    pub name: String,
    pub position: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommunityChannel {
    pub id: Uuid,
    pub community_id: Uuid,
    pub category_id: Option<Uuid>,
    pub name: String,
    pub channel_type: String,
    pub topic: Option<String>,
    pub position: i32,
    pub is_private: bool,
    pub is_read_only: bool,
    pub voice_bitrate_bps: Option<i32>,
    pub voice_user_limit: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommunityRole {
    pub id: Uuid,
    pub community_id: Uuid,
    pub name: String,
    pub color: Option<String>,
    pub position: i32,
    pub permissions_bitmask: i64,
    pub is_default: bool,
    pub is_hoisted: bool,
    pub is_mentionable: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommunityMember {
    pub community_id: Uuid,
    pub user_id: Uuid,
    pub nickname: Option<String>,
    pub joined_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommunityMemberRole {
    pub community_id: Uuid,
    pub user_id: Uuid,
    pub role_id: Uuid,
    pub assigned_by: Option<Uuid>,
    pub assigned_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ChannelPermissionOverwrite {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub target_type: String,
    pub target_id: Uuid,
    pub allow_bitmask: i64,
    pub deny_bitmask: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ChannelMessage {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub community_id: Uuid,
    pub sender_id: Uuid,
    pub reply_to_message_id: Option<Uuid>,
    pub content: String,
    pub client_message_id: Option<String>,
    pub attachments_json: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ChannelReadState {
    pub channel_id: Uuid,
    pub user_id: Uuid,
    pub last_read_message_id: Option<Uuid>,
    pub last_read_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommunityInvite {
    pub id: Uuid,
    pub community_id: Uuid,
    pub channel_id: Option<Uuid>,
    pub inviter_id: Uuid,
    pub code: String,
    pub max_uses: Option<i32>,
    pub uses_count: i32,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoked_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommunityBan {
    pub community_id: Uuid,
    pub user_id: Uuid,
    pub banned_by: Uuid,
    pub reason: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommunityMemberMute {
    pub community_id: Uuid,
    pub user_id: Uuid,
    pub muted_by: Option<Uuid>,
    pub reason: Option<String>,
    pub text_muted_until: Option<DateTime<Utc>>,
    pub voice_muted_until: Option<DateTime<Utc>>,
    pub server_voice_muted: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommunityAuditLog {
    pub id: Uuid,
    pub community_id: Uuid,
    pub actor_id: Uuid,
    pub action: String,
    pub target_type: String,
    pub target_id: Option<Uuid>,
    pub reason: Option<String>,
    pub metadata_json: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

// ==========================================
// REST Response DTOs
// ==========================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityDto {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub icon_url: Option<String>,
    pub initials: String,
    pub icon_bg: String,
    pub accent_color: String,
    pub appearance_preset: String,
    pub privacy: String,
    pub effective_permissions: String,
    pub effective_permissions_flags: Vec<String>,
    pub unread_count: i64,
    pub member_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl CommunityDto {
    pub fn from_model(
        model: Community,
        effective_permissions_mask: i64,
        unread_count: i64,
        member_count: i64,
    ) -> Self {
        Self {
            id: model.id,
            owner_id: model.owner_id,
            name: model.name,
            description: model.description,
            icon_url: model.icon_url,
            initials: model.initials,
            icon_bg: model.icon_bg,
            accent_color: model.accent_color,
            appearance_preset: model.appearance_preset,
            privacy: model.privacy,
            effective_permissions: format_bitmask_str(effective_permissions_mask),
            effective_permissions_flags: bitmask_to_flags(effective_permissions_mask),
            unread_count,
            member_count,
            created_at: model.created_at,
            updated_at: model.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityCategoryDto {
    pub id: Uuid,
    pub community_id: Uuid,
    pub name: String,
    pub position: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<CommunityCategory> for CommunityCategoryDto {
    fn from(model: CommunityCategory) -> Self {
        Self {
            id: model.id,
            community_id: model.community_id,
            name: model.name,
            position: model.position,
            created_at: model.created_at,
            updated_at: model.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPermissionOverwriteDto {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub target_type: String,
    pub target_id: Uuid,
    pub allow_bitmask: String,
    pub allow_flags: Vec<String>,
    pub deny_bitmask: String,
    pub deny_flags: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<ChannelPermissionOverwrite> for ChannelPermissionOverwriteDto {
    fn from(model: ChannelPermissionOverwrite) -> Self {
        Self {
            id: model.id,
            channel_id: model.channel_id,
            target_type: model.target_type,
            target_id: model.target_id,
            allow_bitmask: format_bitmask_str(model.allow_bitmask),
            allow_flags: bitmask_to_flags(model.allow_bitmask),
            deny_bitmask: format_bitmask_str(model.deny_bitmask),
            deny_flags: bitmask_to_flags(model.deny_bitmask),
            created_at: model.created_at,
            updated_at: model.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityChannelDto {
    pub id: Uuid,
    pub community_id: Uuid,
    pub category_id: Option<Uuid>,
    pub name: String,
    pub channel_type: String,
    pub topic: Option<String>,
    pub position: i32,
    pub is_private: bool,
    pub is_read_only: bool,
    pub voice_bitrate_bps: Option<i32>,
    pub voice_user_limit: Option<i32>,
    pub effective_permissions: String,
    pub effective_permissions_flags: Vec<String>,
    pub unread_count: i64,
    #[serde(default)]
    pub overwrites: Vec<ChannelPermissionOverwriteDto>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl CommunityChannelDto {
    pub fn from_model(
        model: CommunityChannel,
        effective_permissions_mask: i64,
        unread_count: i64,
        overwrites: Vec<ChannelPermissionOverwriteDto>,
    ) -> Self {
        Self {
            id: model.id,
            community_id: model.community_id,
            category_id: model.category_id,
            name: model.name,
            channel_type: model.channel_type,
            topic: model.topic,
            position: model.position,
            is_private: model.is_private,
            is_read_only: model.is_read_only,
            voice_bitrate_bps: model.voice_bitrate_bps,
            voice_user_limit: model.voice_user_limit,
            effective_permissions: format_bitmask_str(effective_permissions_mask),
            effective_permissions_flags: bitmask_to_flags(effective_permissions_mask),
            unread_count,
            overwrites,
            created_at: model.created_at,
            updated_at: model.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityRoleDto {
    pub id: Uuid,
    pub community_id: Uuid,
    pub name: String,
    pub color: Option<String>,
    pub position: i32,
    pub permissions_bitmask: String,
    pub permissions_flags: Vec<String>,
    pub is_default: bool,
    pub is_hoisted: bool,
    pub is_mentionable: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<CommunityRole> for CommunityRoleDto {
    fn from(model: CommunityRole) -> Self {
        Self {
            id: model.id,
            community_id: model.community_id,
            name: model.name,
            color: model.color,
            position: model.position,
            permissions_bitmask: format_bitmask_str(model.permissions_bitmask),
            permissions_flags: bitmask_to_flags(model.permissions_bitmask),
            is_default: model.is_default,
            is_hoisted: model.is_hoisted,
            is_mentionable: model.is_mentionable,
            created_at: model.created_at,
            updated_at: model.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityMemberRoleDto {
    pub id: Uuid,
    pub name: String,
    pub color: Option<String>,
    pub position: i32,
    pub is_hoisted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityMemberDto {
    pub community_id: Uuid,
    pub user_id: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub status: String,
    pub custom_status: Option<String>,
    pub nickname: Option<String>,
    pub is_owner: bool,
    pub roles: Vec<CommunityMemberRoleDto>,
    pub highest_role_position: i32,
    pub joined_at: DateTime<Utc>,
    pub text_muted_until: Option<DateTime<Utc>>,
    pub voice_muted_until: Option<DateTime<Utc>>,
    pub server_voice_muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityMemberMuteDto {
    pub community_id: Uuid,
    pub user_id: Uuid,
    pub muted_by: Option<Uuid>,
    pub reason: Option<String>,
    pub text_muted_until: Option<DateTime<Utc>>,
    pub voice_muted_until: Option<DateTime<Utc>>,
    pub server_voice_muted: bool,
    pub updated_at: DateTime<Utc>,
}

impl From<CommunityMemberMute> for CommunityMemberMuteDto {
    fn from(model: CommunityMemberMute) -> Self {
        Self {
            community_id: model.community_id,
            user_id: model.user_id,
            muted_by: model.muted_by,
            reason: model.reason,
            text_muted_until: model.text_muted_until,
            voice_muted_until: model.voice_muted_until,
            server_voice_muted: model.server_voice_muted,
            updated_at: model.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunitySnapshotDto {
    pub community: CommunityDto,
    pub categories: Vec<CommunityCategoryDto>,
    pub channels: Vec<CommunityChannelDto>,
    pub roles: Vec<CommunityRoleDto>,
    pub members: Vec<CommunityMemberDto>,
    pub my_mute: Option<CommunityMemberMuteDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMessageAuthorDto {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub nickname: Option<String>,
    pub role_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMessageDto {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub community_id: Uuid,
    pub sender_id: Uuid,
    pub author: Option<ChannelMessageAuthorDto>,
    pub reply_to_message_id: Option<Uuid>,
    pub content: String,
    pub client_message_id: Option<String>,
    pub attachments: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub is_mine: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMessagesPageDto {
    pub messages: Vec<ChannelMessageDto>,
    pub has_more: bool,
    pub next_before: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelReadStateDto {
    pub channel_id: Uuid,
    pub user_id: Uuid,
    pub last_read_message_id: Option<Uuid>,
    pub last_read_at: DateTime<Utc>,
}

impl From<ChannelReadState> for ChannelReadStateDto {
    fn from(model: ChannelReadState) -> Self {
        Self {
            channel_id: model.channel_id,
            user_id: model.user_id,
            last_read_message_id: model.last_read_message_id,
            last_read_at: model.last_read_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityInviteDto {
    pub id: Uuid,
    pub community_id: Uuid,
    pub channel_id: Option<Uuid>,
    pub inviter_id: Uuid,
    pub code: String,
    pub max_uses: Option<i32>,
    pub uses_count: i32,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoked_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

impl From<CommunityInvite> for CommunityInviteDto {
    fn from(model: CommunityInvite) -> Self {
        Self {
            id: model.id,
            community_id: model.community_id,
            channel_id: model.channel_id,
            inviter_id: model.inviter_id,
            code: model.code,
            max_uses: model.max_uses,
            uses_count: model.uses_count,
            expires_at: model.expires_at,
            revoked_at: model.revoked_at,
            revoked_by: model.revoked_by,
            created_at: model.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvitePreviewDto {
    pub code: String,
    pub community_id: Uuid,
    pub community_name: String,
    pub community_description: Option<String>,
    pub community_icon_url: Option<String>,
    pub community_initials: String,
    pub community_icon_bg: String,
    pub community_accent_color: String,
    pub community_privacy: String,
    pub channel_id: Option<Uuid>,
    pub member_count: i64,
    pub expires_at: Option<DateTime<Utc>>,
    pub is_valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceptInviteResponse {
    pub community: CommunityDto,
    pub channel_id: Option<Uuid>,
    pub already_member: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityBanDto {
    pub community_id: Uuid,
    pub user_id: Uuid,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub banned_by: Uuid,
    pub reason: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityAuditLogDto {
    pub id: Uuid,
    pub community_id: Uuid,
    pub actor_id: Uuid,
    pub actor_username: Option<String>,
    pub action: String,
    pub target_type: String,
    pub target_id: Option<Uuid>,
    pub reason: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

// ==========================================
// REST Request & Query DTOs + Validations
// ==========================================

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateCommunityRequest {
    pub name: String,
    pub description: Option<String>,
    pub icon_url: Option<String>,
    pub initials: Option<String>,
    pub icon_bg: Option<String>,
    pub accent_color: Option<String>,
    pub appearance_preset: Option<String>,
    pub privacy: Option<String>,
}

impl CreateCommunityRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        validate_trimmed_text_len(
            &self.name,
            "O nome da comunidade",
            COMMUNITY_NAME_MIN_LEN,
            COMMUNITY_NAME_MAX_LEN,
            false,
        )?;
        validate_optional_max_len(
            self.description.as_deref(),
            "A descrição da comunidade",
            COMMUNITY_DESCRIPTION_MAX_LEN,
        )?;
        if let Some(url) = self.icon_url.as_deref() {
            validate_icon_url(url)?;
        }
        if let Some(initials) = self.initials.as_deref() {
            validate_trimmed_text_len(
                initials,
                "As iniciais da comunidade",
                1,
                COMMUNITY_INITIALS_MAX_LEN,
                false,
            )?;
        }
        if let Some(bg) = self.icon_bg.as_deref() {
            validate_hex_color(bg.trim())?;
        }
        if let Some(accent) = self.accent_color.as_deref() {
            validate_hex_color(accent.trim())?;
        }
        if let Some(preset) = self.appearance_preset.as_deref() {
            validate_appearance_preset(preset)?;
        }
        if let Some(privacy) = self.privacy.as_deref() {
            validate_community_privacy(privacy.trim())?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateCommunityRequest {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub description: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub icon_url: Option<Option<String>>,
    pub initials: Option<String>,
    pub icon_bg: Option<String>,
    pub accent_color: Option<String>,
    pub appearance_preset: Option<String>,
    pub privacy: Option<String>,
}

impl UpdateCommunityRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        if let Some(name) = self.name.as_deref() {
            validate_trimmed_text_len(
                name,
                "O nome da comunidade",
                COMMUNITY_NAME_MIN_LEN,
                COMMUNITY_NAME_MAX_LEN,
                false,
            )?;
        }
        if let Some(Some(desc)) = self.description.as_ref() {
            validate_optional_max_len(
                Some(desc.as_str()),
                "A descrição da comunidade",
                COMMUNITY_DESCRIPTION_MAX_LEN,
            )?;
        }
        if let Some(Some(url)) = self.icon_url.as_ref() {
            validate_icon_url(url)?;
        }
        if let Some(initials) = self.initials.as_deref() {
            validate_trimmed_text_len(
                initials,
                "As iniciais da comunidade",
                1,
                COMMUNITY_INITIALS_MAX_LEN,
                false,
            )?;
        }
        if let Some(bg) = self.icon_bg.as_deref() {
            validate_hex_color(bg.trim())?;
        }
        if let Some(accent) = self.accent_color.as_deref() {
            validate_hex_color(accent.trim())?;
        }
        if let Some(preset) = self.appearance_preset.as_deref() {
            validate_appearance_preset(preset)?;
        }
        if let Some(privacy) = self.privacy.as_deref() {
            validate_community_privacy(privacy.trim())?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteCommunityRequest {
    pub confirm_name: String,
}

impl DeleteCommunityRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.confirm_name.trim().is_empty() {
            return Err(AppError::ValidationError(
                "A confirmação do nome da comunidade é obrigatória.".to_string(),
            ));
        }
        Ok(())
    }

    pub fn validate_against(&self, community_name: &str) -> Result<(), AppError> {
        self.validate()?;
        if self.confirm_name.trim() != community_name.trim() {
            return Err(AppError::BadRequest(
                "O nome de confirmação não corresponde exatamente ao nome da comunidade."
                    .to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferOwnershipRequest {
    pub target_user_id: Uuid,
    #[serde(alias = "confirm_community_name")]
    pub confirm_name: String,
}

impl TransferOwnershipRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.confirm_name.trim().is_empty() {
            return Err(AppError::ValidationError(
                "A confirmação do nome da comunidade é obrigatória para transferir propriedade."
                    .to_string(),
            ));
        }
        Ok(())
    }

    pub fn validate_against(
        &self,
        current_owner_id: Uuid,
        community_name: &str,
    ) -> Result<(), AppError> {
        self.validate()?;
        if self.target_user_id == current_owner_id {
            return Err(AppError::BadRequest(
                "O usuário de destino já é o proprietário da comunidade.".to_string(),
            ));
        }
        if self.confirm_name.trim() != community_name.trim() {
            return Err(AppError::BadRequest(
                "O nome de confirmação não corresponde exatamente ao nome da comunidade."
                    .to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateCategoryRequest {
    pub name: String,
    pub position: Option<i32>,
}

impl CreateCategoryRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        validate_trimmed_text_len(
            &self.name,
            "O nome da categoria",
            1,
            CATEGORY_NAME_MAX_LEN,
            false,
        )?;
        if let Some(pos) = self.position {
            if pos < 0 {
                return Err(AppError::ValidationError(
                    "A posição da categoria não pode ser negativa.".to_string(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateCategoryRequest {
    pub name: Option<String>,
    pub position: Option<i32>,
}

impl UpdateCategoryRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        if let Some(name) = self.name.as_deref() {
            validate_trimmed_text_len(
                name,
                "O nome da categoria",
                1,
                CATEGORY_NAME_MAX_LEN,
                false,
            )?;
        }
        if let Some(pos) = self.position {
            if pos < 0 {
                return Err(AppError::ValidationError(
                    "A posição da categoria não pode ser negativa.".to_string(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderCategoryItem {
    pub id: Uuid,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderCategoriesRequest {
    pub items: Vec<ReorderCategoryItem>,
}

impl ReorderCategoriesRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        let ids: Vec<Uuid> = self.items.iter().map(|i| i.id).collect();
        validate_reorder_items(
            &ids,
            self.items.iter().map(|i| i.position),
            "categorias",
        )
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateChannelRequest {
    pub category_id: Option<Uuid>,
    pub name: String,
    pub channel_type: String,
    pub topic: Option<String>,
    pub position: Option<i32>,
    pub is_private: Option<bool>,
    pub is_read_only: Option<bool>,
    pub voice_bitrate_bps: Option<i32>,
    pub voice_user_limit: Option<i32>,
}

impl CreateChannelRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        validate_trimmed_text_len(&self.name, "O nome do canal", 1, CHANNEL_NAME_MAX_LEN, false)?;
        let channel_type = self.channel_type.trim();
        validate_channel_type(channel_type)?;
        validate_optional_max_len(
            self.topic.as_deref(),
            "O tópico do canal",
            CHANNEL_TOPIC_MAX_LEN,
        )?;
        if let Some(pos) = self.position {
            if pos < 0 {
                return Err(AppError::ValidationError(
                    "A posição do canal não pode ser negativa.".to_string(),
                ));
            }
        }
        if let Some(bitrate) = self.voice_bitrate_bps {
            if channel_type != "voice" {
                return Err(AppError::ValidationError(
                    "Bitrate de voz só pode ser configurado em canais de voz.".to_string(),
                ));
            }
            if !(VOICE_BITRATE_MIN_BPS..=VOICE_BITRATE_MAX_BPS).contains(&bitrate) {
                return Err(AppError::ValidationError(format!(
                    "O bitrate de voz deve estar entre {} e {} bps.",
                    VOICE_BITRATE_MIN_BPS, VOICE_BITRATE_MAX_BPS
                )));
            }
        }
        if let Some(limit) = self.voice_user_limit {
            if channel_type != "voice" {
                return Err(AppError::ValidationError(
                    "Limite de usuários só pode ser configurado em canais de voz.".to_string(),
                ));
            }
            if !(VOICE_USER_LIMIT_MIN..=VOICE_USER_LIMIT_MAX).contains(&limit) {
                return Err(AppError::ValidationError(format!(
                    "O limite de usuários do canal de voz deve estar entre {} e {}.",
                    VOICE_USER_LIMIT_MIN, VOICE_USER_LIMIT_MAX
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateChannelRequest {
    #[serde(default, deserialize_with = "deserialize_some")]
    pub category_id: Option<Option<Uuid>>,
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub topic: Option<Option<String>>,
    pub position: Option<i32>,
    pub is_private: Option<bool>,
    pub is_read_only: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub voice_bitrate_bps: Option<Option<i32>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub voice_user_limit: Option<Option<i32>>,
}

impl UpdateChannelRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        if let Some(name) = self.name.as_deref() {
            validate_trimmed_text_len(name, "O nome do canal", 1, CHANNEL_NAME_MAX_LEN, false)?;
        }
        if let Some(Some(topic)) = self.topic.as_ref() {
            validate_optional_max_len(
                Some(topic.as_str()),
                "O tópico do canal",
                CHANNEL_TOPIC_MAX_LEN,
            )?;
        }
        if let Some(pos) = self.position {
            if pos < 0 {
                return Err(AppError::ValidationError(
                    "A posição do canal não pode ser negativa.".to_string(),
                ));
            }
        }
        if let Some(Some(bitrate)) = self.voice_bitrate_bps {
            if !(VOICE_BITRATE_MIN_BPS..=VOICE_BITRATE_MAX_BPS).contains(&bitrate) {
                return Err(AppError::ValidationError(format!(
                    "O bitrate de voz deve estar entre {} e {} bps.",
                    VOICE_BITRATE_MIN_BPS, VOICE_BITRATE_MAX_BPS
                )));
            }
        }
        if let Some(Some(limit)) = self.voice_user_limit {
            if !(VOICE_USER_LIMIT_MIN..=VOICE_USER_LIMIT_MAX).contains(&limit) {
                return Err(AppError::ValidationError(format!(
                    "O limite de usuários do canal de voz deve estar entre {} e {}.",
                    VOICE_USER_LIMIT_MIN, VOICE_USER_LIMIT_MAX
                )));
            }
        }
        Ok(())
    }

    pub fn validate_for_channel_type(&self, channel_type: &str) -> Result<(), AppError> {
        self.validate()?;
        if channel_type != "voice"
            && (matches!(self.voice_bitrate_bps, Some(Some(_)))
                || matches!(self.voice_user_limit, Some(Some(_))))
        {
            return Err(AppError::ValidationError(
                "Parâmetros de voz só podem ser configurados em canais de voz.".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderChannelItem {
    pub id: Uuid,
    pub category_id: Option<Uuid>,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderChannelsRequest {
    pub items: Vec<ReorderChannelItem>,
}

impl ReorderChannelsRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        let ids: Vec<Uuid> = self.items.iter().map(|i| i.id).collect();
        validate_reorder_items(&ids, self.items.iter().map(|i| i.position), "canais")
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateRoleRequest {
    pub name: String,
    pub color: Option<String>,
    pub position: Option<i32>,
    pub permissions_bitmask: Option<String>,
    pub permissions_flags: Option<Vec<String>>,
    pub is_hoisted: Option<bool>,
    pub is_mentionable: Option<bool>,
}

impl CreateRoleRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        validate_trimmed_text_len(&self.name, "O nome do cargo", 1, ROLE_NAME_MAX_LEN, false)?;
        if let Some(color) = self.color.as_deref() {
            validate_hex_color(color.trim())?;
        }
        if let Some(pos) = self.position {
            if pos < 1 || pos == i32::MAX {
                return Err(AppError::ValidationError(
                    "A posição de um cargo personalizado deve estar entre 1 e 2147483646."
                        .to_string(),
                ));
            }
        }
        self.resolve_permissions()?;
        Ok(())
    }

    pub fn resolve_permissions(&self) -> Result<i64, AppError> {
        Ok(resolve_bitmask_or_flags(
            self.permissions_bitmask.as_deref(),
            self.permissions_flags.as_deref(),
            "CreateRoleRequest",
        )?
        .unwrap_or(0))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateRoleRequest {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub color: Option<Option<String>>,
    pub position: Option<i32>,
    pub permissions_bitmask: Option<String>,
    pub permissions_flags: Option<Vec<String>>,
    pub is_hoisted: Option<bool>,
    pub is_mentionable: Option<bool>,
}

impl UpdateRoleRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        if let Some(name) = self.name.as_deref() {
            validate_trimmed_text_len(name, "O nome do cargo", 1, ROLE_NAME_MAX_LEN, false)?;
        }
        if let Some(Some(color)) = self.color.as_ref() {
            validate_hex_color(color.trim())?;
        }
        if let Some(pos) = self.position {
            if pos < 0 || pos == i32::MAX {
                return Err(AppError::ValidationError(
                    "A posição do cargo deve estar entre 0 e 2147483646.".to_string(),
                ));
            }
        }
        self.resolve_permissions()?;
        Ok(())
    }

    pub fn resolve_permissions(&self) -> Result<Option<i64>, AppError> {
        resolve_bitmask_or_flags(
            self.permissions_bitmask.as_deref(),
            self.permissions_flags.as_deref(),
            "UpdateRoleRequest",
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderRoleItem {
    pub id: Uuid,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderRolesRequest {
    pub items: Vec<ReorderRoleItem>,
}

impl ReorderRolesRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        let ids: Vec<Uuid> = self.items.iter().map(|i| i.id).collect();
        validate_reorder_items(&ids, self.items.iter().map(|i| i.position), "cargos")?;
        for item in &self.items {
            if item.position < 1 || item.position == i32::MAX {
                return Err(AppError::ValidationError(
                    "Cargos personalizados reordenados devem possuir posição entre 1 e 2147483646.".to_string(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateMemberRequest {
    #[serde(default, deserialize_with = "deserialize_some")]
    pub nickname: Option<Option<String>>,
    pub role_ids: Option<Vec<Uuid>>,
}

impl UpdateMemberRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        if let Some(Some(nick)) = self.nickname.as_ref() {
            validate_trimmed_text_len(nick, "O apelido do membro", 1, MEMBER_NICKNAME_MAX_LEN, false)?;
        }
        if let Some(role_ids) = self.role_ids.as_ref() {
            let mut seen = std::collections::HashSet::with_capacity(role_ids.len());
            for id in role_ids {
                if !seen.insert(*id) {
                    return Err(AppError::ValidationError(
                        "A lista de cargos do membro contém IDs duplicados.".to_string(),
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertChannelOverwriteRequest {
    pub target_type: String,
    pub target_id: Uuid,
    pub allow_bitmask: Option<String>,
    pub allow_flags: Option<Vec<String>>,
    pub deny_bitmask: Option<String>,
    pub deny_flags: Option<Vec<String>>,
}

impl UpsertChannelOverwriteRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        validate_overwrite_target_type(self.target_type.trim())?;
        self.resolve_masks()?;
        Ok(())
    }

    pub fn resolve_masks(&self) -> Result<(i64, i64), AppError> {
        let allow = resolve_bitmask_or_flags(
            self.allow_bitmask.as_deref(),
            self.allow_flags.as_deref(),
            "UpsertChannelOverwriteRequest.allow",
        )?
        .unwrap_or(0);
        let deny = resolve_bitmask_or_flags(
            self.deny_bitmask.as_deref(),
            self.deny_flags.as_deref(),
            "UpsertChannelOverwriteRequest.deny",
        )?
        .unwrap_or(0);

        if (allow & deny) != 0 {
            return Err(AppError::ValidationError(
                "A mesma permissão não pode estar simultaneamente em allow e deny.".to_string(),
            ));
        }

        Ok((allow, deny))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SendChannelMessageRequest {
    pub content: String,
    pub client_message_id: Option<String>,
    pub reply_to_message_id: Option<Uuid>,
    pub attachments: Option<serde_json::Value>,
}

impl SendChannelMessageRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        validate_trimmed_text_len(
            &self.content,
            "A mensagem",
            1,
            CHANNEL_MESSAGE_MAX_LEN,
            true,
        )?;
        if let Some(client_id) = self.client_message_id.as_deref() {
            validate_trimmed_text_len(
                client_id,
                "client_message_id",
                1,
                CLIENT_MESSAGE_ID_MAX_LEN,
                false,
            )?;
            if client_id.trim().chars().any(|c| c.is_whitespace()) {
                return Err(AppError::ValidationError(
                    "client_message_id não pode conter espaços.".to_string(),
                ));
            }
        }
        if let Some(attachments) = self.attachments.as_ref() {
            if !attachments.is_array() {
                return Err(AppError::ValidationError(
                    "attachments deve ser um array JSON.".to_string(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditChannelMessageRequest {
    pub content: String,
}

impl EditChannelMessageRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        validate_trimmed_text_len(
            &self.content,
            "A mensagem editada",
            1,
            CHANNEL_MESSAGE_MAX_LEN,
            true,
        )
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChannelMessagesQuery {
    pub before: Option<Uuid>,
    pub limit: Option<i64>,
}

impl ChannelMessagesQuery {
    pub fn validate(&self) -> Result<(), AppError> {
        if let Some(limit) = self.limit {
            if !(1..=MAX_PAGE_LIMIT).contains(&limit) {
                return Err(AppError::ValidationError(format!(
                    "O parâmetro limit deve estar entre 1 e {}.",
                    MAX_PAGE_LIMIT
                )));
            }
        }
        Ok(())
    }

    pub fn effective_limit(&self) -> i64 {
        self.limit
            .unwrap_or(DEFAULT_PAGE_LIMIT)
            .clamp(1, MAX_PAGE_LIMIT)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MarkChannelReadRequest {
    pub last_read_message_id: Option<Uuid>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateInviteRequest {
    pub channel_id: Option<Uuid>,
    pub max_uses: Option<i32>,
    pub expires_in_secs: Option<i64>,
}

impl CreateInviteRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        if let Some(max_uses) = self.max_uses {
            if !(1..=INVITE_MAX_USES_LIMIT).contains(&max_uses) {
                return Err(AppError::ValidationError(format!(
                    "max_uses deve estar entre 1 e {}.",
                    INVITE_MAX_USES_LIMIT
                )));
            }
        }
        if let Some(secs) = self.expires_in_secs {
            if !(INVITE_MIN_EXPIRES_SECS..=INVITE_MAX_EXPIRES_SECS).contains(&secs) {
                return Err(AppError::ValidationError(format!(
                    "expires_in_secs deve estar entre {} e {} segundos.",
                    INVITE_MIN_EXPIRES_SECS, INVITE_MAX_EXPIRES_SECS
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KickMemberRequest {
    pub reason: Option<String>,
}

impl KickMemberRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        validate_optional_max_len(
            self.reason.as_deref(),
            "O motivo da expulsão",
            MODERATION_REASON_MAX_LEN,
        )
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BanMemberRequest {
    pub reason: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub delete_message_hours: Option<i32>,
}

impl BanMemberRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        validate_optional_max_len(
            self.reason.as_deref(),
            "O motivo do banimento",
            MODERATION_REASON_MAX_LEN,
        )?;
        if let Some(hours) = self.delete_message_hours {
            if !(0..=168).contains(&hours) {
                return Err(AppError::ValidationError(
                    "delete_message_hours deve estar entre 0 e 168 horas.".to_string(),
                ));
            }
        }
        Ok(())
    }

    pub fn validate_with_now(&self, now: DateTime<Utc>) -> Result<(), AppError> {
        self.validate()?;
        if let Some(expires_at) = self.expires_at {
            if expires_at <= now {
                return Err(AppError::ValidationError(
                    "A data de expiração do banimento deve estar no futuro.".to_string(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MuteMemberRequest {
    pub reason: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub text_muted_until: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub voice_muted_until: Option<Option<DateTime<Utc>>>,
    pub server_voice_muted: Option<bool>,
}

impl MuteMemberRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        validate_optional_max_len(
            self.reason.as_deref(),
            "O motivo do silenciamento",
            MODERATION_REASON_MAX_LEN,
        )
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuditLogsQuery {
    pub action: Option<String>,
    pub actor_id: Option<Uuid>,
    pub before: Option<Uuid>,
    pub limit: Option<i64>,
}

impl AuditLogsQuery {
    pub fn validate(&self) -> Result<(), AppError> {
        if let Some(action) = self.action.as_deref() {
            validate_trimmed_text_len(action, "action", 1, 64, false)?;
        }
        if let Some(limit) = self.limit {
            if !(1..=MAX_PAGE_LIMIT).contains(&limit) {
                return Err(AppError::ValidationError(format!(
                    "O parâmetro limit deve estar entre 1 e {}.",
                    MAX_PAGE_LIMIT
                )));
            }
        }
        Ok(())
    }

    pub fn effective_limit(&self) -> i64 {
        self.limit
            .unwrap_or(DEFAULT_PAGE_LIMIT)
            .clamp(1, MAX_PAGE_LIMIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_color_validation_accepts_rrggbb_only() {
        assert!(validate_hex_color("#1f2937").is_ok());
        assert!(validate_hex_color("#AABBCC").is_ok());
        assert!(validate_hex_color("#fff").is_err());
        assert!(validate_hex_color("1f2937").is_err());
        assert!(validate_hex_color("#1f293g").is_err());
        assert!(validate_hex_color("#1f293700").is_err());
    }

    #[test]
    fn create_community_validation_enforces_limits_and_formats() {
        let valid = CreateCommunityRequest {
            name: "  Tropa Nexus  ".to_string(),
            description: Some("Comunidade oficial".to_string()),
            icon_url: Some("https://cdn.example.com/icon.png".to_string()),
            initials: Some("TN".to_string()),
            icon_bg: Some("#1f2937".to_string()),
            accent_color: Some("#38bdf8".to_string()),
            appearance_preset: Some("steam-dark".to_string()),
            privacy: Some("invite_only".to_string()),
        };
        assert!(valid.validate().is_ok());

        // Name too short
        let short_name = CreateCommunityRequest {
            name: " A ".to_string(),
            ..Default::default()
        };
        assert!(short_name.validate().is_err());

        // Invalid privacy
        let bad_privacy = CreateCommunityRequest {
            name: "Nexus".to_string(),
            privacy: Some("secret".to_string()),
            ..Default::default()
        };
        assert!(bad_privacy.validate().is_err());

        // Invalid URL scheme
        let bad_url = CreateCommunityRequest {
            name: "Nexus".to_string(),
            icon_url: Some("javascript:alert(1)".to_string()),
            ..Default::default()
        };
        assert!(bad_url.validate().is_err());

        assert_eq!(derive_community_initials("Tropa Nexus Gaming"), "TNG");
        assert_eq!(derive_community_initials("   "), "NX");
    }

    #[test]
    fn delete_and_transfer_ownership_validate_confirm_name() {
        let owner = Uuid::new_v4();
        let target = Uuid::new_v4();

        let del_ok = DeleteCommunityRequest {
            confirm_name: "Minha Comunidade".to_string(),
        };
        assert!(del_ok.validate_against("Minha Comunidade").is_ok());

        let del_bad = DeleteCommunityRequest {
            confirm_name: "minha comunidade".to_string(),
        };
        assert!(del_bad.validate_against("Minha Comunidade").is_err());

        let transfer: TransferOwnershipRequest = serde_json::from_str(&format!(
            r#"{{"target_user_id":"{}","confirm_name":"Nexus"}}"#,
            target
        ))
        .unwrap();
        assert!(transfer.validate_against(owner, "Nexus").is_ok());
        assert!(transfer.validate_against(target, "Nexus").is_err());

        // Also supports alias confirm_community_name
        let transfer_alias: TransferOwnershipRequest = serde_json::from_str(&format!(
            r#"{{"target_user_id":"{}","confirm_community_name":"Nexus"}}"#,
            target
        ))
        .unwrap();
        assert!(transfer_alias.validate_against(owner, "Nexus").is_ok());
    }

    #[test]
    fn channel_validation_enforces_type_and_voice_bounds() {
        let text = CreateChannelRequest {
            name: "geral".to_string(),
            channel_type: "text".to_string(),
            ..Default::default()
        };
        assert!(text.validate().is_ok());

        // Voice settings on text channel rejected
        let text_with_bitrate = CreateChannelRequest {
            name: "geral".to_string(),
            channel_type: "text".to_string(),
            voice_bitrate_bps: Some(64_000),
            ..Default::default()
        };
        assert!(text_with_bitrate.validate().is_err());

        let voice = CreateChannelRequest {
            name: "Sala Principal".to_string(),
            channel_type: "voice".to_string(),
            voice_bitrate_bps: Some(96_000),
            voice_user_limit: Some(10),
            ..Default::default()
        };
        assert!(voice.validate().is_ok());

        let voice_bad_limit = CreateChannelRequest {
            name: "Sala".to_string(),
            channel_type: "voice".to_string(),
            voice_user_limit: Some(100),
            ..Default::default()
        };
        assert!(voice_bad_limit.validate().is_err());

        let invalid_type = CreateChannelRequest {
            name: "Stage".to_string(),
            channel_type: "forum".to_string(),
            ..Default::default()
        };
        assert!(invalid_type.validate().is_err());
    }

    #[test]
    fn role_dto_serializes_bigint_safe_decimal_string_and_flags() {
        let role = CommunityRole {
            id: Uuid::new_v4(),
            community_id: Uuid::new_v4(),
            name: "Admin".to_string(),
            color: Some("#38bdf8".to_string()),
            position: 20,
            permissions_bitmask: PERM_ADMINISTRATOR | PERM_VIEW_CHANNEL,
            is_default: false,
            is_hoisted: true,
            is_mentionable: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let dto = CommunityRoleDto::from(role);
        let json = serde_json::to_value(&dto).unwrap();
        assert!(json["permissions_bitmask"].is_string());
        assert_eq!(
            json["permissions_bitmask"].as_str().unwrap(),
            (PERM_ADMINISTRATOR | PERM_VIEW_CHANNEL).to_string()
        );
        let flags = json["permissions_flags"].as_array().unwrap();
        assert!(flags.iter().any(|v| v == "ADMINISTRATOR"));
        assert!(flags.iter().any(|v| v == "VIEW_CHANNEL"));
    }

    #[test]
    fn create_role_and_overwrite_validate_bitmask_and_conflicts() {
        let req = CreateRoleRequest {
            name: "Moderador".to_string(),
            color: Some("#22c55e".to_string()),
            position: Some(10),
            permissions_bitmask: Some(DEFAULT_EVERYONE_PERMISSIONS.to_string()),
            permissions_flags: None,
            is_hoisted: Some(true),
            is_mentionable: Some(false),
        };
        assert!(req.validate().is_ok());
        assert_eq!(
            req.resolve_permissions().unwrap(),
            DEFAULT_EVERYONE_PERMISSIONS
        );

        let mismatched = CreateRoleRequest {
            name: "Bad".to_string(),
            permissions_bitmask: Some("0".to_string()),
            permissions_flags: Some(vec!["VIEW_CHANNEL".to_string()]),
            ..Default::default()
        };
        assert!(mismatched.validate().is_err());

        let overwrite_ok = UpsertChannelOverwriteRequest {
            target_type: "role".to_string(),
            target_id: Uuid::new_v4(),
            allow_bitmask: Some(PERM_VIEW_CHANNEL.to_string()),
            allow_flags: None,
            deny_bitmask: Some(PERM_SEND_MESSAGES.to_string()),
            deny_flags: None,
        };
        assert!(overwrite_ok.validate().is_ok());

        let overwrite_conflict = UpsertChannelOverwriteRequest {
            target_type: "user".to_string(),
            target_id: Uuid::new_v4(),
            allow_bitmask: Some(PERM_SEND_MESSAGES.to_string()),
            allow_flags: None,
            deny_bitmask: Some(PERM_SEND_MESSAGES.to_string()),
            deny_flags: None,
        };
        assert!(overwrite_conflict.validate().is_err());
    }

    #[test]
    fn messages_invites_and_reorder_validations() {
        let msg = SendChannelMessageRequest {
            content: "Olá comunidade!".to_string(),
            client_message_id: Some("client-123".to_string()),
            reply_to_message_id: None,
            attachments: Some(serde_json::json!([])),
        };
        assert!(msg.validate().is_ok());

        let empty_msg = SendChannelMessageRequest {
            content: "   ".to_string(),
            ..Default::default()
        };
        assert!(empty_msg.validate().is_err());

        let bad_attachments = SendChannelMessageRequest {
            content: "Oi".to_string(),
            attachments: Some(serde_json::json!({"not": "array"})),
            ..Default::default()
        };
        assert!(bad_attachments.validate().is_err());

        let query = ChannelMessagesQuery {
            before: None,
            limit: Some(101),
        };
        assert!(query.validate().is_err());

        let invite = CreateInviteRequest {
            channel_id: None,
            max_uses: Some(0),
            expires_in_secs: Some(3600),
        };
        assert!(invite.validate().is_err());

        let dup_id = Uuid::new_v4();
        let reorder = ReorderCategoriesRequest {
            items: vec![
                ReorderCategoryItem {
                    id: dup_id,
                    position: 0,
                },
                ReorderCategoryItem {
                    id: dup_id,
                    position: 1,
                },
            ],
        };
        assert!(reorder.validate().is_err());
    }
}
