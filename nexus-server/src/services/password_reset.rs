//! Password recovery by e-mail (v0.2.5).
//!
//! Flow:
//! 1. `forgot_password`  — uniform 200 response; per-IP and per-e-mail throttling; if the
//!    normalized e-mail belongs to an account (password or Google-only), a 256-bit CSPRNG token
//!    is issued (only its SHA-256 is stored), valid for 15 minutes, replacing pending tokens.
//!    Lookup, persistence and delivery run in a background task so response latency does not
//!    depend on whether the account exists.
//! 2. `verify_token`     — read-only validity check (does not consume).
//! 3. `reset_password`   — policy check first, then atomic single-use consumption, Argon2id
//!    hash update, invalidation of other reset tokens and revocation of ALL sessions.
//!
//! All queries use runtime `sqlx::query*` functions (no compile-time macros), so this module
//! compiles without a live database.
//! Never logged: raw tokens, e-mail addresses, passwords.

use std::net::IpAddr;

use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppError;
use crate::services::auth::AuthService;
use crate::services::email::{render_password_reset_email, EmailService};
use crate::services::password_reset_policy::{
    generate_reset_token, hash_reset_token, normalize_email, normalize_reset_token,
    validate_password, ForgotPasswordLimiter, ForgotThrottle, RESET_TOKEN_TTL_MINUTES,
};
use crate::services::presence::PresenceManager;

#[derive(Clone)]
pub struct PasswordResetService {
    pool: PgPool,
    email: EmailService,
    limiter: ForgotPasswordLimiter,
    presence_mgr: Option<PresenceManager>,
    trust_proxy_headers: bool,
}

impl PasswordResetService {
    pub fn new(pool: PgPool, email: EmailService) -> Self {
        Self {
            pool,
            email,
            limiter: ForgotPasswordLimiter::default(),
            presence_mgr: None,
            trust_proxy_headers: false,
        }
    }

    pub fn with_presence_manager(mut self, presence_mgr: PresenceManager) -> Self {
        self.presence_mgr = Some(presence_mgr);
        self
    }

    pub fn with_limiter(mut self, limiter: ForgotPasswordLimiter) -> Self {
        self.limiter = limiter;
        self
    }

    pub fn with_trust_proxy_headers(mut self, trust: bool) -> Self {
        self.trust_proxy_headers = trust;
        self
    }

    pub fn trust_proxy_headers(&self) -> bool {
        self.trust_proxy_headers
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub fn email_service(&self) -> &EmailService {
        &self.email
    }

    /// Fast, synchronous admission step of `POST /password/forgot`.
    /// - `Err(RateLimited)` when the client IP exceeded its budget.
    /// - `Ok(None)` when nothing must be done (malformed address or e-mail budget exhausted).
    /// - `Ok(Some(email))` with the normalized address when issuance should proceed.
    pub fn admit_forgot_request(
        &self,
        raw_email: &str,
        client_ip: IpAddr,
    ) -> Result<Option<String>, AppError> {
        let normalized = normalize_email(raw_email);
        match self
            .limiter
            .evaluate(&client_ip.to_string(), normalized.as_deref())
        {
            ForgotThrottle::RejectIp => {
                tracing::warn!(
                    target: "nexus_server::password_reset",
                    ip = %client_ip,
                    "Forgot-password rate limit exceeded for IP"
                );
                Err(AppError::RateLimited)
            }
            ForgotThrottle::SilentlyDropEmail => {
                tracing::warn!(
                    target: "nexus_server::password_reset",
                    ip = %client_ip,
                    "Forgot-password per-address budget exhausted; request dropped silently"
                );
                Ok(None)
            }
            ForgotThrottle::Allow => Ok(normalized),
        }
    }

    /// Handler entry point: admission + background issuance. The caller always answers with
    /// the uniform message when this returns `Ok(())`.
    pub async fn forgot_password(&self, raw_email: &str, client_ip: IpAddr) -> Result<(), AppError> {
        if let Some(email) = self.admit_forgot_request(raw_email, client_ip)? {
            let svc = self.clone();
            tokio::spawn(async move {
                if let Err(err) = svc.issue_reset_for_email(&email, Some(client_ip)).await {
                    log_background_error(&err);
                }
            });
        }
        Ok(())
    }

    /// Issues a token and e-mails it when `normalized_email` belongs to an account.
    /// Returns whether a token was issued (internal use / tests only — never exposed over HTTP).
    pub async fn issue_reset_for_email(
        &self,
        normalized_email: &str,
        client_ip: Option<IpAddr>,
    ) -> Result<bool, AppError> {
        let mut tx = self.pool.begin().await?;

        // Row lock serializes concurrent requests for the same account, guaranteeing at most
        // one pending token per user.
        let user_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM user_credentials WHERE email = $1 FOR UPDATE",
        )
        .bind(normalized_email)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(user_id) = user_id else {
            tx.rollback().await?;
            tracing::debug!(
                target: "nexus_server::password_reset",
                "Forgot-password request for an address without account (uniform response sent)"
            );
            return Ok(false);
        };

        // Invalidate any previous pending token of this user.
        sqlx::query("DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;

        let raw_token = generate_reset_token();
        let token_hash = hash_reset_token(&raw_token);
        let ip_str = client_ip.map(|ip| ip.to_string());

        sqlx::query(
            "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, request_ip) \
             VALUES ($1, $2, NOW() + make_interval(mins => $3), $4)",
        )
        .bind(user_id)
        .bind(&token_hash)
        .bind(RESET_TOKEN_TTL_MINUTES as i32)
        .bind(ip_str.as_deref())
        .execute(&mut *tx)
        .await?;

        // Housekeeping: purge long-expired / long-used rows.
        sqlx::query(
            "DELETE FROM password_reset_tokens \
             WHERE expires_at < NOW() - INTERVAL '1 day'",
        )
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        tracing::info!(
            target: "nexus_server::password_reset",
            user_id = %user_id,
            "Password reset token issued"
        );

        let message = render_password_reset_email(
            normalized_email,
            &raw_token,
            &self.email.config().reset_url_base,
            RESET_TOKEN_TTL_MINUTES,
        );
        drop(raw_token);

        if let Err(err) = self.email.send(&message).await {
            tracing::error!(
                target: "nexus_server::password_reset",
                user_id = %user_id,
                provider = self.email.provider().as_str(),
                error = %err,
                "Failed to deliver password reset e-mail"
            );
        }

        Ok(true)
    }

    async fn token_hash_is_active(&self, token_hash: &str) -> Result<bool, AppError> {
        let active: bool = sqlx::query_scalar(
            "SELECT EXISTS (\
                SELECT 1 FROM password_reset_tokens \
                WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()\
             )",
        )
        .bind(token_hash)
        .fetch_one(&self.pool)
        .await?;
        Ok(active)
    }

    /// `POST /password/verify`: checks validity without consuming the token.
    pub async fn verify_token(&self, raw_token: &str) -> Result<(), AppError> {
        let token = normalize_reset_token(raw_token).ok_or(AppError::ResetTokenInvalidOrExpired)?;
        if self.token_hash_is_active(&hash_reset_token(&token)).await? {
            Ok(())
        } else {
            Err(AppError::ResetTokenInvalidOrExpired)
        }
    }

    /// `POST /password/reset`: validates the password policy BEFORE touching the token, then
    /// atomically consumes the token, sets the new Argon2id hash, invalidates the user's other
    /// reset tokens and revokes every session. Returns the affected user id.
    pub async fn reset_password(&self, raw_token: &str, new_password: &str) -> Result<Uuid, AppError> {
        validate_password(new_password)
            .map_err(|e| AppError::ResetPasswordWeak(e.message().to_string()))?;

        let token = normalize_reset_token(raw_token).ok_or(AppError::ResetTokenInvalidOrExpired)?;
        let token_hash = hash_reset_token(&token);

        // Cheap non-consuming pre-check so invalid tokens never cost an Argon2 computation.
        // The authoritative single-use check is the atomic UPDATE below.
        if !self.token_hash_is_active(&token_hash).await? {
            return Err(AppError::ResetTokenInvalidOrExpired);
        }

        let password = new_password.to_string();
        let password_hash = tokio::task::spawn_blocking(move || AuthService::hash_password(&password))
            .await
            .map_err(|e| AppError::InternalError(format!("Falha na tarefa de hash de senha: {}", e)))??;

        let mut tx = self.pool.begin().await?;

        let user_id: Option<Uuid> = sqlx::query_scalar(
            "UPDATE password_reset_tokens SET used_at = NOW() \
             WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() \
             RETURNING user_id",
        )
        .bind(&token_hash)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(user_id) = user_id else {
            tx.rollback().await?;
            return Err(AppError::ResetTokenInvalidOrExpired);
        };

        // Sets (or replaces) the local password. For Google-only accounts this adds a local
        // password after proof of e-mail ownership; user_oauth_accounts is never touched.
        let updated = sqlx::query(
            "UPDATE user_credentials SET password_hash = $1, updated_at = NOW() WHERE user_id = $2",
        )
        .bind(&password_hash)
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();

        if updated != 1 {
            tx.rollback().await?;
            return Err(AppError::ResetTokenInvalidOrExpired);
        }

        sqlx::query("DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;

        let revoked_sessions: Vec<Uuid> =
            sqlx::query_scalar("DELETE FROM sessions WHERE user_id = $1 RETURNING id")
                .bind(user_id)
                .fetch_all(&mut *tx)
                .await?;

        tx.commit().await?;

        if let Some(pm) = &self.presence_mgr {
            for session_id in &revoked_sessions {
                pm.revoke_session_connections(user_id, *session_id).await;
            }
        }

        tracing::info!(
            target: "nexus_server::password_reset",
            user_id = %user_id,
            sessions_revoked = revoked_sessions.len(),
            "Password reset completed; all sessions revoked"
        );

        Ok(user_id)
    }
}

fn log_background_error(err: &AppError) {
    match err {
        AppError::DatabaseError(db) => tracing::error!(
            target: "nexus_server::password_reset",
            error = %db,
            "Password reset issuance failed (database)"
        ),
        other => tracing::error!(
            target: "nexus_server::password_reset",
            code = other.error_code(),
            "Password reset issuance failed"
        ),
    }
}
