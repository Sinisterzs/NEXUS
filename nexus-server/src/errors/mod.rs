use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Credenciais inválidas. Verifique seu e-mail/usuário e senha.")]
    InvalidCredentials,

    #[error("Nome de usuário já está em uso.")]
    UsernameAlreadyExists,

    #[error("E-mail já está cadastrado.")]
    EmailAlreadyExists,

    #[error("Dados de entrada inválidos: {0}")]
    ValidationError(String),

    #[error("Token de sessão ausente, inválido ou expirado.")]
    InvalidToken,

    #[error("Sessão revogada.")]
    SessionRevoked,

    #[error("Limite de requisições excedido. Tente novamente mais tarde.")]
    RateLimited,

    #[error("Token OAuth inválido ou expirado: {0}")]
    InvalidOAuthToken(String),

    #[error("Esta conta de provedor já está vinculada a outro usuário.")]
    OAuthAccountAlreadyLinked,

    #[error("Já existe uma conta cadastrada com este e-mail. Para vincular, faça login com sua senha.")]
    AccountConflictEmailExists,

    #[error("Este e-mail já está associado a uma conta que não pode ser acessada com este login Google. Contate o suporte.")]
    GoogleIdentityNotLinked,

    #[error("O e-mail da conta externa não foi verificado pelo provedor.")]
    OAuthEmailNotVerified,

    #[error("Não é possível desvincular a única forma de autenticação da conta. Defina uma senha antes.")]
    CannotUnlinkLastAuthMethod,

    #[error("Link ou código de recuperação inválido ou expirado. Solicite uma nova recuperação de senha.")]
    ResetTokenInvalidOrExpired,

    #[error("{0}")]
    ResetPasswordWeak(String),

    #[error("Recurso não encontrado: {0}")]
    NotFound(String),

    #[error("{0}")]
    BadRequest(String),

    #[error("Acesso negado: {0}")]
    Forbidden(String),

    #[error("Conflito: {0}")]
    Conflict(String),

    #[error("Erro de persistência de dados.")]
    DatabaseError(#[from] sqlx::Error),

    #[error("Erro interno do servidor.")]
    InternalError(String),
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: ErrorDetail,
}

impl AppError {
    pub fn error_code(&self) -> &'static str {
        match self {
            AppError::InvalidCredentials => "INVALID_CREDENTIALS",
            AppError::UsernameAlreadyExists => "USERNAME_ALREADY_EXISTS",
            AppError::EmailAlreadyExists => "EMAIL_ALREADY_EXISTS",
            AppError::ValidationError(_) => "VALIDATION_ERROR",
            AppError::InvalidToken => "INVALID_TOKEN",
            AppError::SessionRevoked => "SESSION_REVOKED",
            AppError::RateLimited => "RATE_LIMITED",
            AppError::InvalidOAuthToken(_) => "INVALID_OAUTH_TOKEN",
            AppError::OAuthAccountAlreadyLinked => "OAUTH_ACCOUNT_ALREADY_LINKED",
            AppError::AccountConflictEmailExists => "ACCOUNT_CONFLICT_EMAIL_EXISTS",
            AppError::GoogleIdentityNotLinked => "GOOGLE_IDENTITY_NOT_LINKED",
            AppError::OAuthEmailNotVerified => "OAUTH_EMAIL_NOT_VERIFIED",
            AppError::CannotUnlinkLastAuthMethod => "CANNOT_UNLINK_LAST_AUTH_METHOD",
            AppError::ResetTokenInvalidOrExpired => "RESET_TOKEN_INVALID_OR_EXPIRED",
            AppError::ResetPasswordWeak(_) => "RESET_PASSWORD_WEAK",
            AppError::NotFound(_) => "NOT_FOUND",
            AppError::BadRequest(_) => "BAD_REQUEST",
            AppError::Forbidden(_) => "FORBIDDEN",
            AppError::Conflict(_) => "CONFLICT",
            AppError::DatabaseError(_) => "DATABASE_ERROR",
            AppError::InternalError(_) => "INTERNAL_SERVER_ERROR",
        }
    }

    pub fn status_code(&self) -> StatusCode {
        match self {
            AppError::InvalidCredentials => StatusCode::UNAUTHORIZED,
            AppError::UsernameAlreadyExists => StatusCode::CONFLICT,
            AppError::EmailAlreadyExists => StatusCode::CONFLICT,
            AppError::ValidationError(_) => StatusCode::BAD_REQUEST,
            AppError::InvalidToken | AppError::SessionRevoked => StatusCode::UNAUTHORIZED,
            AppError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            AppError::InvalidOAuthToken(_) => StatusCode::UNAUTHORIZED,
            AppError::OAuthAccountAlreadyLinked => StatusCode::CONFLICT,
            AppError::AccountConflictEmailExists | AppError::GoogleIdentityNotLinked => StatusCode::CONFLICT,
            AppError::OAuthEmailNotVerified => StatusCode::BAD_REQUEST,
            AppError::CannotUnlinkLastAuthMethod => StatusCode::BAD_REQUEST,
            AppError::ResetTokenInvalidOrExpired => StatusCode::BAD_REQUEST,
            AppError::ResetPasswordWeak(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::DatabaseError(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::InternalError(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let code = self.error_code().to_string();

        // Never expose internal database messages to public API responses
        let message = match &self {
            AppError::DatabaseError(err) => {
                tracing::error!(target: "nexus_server::db", error = %err, "Database error encountered");
                "Ocorreu um erro no processamento do banco de dados.".to_string()
            }
            AppError::InternalError(err) => {
                tracing::error!(target: "nexus_server", error = %err, "Internal server error");
                "Ocorreu um erro interno no servidor.".to_string()
            }
            other => other.to_string(),
        };

        let body = Json(ErrorResponse {
            error: ErrorDetail { code, message },
        });

        (status, body).into_response()
    }
}

/// Error for a Google sign-in whose validated (google, sub) has no link, while the
/// e-mail already belongs to another account. Never links automatically.
/// - owner has a password: the user can prove ownership by logging in with it.
/// - owner has no password: telling the user to "use your password" would be wrong
///   (Google-only account with a missing/different identity link); recovery needs
///   a proof-of-ownership procedure, not a password.
pub fn email_conflict_error(owner_has_password: bool) -> AppError {
    if owner_has_password {
        AppError::AccountConflictEmailExists
    } else {
        AppError::GoogleIdentityNotLinked
    }
}
