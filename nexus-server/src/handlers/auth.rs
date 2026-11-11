use axum::{
    extract::{rejection::JsonRejection, FromRequest, Request, State},
    http::StatusCode,
    Extension, Json,
};

use crate::errors::AppError;
use crate::middleware::rate_limit::extract_client_ip;
use crate::middleware::{extract_bearer_token, CurrentUser};
use crate::models::{
    AuthResponse, ForgotPasswordRequest, GoogleAuthRequest, GoogleLinkResponse, LoginRequest,
    MessageResponse, RefreshResponse, RegisterRequest, ResetPasswordRequest,
    VerifyResetTokenRequest, VerifyResetTokenResponse,
};
use crate::services::password_reset_policy::{
    FORGOT_PASSWORD_GENERIC_MESSAGE, RESET_PASSWORD_SUCCESS_MESSAGE,
};
use crate::services::{AuthService, PasswordResetService};

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

// ==========================================
// Password recovery (v0.2.5)
// ==========================================

fn invalid_body() -> AppError {
    AppError::ValidationError("Corpo da requisição inválido.".to_string())
}

/// `POST /v1/auth/password/forgot` — always answers 200 with the uniform message
/// (except HTTP 429 when the client IP exceeded its budget).
pub async fn forgot_password(
    State(service): State<PasswordResetService>,
    request: Request,
) -> Result<Json<MessageResponse>, AppError> {
    let client_ip = extract_client_ip(&request, service.trust_proxy_headers());
    let Json(payload) = Json::<ForgotPasswordRequest>::from_request(request, &())
        .await
        .map_err(|_| invalid_body())?;

    service.forgot_password(&payload.email, client_ip).await?;

    Ok(Json(MessageResponse {
        message: FORGOT_PASSWORD_GENERIC_MESSAGE.to_string(),
    }))
}

/// `POST /v1/auth/password/verify` — non-consuming validity check.
pub async fn verify_reset_token(
    State(service): State<PasswordResetService>,
    payload: Result<Json<VerifyResetTokenRequest>, JsonRejection>,
) -> Result<Json<VerifyResetTokenResponse>, AppError> {
    let Json(payload) = payload.map_err(|_| invalid_body())?;
    service.verify_token(&payload.token).await?;
    Ok(Json(VerifyResetTokenResponse { valid: true }))
}

/// `POST /v1/auth/password/reset` — single-use token consumption + password update + session revocation.
pub async fn reset_password(
    State(service): State<PasswordResetService>,
    payload: Result<Json<ResetPasswordRequest>, JsonRejection>,
) -> Result<Json<MessageResponse>, AppError> {
    let Json(payload) = payload.map_err(|_| invalid_body())?;
    service
        .reset_password(&payload.token, &payload.new_password)
        .await?;
    Ok(Json(MessageResponse {
        message: RESET_PASSWORD_SUCCESS_MESSAGE.to_string(),
    }))
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
