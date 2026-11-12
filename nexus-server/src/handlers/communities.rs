use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::errors::AppError;
use crate::middleware::CurrentUser;
use crate::models::{
    AcceptInviteResponse, AuditLogsQuery, BanMemberRequest, ChannelMessageDto,
    ChannelMessagesPageDto, ChannelMessagesQuery, ChannelPermissionOverwriteDto,
    ChannelReadStateDto, CommunityAuditLogDto, CommunityBan, CommunityBanDto,
    CommunityCategoryDto, CommunityChannelDto, CommunityDto, CommunityInviteDto,
    CommunityMemberDto, CommunityMemberMuteDto, CommunityRoleDto, CommunitySnapshotDto,
    CreateCategoryRequest, CreateChannelRequest, CreateCommunityRequest, CreateInviteRequest,
    CreateRoleRequest, DeleteCommunityRequest, EditChannelMessageRequest, InvitePreviewDto,
    KickMemberRequest, MarkChannelReadRequest, MessageResponse, MuteMemberRequest,
    ReorderCategoriesRequest, ReorderChannelsRequest, ReorderRolesRequest,
    SendChannelMessageRequest, TransferOwnershipRequest, UpdateCategoryRequest,
    UpdateChannelRequest, UpdateCommunityRequest, UpdateMemberRequest, UpdateRoleRequest,
    UpsertChannelOverwriteRequest,
};
use crate::services::CommunityService;

#[derive(Debug, Clone, Deserialize)]
pub struct SetMemberRolesRequest {
    pub role_ids: Vec<Uuid>,
}

// ==========================================
// Communities
// ==========================================

/// POST /v1/communities
pub async fn create_community(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(payload): Json<CreateCommunityRequest>,
) -> Result<Json<CommunityDto>, AppError> {
    let community = service.create_community(user.id, &payload).await?;
    Ok(Json(community))
}

/// GET /v1/communities
pub async fn list_communities(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<Vec<CommunityDto>>, AppError> {
    let communities = service.list_communities(user.id).await?;
    Ok(Json(communities))
}

/// GET /v1/communities/:community_id
pub async fn get_snapshot(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Result<Json<CommunitySnapshotDto>, AppError> {
    let snapshot = service.get_snapshot(community_id, user.id).await?;
    Ok(Json(snapshot))
}

/// PATCH /v1/communities/:community_id
pub async fn update_community(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Json(payload): Json<UpdateCommunityRequest>,
) -> Result<Json<CommunityDto>, AppError> {
    let updated = service
        .update_community(community_id, user.id, &payload)
        .await?;
    Ok(Json(updated))
}

/// DELETE /v1/communities/:community_id
pub async fn delete_community(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Json(payload): Json<DeleteCommunityRequest>,
) -> Result<Json<MessageResponse>, AppError> {
    service
        .delete_community(community_id, user.id, &payload)
        .await?;
    Ok(Json(MessageResponse {
        message: "Comunidade excluída com sucesso.".to_string(),
    }))
}

/// POST /v1/communities/:community_id/transfer-ownership
pub async fn transfer_ownership(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Json(payload): Json<TransferOwnershipRequest>,
) -> Result<Json<CommunityDto>, AppError> {
    let updated = service
        .transfer_ownership(community_id, user.id, &payload)
        .await?;
    Ok(Json(updated))
}

/// POST /v1/communities/:community_id/leave
pub async fn leave_community(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Result<Json<MessageResponse>, AppError> {
    service.leave_community(community_id, user.id).await?;
    Ok(Json(MessageResponse {
        message: "Você saiu da comunidade com sucesso.".to_string(),
    }))
}

// ==========================================
// Categories
// ==========================================

/// POST /v1/communities/:community_id/categories
pub async fn create_category(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Json(payload): Json<CreateCategoryRequest>,
) -> Result<Json<CommunityCategoryDto>, AppError> {
    let category = service
        .create_category(community_id, user.id, &payload)
        .await?;
    Ok(Json(category))
}

/// PATCH /v1/communities/:community_id/categories/:category_id
pub async fn update_category(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, category_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateCategoryRequest>,
) -> Result<Json<CommunityCategoryDto>, AppError> {
    let category = service
        .update_category(community_id, category_id, user.id, &payload)
        .await?;
    Ok(Json(category))
}

/// DELETE /v1/communities/:community_id/categories/:category_id
pub async fn delete_category(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, category_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<MessageResponse>, AppError> {
    service
        .delete_category(community_id, category_id, user.id)
        .await?;
    Ok(Json(MessageResponse {
        message: "Categoria excluída com sucesso.".to_string(),
    }))
}

/// PUT /v1/communities/:community_id/categories/reorder
pub async fn reorder_categories(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Json(payload): Json<ReorderCategoriesRequest>,
) -> Result<Json<Vec<CommunityCategoryDto>>, AppError> {
    let categories = service
        .reorder_categories(community_id, user.id, &payload)
        .await?;
    Ok(Json(categories))
}

// ==========================================
// Channels & Overwrites
// ==========================================

/// POST /v1/communities/:community_id/channels
pub async fn create_channel(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Json(payload): Json<CreateChannelRequest>,
) -> Result<Json<CommunityChannelDto>, AppError> {
    let channel = service
        .create_channel(community_id, user.id, &payload)
        .await?;
    Ok(Json(channel))
}

/// PATCH /v1/communities/:community_id/channels/:channel_id
pub async fn update_channel(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, channel_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateChannelRequest>,
) -> Result<Json<CommunityChannelDto>, AppError> {
    let channel = service
        .update_channel(community_id, channel_id, user.id, &payload)
        .await?;
    Ok(Json(channel))
}

/// DELETE /v1/communities/:community_id/channels/:channel_id
pub async fn delete_channel(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, channel_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<MessageResponse>, AppError> {
    service
        .delete_channel(community_id, channel_id, user.id)
        .await?;
    Ok(Json(MessageResponse {
        message: "Canal excluído com sucesso.".to_string(),
    }))
}

/// PUT /v1/communities/:community_id/channels/reorder
pub async fn reorder_channels(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Json(payload): Json<ReorderChannelsRequest>,
) -> Result<Json<Vec<CommunityChannelDto>>, AppError> {
    let channels = service
        .reorder_channels(community_id, user.id, &payload)
        .await?;
    Ok(Json(channels))
}

/// GET /v1/communities/:community_id/channels/:channel_id/overwrites
pub async fn list_channel_overwrites(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, channel_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Vec<ChannelPermissionOverwriteDto>>, AppError> {
    let overwrites = service
        .list_channel_overwrites(community_id, channel_id, user.id)
        .await?;
    Ok(Json(overwrites))
}

/// PUT /v1/communities/:community_id/channels/:channel_id/overwrites
pub async fn upsert_channel_overwrite(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, channel_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpsertChannelOverwriteRequest>,
) -> Result<Json<ChannelPermissionOverwriteDto>, AppError> {
    let overwrite = service
        .upsert_channel_overwrite(community_id, channel_id, user.id, &payload)
        .await?;
    Ok(Json(overwrite))
}

/// DELETE /v1/communities/:community_id/channels/:channel_id/overwrites/:target_type/:target_id
pub async fn delete_channel_overwrite(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, channel_id, target_type, target_id)): Path<(Uuid, Uuid, String, Uuid)>,
) -> Result<Json<MessageResponse>, AppError> {
    service
        .delete_channel_overwrite(community_id, channel_id, user.id, &target_type, target_id)
        .await?;
    Ok(Json(MessageResponse {
        message: "Sobrescrita de permissão removida com sucesso.".to_string(),
    }))
}

// ==========================================
// Messages & Read States
// ==========================================

/// GET /v1/communities/:community_id/channels/:channel_id/messages
pub async fn list_channel_messages(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, channel_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<ChannelMessagesQuery>,
) -> Result<Json<ChannelMessagesPageDto>, AppError> {
    let page = service
        .list_channel_messages(community_id, channel_id, user.id, &query)
        .await?;
    Ok(Json(page))
}

/// POST /v1/communities/:community_id/channels/:channel_id/messages
pub async fn send_channel_message(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, channel_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<SendChannelMessageRequest>,
) -> Result<Json<ChannelMessageDto>, AppError> {
    let message = service
        .send_channel_message(community_id, channel_id, user.id, &payload)
        .await?;
    Ok(Json(message))
}

/// PATCH /v1/communities/:community_id/channels/:channel_id/messages/:message_id
pub async fn edit_channel_message(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, channel_id, message_id)): Path<(Uuid, Uuid, Uuid)>,
    Json(payload): Json<EditChannelMessageRequest>,
) -> Result<Json<ChannelMessageDto>, AppError> {
    let message = service
        .edit_channel_message(community_id, channel_id, message_id, user.id, &payload)
        .await?;
    Ok(Json(message))
}

/// DELETE /v1/communities/:community_id/channels/:channel_id/messages/:message_id
pub async fn delete_channel_message(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, channel_id, message_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<MessageResponse>, AppError> {
    service
        .delete_channel_message(community_id, channel_id, message_id, user.id)
        .await?;
    Ok(Json(MessageResponse {
        message: "Mensagem excluída com sucesso.".to_string(),
    }))
}

/// POST /v1/communities/:community_id/channels/:channel_id/read
pub async fn mark_channel_read(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, channel_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<Option<MarkChannelReadRequest>>,
) -> Result<Json<ChannelReadStateDto>, AppError> {
    let req = payload.unwrap_or_default();
    let state = service
        .mark_channel_read(community_id, channel_id, user.id, &req)
        .await?;
    Ok(Json(state))
}

// ==========================================
// Roles & Members
// ==========================================

/// GET /v1/communities/:community_id/roles
pub async fn list_roles(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Result<Json<Vec<CommunityRoleDto>>, AppError> {
    let roles = service.list_roles(community_id, user.id).await?;
    Ok(Json(roles))
}

/// POST /v1/communities/:community_id/roles
pub async fn create_role(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Json(payload): Json<CreateRoleRequest>,
) -> Result<Json<CommunityRoleDto>, AppError> {
    let role = service.create_role(community_id, user.id, &payload).await?;
    Ok(Json(role))
}

/// PATCH /v1/communities/:community_id/roles/:role_id
pub async fn update_role(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, role_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateRoleRequest>,
) -> Result<Json<CommunityRoleDto>, AppError> {
    let role = service
        .update_role(community_id, role_id, user.id, &payload)
        .await?;
    Ok(Json(role))
}

/// DELETE /v1/communities/:community_id/roles/:role_id
pub async fn delete_role(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, role_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<MessageResponse>, AppError> {
    service.delete_role(community_id, role_id, user.id).await?;
    Ok(Json(MessageResponse {
        message: "Cargo excluído com sucesso.".to_string(),
    }))
}

/// PUT /v1/communities/:community_id/roles/reorder
pub async fn reorder_roles(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Json(payload): Json<ReorderRolesRequest>,
) -> Result<Json<Vec<CommunityRoleDto>>, AppError> {
    let roles = service
        .reorder_roles(community_id, user.id, &payload)
        .await?;
    Ok(Json(roles))
}

/// GET /v1/communities/:community_id/members
pub async fn list_members(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Result<Json<Vec<CommunityMemberDto>>, AppError> {
    let members = service.list_members(community_id, user.id).await?;
    Ok(Json(members))
}

/// PATCH /v1/communities/:community_id/members/:user_id
pub async fn update_member(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateMemberRequest>,
) -> Result<Json<CommunityMemberDto>, AppError> {
    let member = service
        .update_member(community_id, target_user_id, user.id, &payload)
        .await?;
    Ok(Json(member))
}

/// PUT /v1/communities/:community_id/members/:user_id/roles
pub async fn set_member_roles(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<SetMemberRolesRequest>,
) -> Result<Json<CommunityMemberDto>, AppError> {
    let member = service
        .set_member_roles(community_id, target_user_id, user.id, &payload.role_ids)
        .await?;
    Ok(Json(member))
}

/// POST /v1/communities/:community_id/members/:user_id/roles/:role_id
pub async fn add_member_role(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, target_user_id, role_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<CommunityMemberDto>, AppError> {
    let member = service
        .add_member_role(community_id, target_user_id, role_id, user.id)
        .await?;
    Ok(Json(member))
}

/// DELETE /v1/communities/:community_id/members/:user_id/roles/:role_id
pub async fn remove_member_role(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, target_user_id, role_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<CommunityMemberDto>, AppError> {
    let member = service
        .remove_member_role(community_id, target_user_id, role_id, user.id)
        .await?;
    Ok(Json(member))
}

// ==========================================
// Moderation & Audit Logs
// ==========================================

/// POST /v1/communities/:community_id/members/:user_id/kick
pub async fn kick_member(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<Option<KickMemberRequest>>,
) -> Result<Json<MessageResponse>, AppError> {
    let req = payload.unwrap_or_default();
    service
        .kick_member(community_id, target_user_id, user.id, &req)
        .await?;
    Ok(Json(MessageResponse {
        message: "Membro expulso com sucesso.".to_string(),
    }))
}

/// POST /v1/communities/:community_id/members/:user_id/ban
pub async fn ban_member(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<Option<BanMemberRequest>>,
) -> Result<Json<CommunityBan>, AppError> {
    let req = payload.unwrap_or_default();
    let ban = service
        .ban_member(community_id, target_user_id, user.id, &req)
        .await?;
    Ok(Json(ban))
}

/// DELETE /v1/communities/:community_id/bans/:user_id
pub async fn unban_member(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, target_user_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<MessageResponse>, AppError> {
    service
        .unban_member(community_id, target_user_id, user.id)
        .await?;
    Ok(Json(MessageResponse {
        message: "Banimento revogado com sucesso.".to_string(),
    }))
}

/// GET /v1/communities/:community_id/bans
pub async fn list_bans(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Result<Json<Vec<CommunityBanDto>>, AppError> {
    let bans = service.list_bans(community_id, user.id).await?;
    Ok(Json(bans))
}

/// PUT /v1/communities/:community_id/members/:user_id/mute
pub async fn mute_member(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<MuteMemberRequest>,
) -> Result<Json<CommunityMemberMuteDto>, AppError> {
    let mute = service
        .mute_member(community_id, target_user_id, user.id, &payload)
        .await?;
    Ok(Json(mute))
}

/// GET /v1/communities/:community_id/audit-logs
pub async fn list_audit_logs(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Query(query): Query<AuditLogsQuery>,
) -> Result<Json<Vec<CommunityAuditLogDto>>, AppError> {
    let logs = service
        .list_audit_logs(community_id, user.id, &query)
        .await?;
    Ok(Json(logs))
}

// ==========================================
// Invites
// ==========================================

/// POST /v1/communities/:community_id/invites
pub async fn create_invite(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    Json(payload): Json<Option<CreateInviteRequest>>,
) -> Result<Json<CommunityInviteDto>, AppError> {
    let req = payload.unwrap_or_default();
    let invite = service.create_invite(community_id, user.id, &req).await?;
    Ok(Json(invite))
}

/// GET /v1/communities/:community_id/invites
pub async fn list_invites(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Result<Json<Vec<CommunityInviteDto>>, AppError> {
    let invites = service.list_invites(community_id, user.id).await?;
    Ok(Json(invites))
}

/// DELETE /v1/communities/:community_id/invites/:invite_id
pub async fn revoke_invite(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((community_id, invite_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<MessageResponse>, AppError> {
    service
        .revoke_invite(community_id, invite_id, user.id)
        .await?;
    Ok(Json(MessageResponse {
        message: "Convite revogado com sucesso.".to_string(),
    }))
}

/// GET /v1/invites/:code
pub async fn get_invite_preview(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(code): Path<String>,
) -> Result<Json<InvitePreviewDto>, AppError> {
    let preview = service.get_invite_preview(&code, user.id).await?;
    Ok(Json(preview))
}

/// POST /v1/invites/:code/accept
pub async fn accept_invite(
    State(service): State<CommunityService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(code): Path<String>,
) -> Result<Json<AcceptInviteResponse>, AppError> {
    let accepted = service.accept_invite(&code, user.id).await?;
    Ok(Json(accepted))
}
