use axum::{
    extract::{Request, State},
    http::header::AUTHORIZATION,
    middleware::Next,
    response::Response,
};

use crate::errors::AppError;
use crate::models::UserProfileResponse;
use crate::services::AuthService;

#[derive(Clone, Debug)]
pub struct CurrentUser(pub UserProfileResponse);

#[derive(Clone, Debug)]
pub struct RawSessionToken(pub String);

pub fn extract_bearer_token(req: &Request) -> Result<String, AppError> {
    let auth_header = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .ok_or(AppError::InvalidToken)?;

    if !auth_header.starts_with("Bearer ") {
        return Err(AppError::InvalidToken);
    }

    let token = auth_header.trim_start_matches("Bearer ").trim();
    if token.is_empty() {
        return Err(AppError::InvalidToken);
    }

    Ok(token.to_string())
}

pub async fn auth_middleware(
    State(auth_service): State<AuthService>,
    mut request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let token = extract_bearer_token(&request)?;
    let user_profile = auth_service.validate_token_and_get_user(&token).await?;

    request.extensions_mut().insert(user_profile.clone());
    request.extensions_mut().insert(CurrentUser(user_profile));
    request.extensions_mut().insert(RawSessionToken(token));

    Ok(next.run(request).await)
}
