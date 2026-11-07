use axum::{extract::State, Extension, Json};
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
