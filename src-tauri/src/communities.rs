use reqwest::{Method, Response};
use serde::{Deserialize, Deserializer, Serialize};

use crate::auth::{get_api_base, get_secure_token};
use crate::dm::validate_uuid;

fn require_token() -> Result<String, String> {
    get_secure_token()
        .ok_or_else(|| "Sessão não encontrada. Faça login novamente.".to_string())
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn deserialize_some<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

fn sanitize_invite_code(code: &str) -> Result<String, String> {
    let trimmed = code.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Código de convite inválido.".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_overwrite_target_type(target_type: &str) -> Result<String, String> {
    let trimmed = target_type.trim();
    match trimmed {
        "role" | "user" => Ok(trimmed.to_string()),
        _ => Err("Parâmetro 'target_type' inválido: esperado 'role' ou 'user'.".to_string()),
    }
}

async fn extract_http_error(resp: Response, fallback: &str) -> String {
    let status = resp.status().as_u16();
    let body_text = resp.text().await.unwrap_or_default();

    let extracted = if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body_text) {
        val.get("error")
            .and_then(|e| e.get("message").and_then(|m| m.as_str()))
            .or_else(|| val.get("error").and_then(|e| e.as_str()))
            .or_else(|| val.get("message").and_then(|m| m.as_str()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        let trimmed = body_text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(300).collect())
        }
    };

    let msg = extracted.unwrap_or_else(|| fallback.to_string());
    format!("[HTTP {}] {}", status, msg)
}

async fn send_json_request<T: serde::de::DeserializeOwned>(
    method: Method,
    path: &str,
    body: Option<&impl Serialize>,
    query: Option<&[(&str, String)]>,
    error_fallback: &str,
    decode_label: &str,
) -> Result<T, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}{}", get_api_base(), path);

    let mut req = client
        .request(method, &url)
        .header("Authorization", format!("Bearer {}", token));

    if let Some(q) = query {
        if !q.is_empty() {
            req = req.query(q);
        }
    }

    if let Some(b) = body {
        req = req.json(b);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Falha de conexão com o servidor NEXUS: {}", e))?;

    if resp.status().is_success() {
        resp.json::<T>()
            .await
            .map_err(|e| format!("Falha ao decodificar {}: {}", decode_label, e))
    } else {
        Err(extract_http_error(resp, error_fallback).await)
    }
}

// ==========================================
// Response DTOs
// ==========================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageResponse {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityDto {
    pub id: String,
    pub owner_id: String,
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
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityCategoryDto {
    pub id: String,
    pub community_id: String,
    pub name: String,
    pub position: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPermissionOverwriteDto {
    pub id: String,
    pub channel_id: String,
    pub target_type: String,
    pub target_id: String,
    pub allow_bitmask: String,
    pub allow_flags: Vec<String>,
    pub deny_bitmask: String,
    pub deny_flags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityChannelDto {
    pub id: String,
    pub community_id: String,
    pub category_id: Option<String>,
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
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityRoleDto {
    pub id: String,
    pub community_id: String,
    pub name: String,
    pub color: Option<String>,
    pub position: i32,
    pub permissions_bitmask: String,
    pub permissions_flags: Vec<String>,
    pub is_default: bool,
    pub is_hoisted: bool,
    pub is_mentionable: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityMemberRoleDto {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub position: i32,
    pub is_hoisted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityMemberDto {
    pub community_id: String,
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub status: String,
    pub custom_status: Option<String>,
    pub nickname: Option<String>,
    pub is_owner: bool,
    pub roles: Vec<CommunityMemberRoleDto>,
    pub highest_role_position: i32,
    pub joined_at: String,
    pub text_muted_until: Option<String>,
    pub voice_muted_until: Option<String>,
    pub server_voice_muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityMemberMuteDto {
    pub community_id: String,
    pub user_id: String,
    pub muted_by: Option<String>,
    pub reason: Option<String>,
    pub text_muted_until: Option<String>,
    pub voice_muted_until: Option<String>,
    pub server_voice_muted: bool,
    pub updated_at: String,
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
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub nickname: Option<String>,
    pub role_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMessageDto {
    pub id: String,
    pub channel_id: String,
    pub community_id: String,
    pub sender_id: String,
    pub author: Option<ChannelMessageAuthorDto>,
    pub reply_to_message_id: Option<String>,
    pub content: String,
    pub client_message_id: Option<String>,
    pub attachments: serde_json::Value,
    pub created_at: String,
    pub edited_at: Option<String>,
    pub deleted_at: Option<String>,
    pub is_mine: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMessagesPageDto {
    pub messages: Vec<ChannelMessageDto>,
    pub has_more: bool,
    pub next_before: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelReadStateDto {
    pub channel_id: String,
    pub user_id: String,
    pub last_read_message_id: Option<String>,
    pub last_read_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityInviteDto {
    pub id: String,
    pub community_id: String,
    pub channel_id: Option<String>,
    pub inviter_id: String,
    pub code: String,
    pub max_uses: Option<i32>,
    pub uses_count: i32,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub revoked_by: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvitePreviewDto {
    pub code: String,
    pub community_id: String,
    pub community_name: String,
    pub community_description: Option<String>,
    pub community_icon_url: Option<String>,
    pub community_initials: String,
    pub community_icon_bg: String,
    pub community_accent_color: String,
    pub community_privacy: String,
    pub channel_id: Option<String>,
    pub member_count: i64,
    pub expires_at: Option<String>,
    pub is_valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceptInviteResponse {
    pub community: CommunityDto,
    pub channel_id: Option<String>,
    pub already_member: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityBanDto {
    pub community_id: String,
    pub user_id: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    pub banned_by: String,
    pub reason: Option<String>,
    pub expires_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityAuditLogDto {
    pub id: String,
    pub community_id: String,
    pub actor_id: String,
    pub actor_username: Option<String>,
    pub action: String,
    pub target_type: String,
    pub target_id: Option<String>,
    pub reason: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at: String,
}

// ==========================================
// Request DTOs
// ==========================================

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateCommunityRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initials: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_bg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance_preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateCommunityRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_some",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_some",
        skip_serializing_if = "Option::is_none"
    )]
    pub icon_url: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initials: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_bg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance_preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteCommunityRequest {
    pub confirm_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferOwnershipRequest {
    pub target_user_id: String,
    pub confirm_name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateCategoryRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateCategoryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderCategoryItem {
    pub id: String,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderCategoriesRequest {
    pub items: Vec<ReorderCategoryItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateChannelRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    pub name: String,
    pub channel_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_private: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_bitrate_bps: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_user_limit: Option<i32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateChannelRequest {
    #[serde(
        default,
        deserialize_with = "deserialize_some",
        skip_serializing_if = "Option::is_none"
    )]
    pub category_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_some",
        skip_serializing_if = "Option::is_none"
    )]
    pub topic: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_private: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_read_only: Option<bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_some",
        skip_serializing_if = "Option::is_none"
    )]
    pub voice_bitrate_bps: Option<Option<i32>>,
    #[serde(
        default,
        deserialize_with = "deserialize_some",
        skip_serializing_if = "Option::is_none"
    )]
    pub voice_user_limit: Option<Option<i32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderChannelItem {
    pub id: String,
    pub category_id: Option<String>,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderChannelsRequest {
    pub items: Vec<ReorderChannelItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertChannelOverwriteRequest {
    pub target_type: String,
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_bitmask: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_flags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deny_bitmask: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deny_flags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SendChannelMessageRequest {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditChannelMessageRequest {
    pub content: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MarkChannelReadRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_read_message_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateRoleRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions_bitmask: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions_flags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_hoisted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_mentionable: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateRoleRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_some",
        skip_serializing_if = "Option::is_none"
    )]
    pub color: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions_bitmask: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions_flags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_hoisted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_mentionable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderRoleItem {
    pub id: String,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderRolesRequest {
    pub items: Vec<ReorderRoleItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateMemberRequest {
    #[serde(
        default,
        deserialize_with = "deserialize_some",
        skip_serializing_if = "Option::is_none"
    )]
    pub nickname: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetMemberRolesRequest {
    pub role_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KickMemberRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BanMemberRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_message_hours: Option<i32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MuteMemberRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_some",
        skip_serializing_if = "Option::is_none"
    )]
    pub text_muted_until: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_some",
        skip_serializing_if = "Option::is_none"
    )]
    pub voice_muted_until: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_voice_muted: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateInviteRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_secs: Option<i64>,
}

// ==========================================
// Communities Commands
// ==========================================

#[tauri::command]
pub async fn community_list() -> Result<Vec<CommunityDto>, String> {
    send_json_request(
        Method::GET,
        "/v1/communities",
        None::<&()>,
        None,
        "Erro ao listar comunidades.",
        "lista de comunidades",
    )
    .await
}

#[tauri::command]
pub async fn community_create(payload: CreateCommunityRequest) -> Result<CommunityDto, String> {
    send_json_request(
        Method::POST,
        "/v1/communities",
        Some(&payload),
        None,
        "Erro ao criar comunidade.",
        "comunidade criada",
    )
    .await
}

#[tauri::command]
pub async fn community_get_snapshot(community_id: String) -> Result<CommunitySnapshotDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let path = format!("/v1/communities/{}", cid);
    send_json_request(
        Method::GET,
        &path,
        None::<&()>,
        None,
        "Erro ao carregar snapshot da comunidade.",
        "snapshot da comunidade",
    )
    .await
}

#[tauri::command]
pub async fn community_update(
    community_id: String,
    payload: UpdateCommunityRequest,
) -> Result<CommunityDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let path = format!("/v1/communities/{}", cid);
    send_json_request(
        Method::PATCH,
        &path,
        Some(&payload),
        None,
        "Erro ao atualizar comunidade.",
        "comunidade atualizada",
    )
    .await
}

#[tauri::command]
pub async fn community_delete(
    community_id: String,
    payload: DeleteCommunityRequest,
) -> Result<MessageResponse, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let path = format!("/v1/communities/{}", cid);
    send_json_request(
        Method::DELETE,
        &path,
        Some(&payload),
        None,
        "Erro ao excluir comunidade.",
        "resposta de exclusão",
    )
    .await
}

#[tauri::command]
pub async fn community_transfer_ownership(
    community_id: String,
    mut payload: TransferOwnershipRequest,
) -> Result<CommunityDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    payload.target_user_id = validate_uuid(&payload.target_user_id, "target_user_id")?;
    let path = format!("/v1/communities/{}/transfer-ownership", cid);
    send_json_request(
        Method::POST,
        &path,
        Some(&payload),
        None,
        "Erro ao transferir propriedade da comunidade.",
        "comunidade atualizada",
    )
    .await
}

#[tauri::command]
pub async fn community_leave(community_id: String) -> Result<MessageResponse, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let path = format!("/v1/communities/{}/leave", cid);
    send_json_request(
        Method::POST,
        &path,
        None::<&()>,
        None,
        "Erro ao sair da comunidade.",
        "resposta ao sair da comunidade",
    )
    .await
}

// ==========================================
// Categories Commands
// ==========================================

#[tauri::command]
pub async fn community_create_category(
    community_id: String,
    payload: CreateCategoryRequest,
) -> Result<CommunityCategoryDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let path = format!("/v1/communities/{}/categories", cid);
    send_json_request(
        Method::POST,
        &path,
        Some(&payload),
        None,
        "Erro ao criar categoria.",
        "categoria criada",
    )
    .await
}

#[tauri::command]
pub async fn community_update_category(
    community_id: String,
    category_id: String,
    payload: UpdateCategoryRequest,
) -> Result<CommunityCategoryDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let cat_id = validate_uuid(&category_id, "category_id")?;
    let path = format!("/v1/communities/{}/categories/{}", cid, cat_id);
    send_json_request(
        Method::PATCH,
        &path,
        Some(&payload),
        None,
        "Erro ao atualizar categoria.",
        "categoria atualizada",
    )
    .await
}

#[tauri::command]
pub async fn community_delete_category(
    community_id: String,
    category_id: String,
) -> Result<MessageResponse, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let cat_id = validate_uuid(&category_id, "category_id")?;
    let path = format!("/v1/communities/{}/categories/{}", cid, cat_id);
    send_json_request(
        Method::DELETE,
        &path,
        None::<&()>,
        None,
        "Erro ao excluir categoria.",
        "resposta de exclusão da categoria",
    )
    .await
}

#[tauri::command]
pub async fn community_reorder_categories(
    community_id: String,
    mut payload: ReorderCategoriesRequest,
) -> Result<Vec<CommunityCategoryDto>, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    for item in &mut payload.items {
        item.id = validate_uuid(&item.id, "items[].id")?;
    }
    let path = format!("/v1/communities/{}/categories/reorder", cid);
    send_json_request(
        Method::PUT,
        &path,
        Some(&payload),
        None,
        "Erro ao reordenar categorias.",
        "lista de categorias",
    )
    .await
}

// ==========================================
// Channels & Overwrites Commands
// ==========================================

#[tauri::command]
pub async fn community_create_channel(
    community_id: String,
    mut payload: CreateChannelRequest,
) -> Result<CommunityChannelDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    if let Some(ref cat_id) = payload.category_id {
        payload.category_id = Some(validate_uuid(cat_id, "category_id")?);
    }
    let path = format!("/v1/communities/{}/channels", cid);
    send_json_request(
        Method::POST,
        &path,
        Some(&payload),
        None,
        "Erro ao criar canal.",
        "canal criado",
    )
    .await
}

#[tauri::command]
pub async fn community_update_channel(
    community_id: String,
    channel_id: String,
    mut payload: UpdateChannelRequest,
) -> Result<CommunityChannelDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let ch_id = validate_uuid(&channel_id, "channel_id")?;
    if let Some(Some(ref cat_id)) = payload.category_id {
        payload.category_id = Some(Some(validate_uuid(cat_id, "category_id")?));
    }
    let path = format!("/v1/communities/{}/channels/{}", cid, ch_id);
    send_json_request(
        Method::PATCH,
        &path,
        Some(&payload),
        None,
        "Erro ao atualizar canal.",
        "canal atualizado",
    )
    .await
}

#[tauri::command]
pub async fn community_delete_channel(
    community_id: String,
    channel_id: String,
) -> Result<MessageResponse, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let ch_id = validate_uuid(&channel_id, "channel_id")?;
    let path = format!("/v1/communities/{}/channels/{}", cid, ch_id);
    send_json_request(
        Method::DELETE,
        &path,
        None::<&()>,
        None,
        "Erro ao excluir canal.",
        "resposta de exclusão do canal",
    )
    .await
}

#[tauri::command]
pub async fn community_reorder_channels(
    community_id: String,
    mut payload: ReorderChannelsRequest,
) -> Result<Vec<CommunityChannelDto>, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    for item in &mut payload.items {
        item.id = validate_uuid(&item.id, "items[].id")?;
        if let Some(ref cat_id) = item.category_id {
            item.category_id = Some(validate_uuid(cat_id, "items[].category_id")?);
        }
    }
    let path = format!("/v1/communities/{}/channels/reorder", cid);
    send_json_request(
        Method::PUT,
        &path,
        Some(&payload),
        None,
        "Erro ao reordenar canais.",
        "lista de canais",
    )
    .await
}

#[tauri::command]
pub async fn community_list_channel_overwrites(
    community_id: String,
    channel_id: String,
) -> Result<Vec<ChannelPermissionOverwriteDto>, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let ch_id = validate_uuid(&channel_id, "channel_id")?;
    let path = format!("/v1/communities/{}/channels/{}/overwrites", cid, ch_id);
    send_json_request(
        Method::GET,
        &path,
        None::<&()>,
        None,
        "Erro ao listar sobrescritas de permissão do canal.",
        "lista de sobrescritas",
    )
    .await
}

#[tauri::command]
pub async fn community_upsert_channel_overwrite(
    community_id: String,
    channel_id: String,
    mut payload: UpsertChannelOverwriteRequest,
) -> Result<ChannelPermissionOverwriteDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let ch_id = validate_uuid(&channel_id, "channel_id")?;
    payload.target_type = validate_overwrite_target_type(&payload.target_type)?;
    payload.target_id = validate_uuid(&payload.target_id, "target_id")?;
    let path = format!("/v1/communities/{}/channels/{}/overwrites", cid, ch_id);
    send_json_request(
        Method::PUT,
        &path,
        Some(&payload),
        None,
        "Erro ao salvar sobrescrita de permissão do canal.",
        "sobrescrita salva",
    )
    .await
}

#[tauri::command]
pub async fn community_delete_channel_overwrite(
    community_id: String,
    channel_id: String,
    target_type: String,
    target_id: String,
) -> Result<MessageResponse, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let ch_id = validate_uuid(&channel_id, "channel_id")?;
    let t_type = validate_overwrite_target_type(&target_type)?;
    let t_id = validate_uuid(&target_id, "target_id")?;
    let path = format!(
        "/v1/communities/{}/channels/{}/overwrites/{}/{}",
        cid, ch_id, t_type, t_id
    );
    send_json_request(
        Method::DELETE,
        &path,
        None::<&()>,
        None,
        "Erro ao remover sobrescrita de permissão do canal.",
        "resposta de remoção da sobrescrita",
    )
    .await
}

// ==========================================
// Messages & Read States Commands
// ==========================================

#[tauri::command]
pub async fn community_list_channel_messages(
    community_id: String,
    channel_id: String,
    before: Option<String>,
    limit: Option<i64>,
) -> Result<ChannelMessagesPageDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let ch_id = validate_uuid(&channel_id, "channel_id")?;
    let mut query: Vec<(&str, String)> = Vec::new();
    if let Some(b) = before {
        let valid_b = validate_uuid(&b, "before")?;
        query.push(("before", valid_b));
    }
    if let Some(lim) = limit {
        query.push(("limit", lim.to_string()));
    }
    let path = format!("/v1/communities/{}/channels/{}/messages", cid, ch_id);
    send_json_request(
        Method::GET,
        &path,
        None::<&()>,
        Some(&query),
        "Erro ao listar mensagens do canal.",
        "página de mensagens",
    )
    .await
}

#[tauri::command]
pub async fn community_send_channel_message(
    community_id: String,
    channel_id: String,
    mut payload: SendChannelMessageRequest,
) -> Result<ChannelMessageDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let ch_id = validate_uuid(&channel_id, "channel_id")?;
    if let Some(ref reply_id) = payload.reply_to_message_id {
        payload.reply_to_message_id = Some(validate_uuid(reply_id, "reply_to_message_id")?);
    }
    let path = format!("/v1/communities/{}/channels/{}/messages", cid, ch_id);
    send_json_request(
        Method::POST,
        &path,
        Some(&payload),
        None,
        "Erro ao enviar mensagem no canal.",
        "mensagem enviada",
    )
    .await
}

#[tauri::command]
pub async fn community_edit_channel_message(
    community_id: String,
    channel_id: String,
    message_id: String,
    payload: EditChannelMessageRequest,
) -> Result<ChannelMessageDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let ch_id = validate_uuid(&channel_id, "channel_id")?;
    let msg_id = validate_uuid(&message_id, "message_id")?;
    let path = format!(
        "/v1/communities/{}/channels/{}/messages/{}",
        cid, ch_id, msg_id
    );
    send_json_request(
        Method::PATCH,
        &path,
        Some(&payload),
        None,
        "Erro ao editar mensagem do canal.",
        "mensagem editada",
    )
    .await
}

#[tauri::command]
pub async fn community_delete_channel_message(
    community_id: String,
    channel_id: String,
    message_id: String,
) -> Result<MessageResponse, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let ch_id = validate_uuid(&channel_id, "channel_id")?;
    let msg_id = validate_uuid(&message_id, "message_id")?;
    let path = format!(
        "/v1/communities/{}/channels/{}/messages/{}",
        cid, ch_id, msg_id
    );
    send_json_request(
        Method::DELETE,
        &path,
        None::<&()>,
        None,
        "Erro ao excluir mensagem do canal.",
        "resposta de exclusão da mensagem",
    )
    .await
}

#[tauri::command]
pub async fn community_mark_channel_read(
    community_id: String,
    channel_id: String,
    last_read_message_id: Option<String>,
) -> Result<ChannelReadStateDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let ch_id = validate_uuid(&channel_id, "channel_id")?;
    let validated_msg_id = match last_read_message_id {
        Some(id) => Some(validate_uuid(&id, "last_read_message_id")?),
        None => None,
    };
    let payload = MarkChannelReadRequest {
        last_read_message_id: validated_msg_id,
    };
    let path = format!("/v1/communities/{}/channels/{}/read", cid, ch_id);
    send_json_request(
        Method::POST,
        &path,
        Some(&payload),
        None,
        "Erro ao marcar canal como lido.",
        "estado de leitura do canal",
    )
    .await
}

// ==========================================
// Roles & Members Commands
// ==========================================

#[tauri::command]
pub async fn community_list_roles(community_id: String) -> Result<Vec<CommunityRoleDto>, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let path = format!("/v1/communities/{}/roles", cid);
    send_json_request(
        Method::GET,
        &path,
        None::<&()>,
        None,
        "Erro ao listar cargos da comunidade.",
        "lista de cargos",
    )
    .await
}

#[tauri::command]
pub async fn community_create_role(
    community_id: String,
    payload: CreateRoleRequest,
) -> Result<CommunityRoleDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let path = format!("/v1/communities/{}/roles", cid);
    send_json_request(
        Method::POST,
        &path,
        Some(&payload),
        None,
        "Erro ao criar cargo.",
        "cargo criado",
    )
    .await
}

#[tauri::command]
pub async fn community_update_role(
    community_id: String,
    role_id: String,
    payload: UpdateRoleRequest,
) -> Result<CommunityRoleDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let rid = validate_uuid(&role_id, "role_id")?;
    let path = format!("/v1/communities/{}/roles/{}", cid, rid);
    send_json_request(
        Method::PATCH,
        &path,
        Some(&payload),
        None,
        "Erro ao atualizar cargo.",
        "cargo atualizado",
    )
    .await
}

#[tauri::command]
pub async fn community_delete_role(
    community_id: String,
    role_id: String,
) -> Result<MessageResponse, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let rid = validate_uuid(&role_id, "role_id")?;
    let path = format!("/v1/communities/{}/roles/{}", cid, rid);
    send_json_request(
        Method::DELETE,
        &path,
        None::<&()>,
        None,
        "Erro ao excluir cargo.",
        "resposta de exclusão do cargo",
    )
    .await
}

#[tauri::command]
pub async fn community_reorder_roles(
    community_id: String,
    mut payload: ReorderRolesRequest,
) -> Result<Vec<CommunityRoleDto>, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    for item in &mut payload.items {
        item.id = validate_uuid(&item.id, "items[].id")?;
    }
    let path = format!("/v1/communities/{}/roles/reorder", cid);
    send_json_request(
        Method::PUT,
        &path,
        Some(&payload),
        None,
        "Erro ao reordenar cargos.",
        "lista de cargos",
    )
    .await
}

#[tauri::command]
pub async fn community_list_members(
    community_id: String,
) -> Result<Vec<CommunityMemberDto>, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let path = format!("/v1/communities/{}/members", cid);
    send_json_request(
        Method::GET,
        &path,
        None::<&()>,
        None,
        "Erro ao listar membros da comunidade.",
        "lista de membros",
    )
    .await
}

#[tauri::command]
pub async fn community_update_member(
    community_id: String,
    user_id: String,
    mut payload: UpdateMemberRequest,
) -> Result<CommunityMemberDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let uid = validate_uuid(&user_id, "user_id")?;
    if let Some(ref mut role_ids) = payload.role_ids {
        for rid in role_ids.iter_mut() {
            *rid = validate_uuid(rid, "role_ids[]")?;
        }
    }
    let path = format!("/v1/communities/{}/members/{}", cid, uid);
    send_json_request(
        Method::PATCH,
        &path,
        Some(&payload),
        None,
        "Erro ao atualizar membro.",
        "membro atualizado",
    )
    .await
}

#[tauri::command]
pub async fn community_set_member_roles(
    community_id: String,
    user_id: String,
    role_ids: Vec<String>,
) -> Result<CommunityMemberDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let uid = validate_uuid(&user_id, "user_id")?;
    let mut validated_roles = Vec::with_capacity(role_ids.len());
    for rid in role_ids {
        validated_roles.push(validate_uuid(&rid, "role_ids[]")?);
    }
    let payload = SetMemberRolesRequest {
        role_ids: validated_roles,
    };
    let path = format!("/v1/communities/{}/members/{}/roles", cid, uid);
    send_json_request(
        Method::PUT,
        &path,
        Some(&payload),
        None,
        "Erro ao definir cargos do membro.",
        "membro atualizado",
    )
    .await
}

#[tauri::command]
pub async fn community_add_member_role(
    community_id: String,
    user_id: String,
    role_id: String,
) -> Result<CommunityMemberDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let uid = validate_uuid(&user_id, "user_id")?;
    let rid = validate_uuid(&role_id, "role_id")?;
    let path = format!("/v1/communities/{}/members/{}/roles/{}", cid, uid, rid);
    send_json_request(
        Method::POST,
        &path,
        None::<&()>,
        None,
        "Erro ao adicionar cargo ao membro.",
        "membro atualizado",
    )
    .await
}

#[tauri::command]
pub async fn community_remove_member_role(
    community_id: String,
    user_id: String,
    role_id: String,
) -> Result<CommunityMemberDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let uid = validate_uuid(&user_id, "user_id")?;
    let rid = validate_uuid(&role_id, "role_id")?;
    let path = format!("/v1/communities/{}/members/{}/roles/{}", cid, uid, rid);
    send_json_request(
        Method::DELETE,
        &path,
        None::<&()>,
        None,
        "Erro ao remover cargo do membro.",
        "membro atualizado",
    )
    .await
}

// ==========================================
// Moderation & Audit Logs Commands
// ==========================================

#[tauri::command]
pub async fn community_kick_member(
    community_id: String,
    user_id: String,
    reason: Option<String>,
) -> Result<MessageResponse, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let uid = validate_uuid(&user_id, "user_id")?;
    let payload = KickMemberRequest { reason };
    let path = format!("/v1/communities/{}/members/{}/kick", cid, uid);
    send_json_request(
        Method::POST,
        &path,
        Some(&payload),
        None,
        "Erro ao expulsar membro.",
        "resposta de expulsão",
    )
    .await
}

#[tauri::command]
pub async fn community_ban_member(
    community_id: String,
    user_id: String,
    payload: Option<BanMemberRequest>,
) -> Result<CommunityBanDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let uid = validate_uuid(&user_id, "user_id")?;
    let body = payload.unwrap_or_default();
    let path = format!("/v1/communities/{}/members/{}/ban", cid, uid);
    send_json_request(
        Method::POST,
        &path,
        Some(&body),
        None,
        "Erro ao banir membro.",
        "banimento registrado",
    )
    .await
}

#[tauri::command]
pub async fn community_unban_member(
    community_id: String,
    user_id: String,
) -> Result<MessageResponse, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let uid = validate_uuid(&user_id, "user_id")?;
    let path = format!("/v1/communities/{}/bans/{}", cid, uid);
    send_json_request(
        Method::DELETE,
        &path,
        None::<&()>,
        None,
        "Erro ao revogar banimento.",
        "resposta de revogação do banimento",
    )
    .await
}

#[tauri::command]
pub async fn community_list_bans(community_id: String) -> Result<Vec<CommunityBanDto>, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let path = format!("/v1/communities/{}/bans", cid);
    send_json_request(
        Method::GET,
        &path,
        None::<&()>,
        None,
        "Erro ao listar banimentos.",
        "lista de banimentos",
    )
    .await
}

#[tauri::command]
pub async fn community_mute_member(
    community_id: String,
    user_id: String,
    payload: MuteMemberRequest,
) -> Result<CommunityMemberMuteDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let uid = validate_uuid(&user_id, "user_id")?;
    let path = format!("/v1/communities/{}/members/{}/mute", cid, uid);
    send_json_request(
        Method::PUT,
        &path,
        Some(&payload),
        None,
        "Erro ao atualizar silenciamento do membro.",
        "estado de silenciamento",
    )
    .await
}

#[tauri::command]
pub async fn community_list_audit_logs(
    community_id: String,
    action: Option<String>,
    actor_id: Option<String>,
    before: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<CommunityAuditLogDto>, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let mut query: Vec<(&str, String)> = Vec::new();
    if let Some(act) = action {
        let trimmed = act.trim();
        if !trimmed.is_empty() {
            query.push(("action", trimmed.to_string()));
        }
    }
    if let Some(actor) = actor_id {
        let valid_actor = validate_uuid(&actor, "actor_id")?;
        query.push(("actor_id", valid_actor));
    }
    if let Some(b) = before {
        let valid_b = validate_uuid(&b, "before")?;
        query.push(("before", valid_b));
    }
    if let Some(lim) = limit {
        query.push(("limit", lim.to_string()));
    }
    let path = format!("/v1/communities/{}/audit-logs", cid);
    send_json_request(
        Method::GET,
        &path,
        None::<&()>,
        Some(&query),
        "Erro ao listar logs de auditoria.",
        "logs de auditoria",
    )
    .await
}

// ==========================================
// Invites Commands
// ==========================================

#[tauri::command]
pub async fn community_create_invite(
    community_id: String,
    payload: Option<CreateInviteRequest>,
) -> Result<CommunityInviteDto, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let mut body = payload.unwrap_or_default();
    if let Some(ref ch_id) = body.channel_id {
        body.channel_id = Some(validate_uuid(ch_id, "channel_id")?);
    }
    let path = format!("/v1/communities/{}/invites", cid);
    send_json_request(
        Method::POST,
        &path,
        Some(&body),
        None,
        "Erro ao criar convite.",
        "convite criado",
    )
    .await
}

#[tauri::command]
pub async fn community_list_invites(
    community_id: String,
) -> Result<Vec<CommunityInviteDto>, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let path = format!("/v1/communities/{}/invites", cid);
    send_json_request(
        Method::GET,
        &path,
        None::<&()>,
        None,
        "Erro ao listar convites.",
        "lista de convites",
    )
    .await
}

#[tauri::command]
pub async fn community_revoke_invite(
    community_id: String,
    invite_id: String,
) -> Result<MessageResponse, String> {
    let cid = validate_uuid(&community_id, "community_id")?;
    let inv_id = validate_uuid(&invite_id, "invite_id")?;
    let path = format!("/v1/communities/{}/invites/{}", cid, inv_id);
    send_json_request(
        Method::DELETE,
        &path,
        None::<&()>,
        None,
        "Erro ao revogar convite.",
        "resposta de revogação do convite",
    )
    .await
}

#[tauri::command]
pub async fn community_get_invite_preview(code: String) -> Result<InvitePreviewDto, String> {
    let clean_code = sanitize_invite_code(&code)?;
    let path = format!("/v1/invites/{}", clean_code);
    send_json_request(
        Method::GET,
        &path,
        None::<&()>,
        None,
        "Erro ao carregar prévia do convite.",
        "prévia do convite",
    )
    .await
}

#[tauri::command]
pub async fn community_accept_invite(code: String) -> Result<AcceptInviteResponse, String> {
    let clean_code = sanitize_invite_code(&code)?;
    let path = format!("/v1/invites/{}/accept", clean_code);
    send_json_request(
        Method::POST,
        &path,
        None::<&()>,
        None,
        "Erro ao aceitar convite.",
        "resposta ao aceitar convite",
    )
    .await
}
