use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::errors::AppError;
use crate::middleware::CurrentUser;
use crate::models::{
    FriendDto, FriendRequestDto, FriendRequestsResponse, MessageResponse, PresenceResponse,
    SendFriendRequest, UpdatePresenceRequest, UserSearchDto,
};
use crate::services::FriendService;

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub username: Option<String>,
    pub q: Option<String>,
}

/// GET /v1/friends - List current user's friends with live presence
pub async fn list_friends(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
) -> Result<Json<Vec<FriendDto>>, AppError> {
    let friends = friend_service.get_friends(auth_user.id).await?;
    Ok(Json(friends))
}

/// GET /v1/friends/requests - List pending incoming and outgoing friend requests
pub async fn list_requests(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
) -> Result<Json<FriendRequestsResponse>, AppError> {
    let requests = friend_service.get_requests(auth_user.id).await?;
    Ok(Json(requests))
}

/// POST /v1/friends/requests - Send a new friend request
pub async fn send_request(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Json(payload): Json<SendFriendRequest>,
) -> Result<Json<FriendRequestDto>, AppError> {
    let target = payload.get_target();
    if target.is_empty() {
        return Err(AppError::BadRequest(
            "O nome de usuário para envio da solicitação é obrigatório.".to_string(),
        ));
    }

    let request = friend_service.send_request(auth_user.id, target).await?;
    Ok(Json(request))
}

/// POST /v1/friends/requests/:id/accept - Accept an incoming friend request
pub async fn accept_request(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(request_id): Path<Uuid>,
) -> Result<Json<FriendDto>, AppError> {
    let friend = friend_service
        .accept_request(request_id, auth_user.id)
        .await?;
    Ok(Json(friend))
}

/// POST /v1/friends/requests/:id/reject - Reject an incoming friend request
pub async fn reject_request(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(request_id): Path<Uuid>,
) -> Result<Json<MessageResponse>, AppError> {
    friend_service
        .reject_request(request_id, auth_user.id)
        .await?;
    Ok(Json(MessageResponse {
        message: "Solicitação de amizade recusada com sucesso.".to_string(),
    }))
}

/// DELETE /v1/friends/requests/:id - Cancel or delete a friend request
pub async fn cancel_request(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(request_id): Path<Uuid>,
) -> Result<Json<MessageResponse>, AppError> {
    friend_service
        .cancel_request(request_id, auth_user.id)
        .await?;
    Ok(Json(MessageResponse {
        message: "Solicitação de amizade cancelada com sucesso.".to_string(),
    }))
}

/// DELETE /v1/friends/:friend_id - Remove an existing friend
pub async fn remove_friend(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(friend_id): Path<Uuid>,
) -> Result<Json<MessageResponse>, AppError> {
    friend_service
        .remove_friend(auth_user.id, friend_id)
        .await?;
    Ok(Json(MessageResponse {
        message: "Amizade desfeita com sucesso.".to_string(),
    }))
}

/// POST /v1/users/:id/block - Block a user
pub async fn block_user(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(target_user_id): Path<Uuid>,
) -> Result<Json<MessageResponse>, AppError> {
    friend_service
        .block_user(auth_user.id, target_user_id)
        .await?;
    Ok(Json(MessageResponse {
        message: "Usuário bloqueado com sucesso.".to_string(),
    }))
}

/// DELETE /v1/users/:id/block - Unblock a user
pub async fn unblock_user(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(target_user_id): Path<Uuid>,
) -> Result<Json<MessageResponse>, AppError> {
    friend_service
        .unblock_user(auth_user.id, target_user_id)
        .await?;
    Ok(Json(MessageResponse {
        message: "Usuário desbloqueado com sucesso.".to_string(),
    }))
}

/// GET /v1/users/search?username=... - Search registered users by exact or prefix username
pub async fn search_users(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<UserSearchDto>>, AppError> {
    let q = query
        .username
        .or(query.q)
        .unwrap_or_default();

    let users = friend_service.search_users(auth_user.id, &q).await?;
    Ok(Json(users))
}

/// GET /v1/users/me/presence - Get current user's presence & preferences
pub async fn get_presence(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
) -> Result<Json<PresenceResponse>, AppError> {
    let presence = friend_service.get_presence(auth_user.id).await?;
    Ok(Json(presence))
}

/// PATCH /v1/users/me/presence - Update current user's presence & preferences
pub async fn update_presence(
    State(friend_service): State<FriendService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Json(payload): Json<UpdatePresenceRequest>,
) -> Result<Json<PresenceResponse>, AppError> {
    let pref = payload.preferred_status.as_deref().or(payload.status.as_deref());

    let presence = friend_service
        .update_presence(
            auth_user.id,
            pref,
            payload.custom_status.as_deref(),
            payload.activity.as_deref(),
            payload.allow_friend_requests,
        )
        .await?;

    Ok(Json(presence))
}
