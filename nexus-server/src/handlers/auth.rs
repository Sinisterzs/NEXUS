use axum::{
    extract::{Request, State},
    http::StatusCode,
    Extension, Json,
};

use crate::errors::AppError;
use crate::middleware::{extract_bearer_token, CurrentUser};
use crate::models::{
    AuthResponse, GoogleAuthRequest, GoogleLinkResponse, LoginRequest, MessageResponse,
    RefreshResponse, RegisterRequest,
};
use crate::services::AuthService;

pub async fn register(
    State(service): State<AuthService>,
    Json(payload): Json<RegisterRequest>,
) -> Result<(StatusCode, Json<AuthResponse>), AppError> {
    let auth_data = service.register(payload).await?;
    Ok((StatusCode::CREATED, Json(auth_data)))
}

pub async fn login(
    State(service): State<AuthService>,
    Json(payload): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let auth_data = service.login(payload).await?;
    Ok(Json(auth_data))
}

pub async fn logout(
    State(service): State<AuthService>,
    request: Request,
) -> Result<Json<MessageResponse>, AppError> {
    let token = extract_bearer_token(&request)?;
    service.logout(&token).await?;

    Ok(Json(MessageResponse {
        message: "Sessão encerrada com sucesso.".to_string(),
    }))
}

pub async fn refresh(
    State(service): State<AuthService>,
    request: Request,
) -> Result<Json<RefreshResponse>, AppError> {
    let token = extract_bearer_token(&request)?;
    let refresh_data = service.refresh(&token).await?;

    Ok(Json(refresh_data))
}

pub async fn google_auth(
    State(service): State<AuthService>,
    Json(payload): Json<GoogleAuthRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let id_token = service
        .resolve_id_token(
            payload.id_token.as_deref(),
            payload.code.as_deref(),
            payload.code_verifier.as_deref(),
            payload.redirect_uri.as_deref(),
        )
        .await?;

    let auth_data = service
        .authenticate_with_google(&id_token, payload.nonce.as_deref())
        .await?;
    Ok(Json(auth_data))
}

pub async fn google_link(
    State(service): State<AuthService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(payload): Json<GoogleAuthRequest>,
) -> Result<Json<GoogleLinkResponse>, AppError> {
    let id_token = service
        .resolve_id_token(
            payload.id_token.as_deref(),
            payload.code.as_deref(),
            payload.code_verifier.as_deref(),
            payload.redirect_uri.as_deref(),
        )
        .await?;

    let link_res = service
        .link_google_account(
            user.id,
            &id_token,
            payload.nonce.as_deref(),
        )
        .await?;

    Ok(Json(link_res))
}

pub async fn google_unlink(
    State(service): State<AuthService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<MessageResponse>, AppError> {
    service.unlink_google_account(user.id).await?;

    Ok(Json(MessageResponse {
        message: "Conta Google desvinculada com sucesso.".to_string(),
    }))
}
