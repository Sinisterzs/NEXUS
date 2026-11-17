use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::IntoResponse,
    Extension, Json,
};
use validator::Validate;

use crate::errors::AppError;
use crate::middleware::CurrentUser;
use crate::models::{UpdateProfileRequest, UserProfileResponse};
use crate::routes::UsersState;

pub async fn get_me(Extension(CurrentUser(user)): Extension<CurrentUser>) -> Json<UserProfileResponse> {
    Json(user)
}

pub async fn update_me(
    State(state): State<UsersState>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(payload): Json<UpdateProfileRequest>,
) -> Result<Json<UserProfileResponse>, AppError> {
    payload
        .validate()
        .map_err(|e| AppError::ValidationError(e.to_string()))?;

    let updated = state
        .auth_service
        .update_profile(user.id, payload)
        .await?;

    // If custom_status was updated, inform friend presence manager to broadcast to friends
    if let Some(ref cs) = updated.custom_status {
        let _ = state
            .friend_service
            .update_presence(user.id, None, Some(cs.as_str()), None, None)
            .await;
    }

    Ok(Json(updated))
}

pub async fn upload_my_avatar(
    State(state): State<UsersState>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    body: Bytes,
) -> Result<Json<UserProfileResponse>, AppError> {
    let storage = crate::services::LocalVolumeAvatarStorage::from_env();
    let (filename, _) = storage.store_avatar(&body).await?;
    let new_url = format!("/v1/avatars/{filename}");
    let old_url = user.avatar_url.clone();

    sqlx::query("UPDATE user_profiles SET avatar_url = $1 WHERE user_id = $2")
        .bind(&new_url)
        .bind(user.id)
        .execute(state.auth_service.pool())
        .await?;

    let updated = state.auth_service.get_user_profile(user.id).await?;

    if let Some(prev) = old_url {
        storage.delete_by_url(&prev).await;
    }

    Ok(Json(updated))
}

pub async fn delete_my_avatar(
    State(state): State<UsersState>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<UserProfileResponse>, AppError> {
    let storage = crate::services::LocalVolumeAvatarStorage::from_env();
    let old_url = user.avatar_url.clone();

    sqlx::query("UPDATE user_profiles SET avatar_url = NULL WHERE user_id = $1")
        .bind(user.id)
        .execute(state.auth_service.pool())
        .await?;

    let updated = state.auth_service.get_user_profile(user.id).await?;

    if let Some(prev) = old_url {
        storage.delete_by_url(&prev).await;
    }

    Ok(Json(updated))
}

pub async fn get_avatar(Path(filename): Path<String>) -> Result<impl IntoResponse, AppError> {
    let storage = crate::services::LocalVolumeAvatarStorage::from_env();
    let (bytes, content_type) = storage.read_avatar(&filename).await?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            ),
        ],
        bytes,
    ))
}
