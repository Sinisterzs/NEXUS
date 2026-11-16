use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::errors::AppError;
use crate::middleware::CurrentUser;
use crate::repositories::{DmRequestRepository, dm_requests::DmMessageRequest};
use crate::services::social_policy::{
    DmPolicy, FriendRequestPolicy, PrivateCallPolicy, SocialPolicyService, UserPrivacyPreferences,
};

#[derive(Clone)]
pub struct SocialPrivacyState {
    pub policy_service: SocialPolicyService,
    pub dm_request_repo: DmRequestRepository,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdatePrivacyPreferencesRequest {
    pub dm_policy: DmPolicy,
    pub friend_request_policy: FriendRequestPolicy,
    pub private_call_policy: PrivateCallPolicy,
}

fn dm_policy_str(p: DmPolicy) -> &'static str {
    match p {
        DmPolicy::FriendsOnly => "friends_only",
        DmPolicy::FriendsAndCommunity => "friends_and_community",
        DmPolicy::Nobody => "nobody",
    }
}

fn friend_request_policy_str(p: FriendRequestPolicy) -> &'static str {
    match p {
        FriendRequestPolicy::Everyone => "everyone",
        FriendRequestPolicy::CommunityOnly => "community_only",
        FriendRequestPolicy::Nobody => "nobody",
    }
}

fn private_call_policy_str(p: PrivateCallPolicy) -> &'static str {
    match p {
        PrivateCallPolicy::FriendsOnly => "friends_only",
        PrivateCallPolicy::Nobody => "nobody",
    }
}

/// `GET /v1/users/me/privacy`
pub async fn get_my_privacy_preferences(
    State(state): State<SocialPrivacyState>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<UserPrivacyPreferences>, AppError> {
    let prefs = state.policy_service.get_preferences(user.id).await?;
    Ok(Json(prefs))
}

/// `PUT /v1/users/me/privacy`
pub async fn update_my_privacy_preferences(
    State(state): State<SocialPrivacyState>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(payload): Json<UpdatePrivacyPreferencesRequest>,
) -> Result<Json<UserPrivacyPreferences>, AppError> {
    let dm = dm_policy_str(payload.dm_policy);
    let fr = friend_request_policy_str(payload.friend_request_policy);
    let pc = private_call_policy_str(payload.private_call_policy);

    let updated_at: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        r#"
        INSERT INTO user_privacy_preferences (user_id, dm_policy, friend_request_policy, private_call_policy, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            dm_policy = EXCLUDED.dm_policy,
            friend_request_policy = EXCLUDED.friend_request_policy,
            private_call_policy = EXCLUDED.private_call_policy,
            updated_at = NOW()
        RETURNING updated_at
        "#,
    )
    .bind(user.id)
    .bind(dm)
    .bind(fr)
    .bind(pc)
    .fetch_one(state.policy_service.pool())
    .await?;

    Ok(Json(UserPrivacyPreferences {
        user_id: user.id,
        dm_policy: payload.dm_policy,
        friend_request_policy: payload.friend_request_policy,
        private_call_policy: payload.private_call_policy,
        updated_at: Some(updated_at),
    }))
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateDmRequestPayload {
    pub conversation_id: Uuid,
    pub recipient_id: Uuid,
}

/// `POST /v1/dm/requests`
pub async fn create_dm_request(
    State(state): State<SocialPrivacyState>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(payload): Json<CreateDmRequestPayload>,
) -> Result<(StatusCode, Json<DmMessageRequest>), AppError> {
    let created = state
        .dm_request_repo
        .create_request(
            &state.policy_service,
            payload.conversation_id,
            user.id,
            payload.recipient_id,
        )
        .await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// `GET /v1/dm/requests`
pub async fn list_dm_requests(
    State(state): State<SocialPrivacyState>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<Vec<DmMessageRequest>>, AppError> {
    let rows = state.dm_request_repo.list_incoming_pending(user.id).await?;
    Ok(Json(rows))
}

/// `POST /v1/dm/requests/:id/accept`
pub async fn accept_dm_request(
    State(state): State<SocialPrivacyState>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(request_id): Path<Uuid>,
) -> Result<(StatusCode, Json<DmMessageRequest>), AppError> {
    let updated = state
        .dm_request_repo
        .accept_request(request_id, user.id)
        .await?;
    Ok((StatusCode::OK, Json(updated)))
}

/// `POST /v1/dm/requests/:id/decline`
pub async fn decline_dm_request(
    State(state): State<SocialPrivacyState>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(request_id): Path<Uuid>,
) -> Result<(StatusCode, Json<DmMessageRequest>), AppError> {
    let updated = state
        .dm_request_repo
        .decline_request(request_id, user.id, 24)
        .await?;
    Ok((StatusCode::OK, Json(updated)))
}
