use chrono::{Duration, Utc};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use validator::Validate;

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

use crate::config::AppConfig;
use crate::errors::AppError;
use crate::models::{
    AuthResponse, GoogleLinkResponse, LoginRequest, RefreshResponse, RegisterRequest,
    UpdateProfileRequest, UserProfileResponse,
};
use crate::repositories::{SessionRepository, UserRepository};
use crate::services::google_oauth::GoogleOAuthVerifier;
use crate::services::presence::PresenceManager;

// Dummy Argon2 hash used for constant-time mitigation when user is not found
const DUMMY_ARGON2_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$eHVzZXJub3Rmb3VuZDEyMw$4+Xp2Xh24w1iG8v0V1u95zT2E5l5s8f6wK8j1e7o3l0";

#[derive(Clone)]
pub struct AuthService {
    user_repo: UserRepository,
    session_repo: SessionRepository,
    config: AppConfig,
    google_verifier: GoogleOAuthVerifier,
    presence_mgr: Option<PresenceManager>,
}

impl AuthService {
    pub fn new(user_repo: UserRepository, session_repo: SessionRepository, config: AppConfig) -> Self {
        let google_verifier = GoogleOAuthVerifier::new(config.clone());
        Self {
            user_repo,
            session_repo,
            config,
            google_verifier,
            presence_mgr: None,
        }
    }

    pub fn with_presence_manager(mut self, presence_mgr: PresenceManager) -> Self {
        self.presence_mgr = Some(presence_mgr);
        self
    }

    pub fn with_google_verifier(mut self, verifier: GoogleOAuthVerifier) -> Self {
        self.google_verifier = verifier;
        self
    }

    pub fn pool(&self) -> &sqlx::PgPool {
        self.user_repo.pool()
    }

    /// Hashes a password using Argon2id with a cryptographically secure random salt
    pub fn hash_password(password: &str) -> Result<String, AppError> {
        let salt = SaltString::generate(&mut OsRng);
        let argon2 = Argon2::default();
        let hash = argon2
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| AppError::InternalError(format!("Falha ao gerar hash de senha: {}", e)))?
            .to_string();
        Ok(hash)
    }

    /// Verifies a password against an Argon2id hash
    pub fn verify_password(password: &str, hash: &str) -> Result<bool, AppError> {
        let parsed_hash = match PasswordHash::new(hash) {
            Ok(h) => h,
            Err(_) => return Ok(false),
        };
        let argon2 = Argon2::default();
        Ok(argon2.verify_password(password.as_bytes(), &parsed_hash).is_ok())
    }

    /// Generates a cryptographically secure raw session token with prefix 'nx_sess_'
    pub fn generate_token() -> String {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let hex_str: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
        format!("nx_sess_{}", hex_str)
    }

    /// Computes the SHA-256 hex digest of a session token
    pub fn hash_token(token: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        let result = hasher.finalize();
        result.iter().map(|b| format!("{:02x}", b)).collect()
    }

    /// Registers a new user transactionally
    pub async fn register(&self, req: RegisterRequest) -> Result<AuthResponse, AppError> {
        req.validate()
            .map_err(|e| AppError::ValidationError(e.to_string()))?;

        let username = req.username.trim().to_string();
        let email = req.email.trim().to_lowercase();
        let display_name = req
            .display_name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| username.clone());

        // Check if username or email already exists
        if self.user_repo.exists_username(&username).await? {
            return Err(AppError::UsernameAlreadyExists);
        }

        if self.user_repo.exists_email(&email).await? {
            return Err(AppError::EmailAlreadyExists);
        }

        // Hash password with Argon2id
        let password_hash = Self::hash_password(&req.password)?;

        // Persist user, credentials, and profile
        let user = self
            .user_repo
            .create_user(&username, &email, &password_hash, &display_name)
            .await?;

        // Create initial session
        let raw_token = Self::generate_token();
        let token_hash = Self::hash_token(&raw_token);
        let expires_at = Utc::now() + Duration::hours(self.config.session_ttl_hours);

        self.session_repo
            .create_session(user.id, &token_hash, expires_at)
            .await?;

        tracing::info!(
            target: "nexus_server::auth",
            user_id = %user.id,
            username = %user.username,
            "User successfully registered"
        );

        Ok(AuthResponse {
            user,
            session_token: raw_token,
            expires_at,
        })
    }

    /// Authenticates a user by email or username, returning non-enumerable error on failure
    pub async fn login(&self, req: LoginRequest) -> Result<AuthResponse, AppError> {
        req.validate()
            .map_err(|e| AppError::ValidationError(e.to_string()))?;

        let login_input = req.login.trim();
        let user_opt = self.user_repo.find_by_login(login_input).await?;

        let (user, creds, _profile) = match user_opt {
            Some(u) => u,
            None => {
                // Execute dummy verification to prevent timing attack enumeration
                let _ = Self::verify_password(&req.password, DUMMY_ARGON2_HASH);
                return Err(AppError::InvalidCredentials);
            }
        };

        let password_hash = match creds.password_hash.as_deref() {
            Some(h) => h,
            None => {
                // Account created via OAuth without a password
                let _ = Self::verify_password(&req.password, DUMMY_ARGON2_HASH);
                return Err(AppError::InvalidCredentials);
            }
        };

        let password_valid = Self::verify_password(&req.password, password_hash)?;
        if !password_valid {
            tracing::warn!(
                target: "nexus_server::auth",
                user_id = %user.id,
                "Failed login attempt: invalid credentials"
            );
            return Err(AppError::InvalidCredentials);
        }

        // Create new session
        let raw_token = Self::generate_token();
        let token_hash = Self::hash_token(&raw_token);
        let expires_at = Utc::now() + Duration::hours(self.config.session_ttl_hours);

        self.session_repo
            .create_session(user.id, &token_hash, expires_at)
            .await?;

        tracing::info!(
            target: "nexus_server::auth",
            user_id = %user.id,
            username = %user.username,
            "User successfully logged in"
        );

        let user_response = self
            .user_repo
            .find_user_profile_by_id(user.id)
            .await?
            .ok_or(AppError::InvalidCredentials)?;

        Ok(AuthResponse {
            user: user_response,
            session_token: raw_token,
            expires_at,
        })
    }

    /// Resolves ID token directly or exchanges (code, code_verifier, redirect_uri) with Google
    pub async fn resolve_id_token(
        &self,
        id_token: Option<&str>,
        code: Option<&str>,
        code_verifier: Option<&str>,
        redirect_uri: Option<&str>,
    ) -> Result<String, AppError> {
        if let Some(token) = id_token {
            let trimmed = token.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }

        if let (Some(c), Some(v), Some(r)) = (code, code_verifier, redirect_uri) {
            let c_trimmed = c.trim();
            let v_trimmed = v.trim();
            let r_trimmed = r.trim();
            if !c_trimmed.is_empty() && !v_trimmed.is_empty() && !r_trimmed.is_empty() {
                return self
                    .google_verifier
                    .exchange_authorization_code(c_trimmed, v_trimmed, r_trimmed)
                    .await;
            }
        }

        Err(AppError::InvalidOAuthToken(
            "Requisição deve conter 'id_token' ou ('code', 'code_verifier', 'redirect_uri').".to_string(),
        ))
    }

    /// Authenticates or registers via Google Sign-In with an OIDC ID token
    pub async fn authenticate_with_google(
        &self,
        id_token: &str,
        nonce: Option<&str>,
    ) -> Result<AuthResponse, AppError> {
        let claims = self.google_verifier.verify_id_token(id_token, nonce).await?;

        let email = claims.email.trim().to_lowercase();
        let sub = claims.sub.trim().to_string();

        // 1. Check if this Google account is already linked to a Nexus user
        if let Some(oauth_acc) = self.user_repo.find_oauth_account("google", &sub).await? {
            let profile = self
                .user_repo
                .find_user_profile_by_id(oauth_acc.user_id)
                .await?
                .ok_or(AppError::InvalidToken)?;

            // Issue session for existing linked user
            let raw_token = Self::generate_token();
            let token_hash = Self::hash_token(&raw_token);
            let expires_at = Utc::now() + Duration::hours(self.config.session_ttl_hours);

            self.session_repo
                .create_session(profile.id, &token_hash, expires_at)
                .await?;

            tracing::info!(
                target: "nexus_server::auth",
                user_id = %profile.id,
                username = %profile.username,
                provider = "google",
                "Google Sign-In successful for existing linked user"
            );

            return Ok(AuthResponse {
                user: profile,
                session_token: raw_token,
                expires_at,
            });
        }

        // 2. Not linked: Check if an account already exists with this email
        // IMPORTANT SECURITY CONSTRAINT: Never auto-merge accounts by email coincidence!
        if self.user_repo.exists_email(&email).await? {
            tracing::warn!(
                target: "nexus_server::auth",
                email = %email,
                "Google Sign-In rejected: email already registered under another account"
            );
            return Err(AppError::AccountConflictEmailExists);
        }

        // 3. Brand new user registration via Google
        let mut username = sanitize_username(claims.name.as_deref(), &email);
        if self.user_repo.exists_username(&username).await? {
            // Append random 4-digit suffix to resolve collisions
            let mut rand_bytes = [0u8; 2];
            OsRng.fill_bytes(&mut rand_bytes);
            let suffix = ((rand_bytes[0] as u32) << 8 | (rand_bytes[1] as u32)) % 9000 + 1000;
            username = format!("{}_{}", username, suffix);
        }

        let display_name = claims.name.unwrap_or_else(|| username.clone());
        let avatar_url = claims.picture.as_deref();

        let profile = self
            .user_repo
            .create_oauth_user(
                &username,
                &email,
                &display_name,
                avatar_url,
                "google",
                &sub,
            )
            .await?;

        // Issue initial session
        let raw_token = Self::generate_token();
        let token_hash = Self::hash_token(&raw_token);
        let expires_at = Utc::now() + Duration::hours(self.config.session_ttl_hours);

        self.session_repo
            .create_session(profile.id, &token_hash, expires_at)
            .await?;

        tracing::info!(
            target: "nexus_server::auth",
            user_id = %profile.id,
            username = %profile.username,
            provider = "google",
            "Google Sign-In created new user"
        );

        Ok(AuthResponse {
            user: profile,
            session_token: raw_token,
            expires_at,
        })
    }

    /// Links a Google account to an already authenticated Nexus user
    pub async fn link_google_account(
        &self,
        user_id: Uuid,
        id_token: &str,
        nonce: Option<&str>,
    ) -> Result<GoogleLinkResponse, AppError> {
        let claims = self.google_verifier.verify_id_token(id_token, nonce).await?;
        let sub = claims.sub.trim().to_string();

        if let Some(existing) = self.user_repo.find_oauth_account("google", &sub).await? {
            if existing.user_id != user_id {
                return Err(AppError::OAuthAccountAlreadyLinked);
            }
            return Ok(GoogleLinkResponse {
                message: "Esta conta Google já está vinculada ao seu usuário.".to_string(),
                provider: "google".to_string(),
                provider_subject: sub,
            });
        }

        // Prevent duplicate links if user already has a Google account associated
        if self.user_repo.has_oauth_account(user_id, "google").await? {
            return Err(AppError::BadRequest(
                "Você já possui uma conta Google vinculada a este perfil. Desvincule-a primeiro para associar outra.".to_string(),
            ));
        }

        self.user_repo.link_oauth_account(user_id, "google", &sub).await?;

        tracing::info!(
            target: "nexus_server::auth",
            user_id = %user_id,
            provider = "google",
            "Google account linked successfully"
        );

        Ok(GoogleLinkResponse {
            message: "Conta Google vinculada com sucesso ao seu perfil NEXUS.".to_string(),
            provider: "google".to_string(),
            provider_subject: sub,
        })
    }

    /// Unlinks Google account from an authenticated user (only if user has a password)
    pub async fn unlink_google_account(&self, user_id: Uuid) -> Result<(), AppError> {
        let has_pw = self.user_repo.has_password(user_id).await?;
        if !has_pw {
            return Err(AppError::CannotUnlinkLastAuthMethod);
        }

        let unlinked = self.user_repo.unlink_oauth_account(user_id, "google").await?;
        if !unlinked {
            return Err(AppError::BadRequest(
                "Nenhuma conta Google vinculada para desvincular.".to_string(),
            ));
        }

        tracing::info!(
            target: "nexus_server::auth",
            user_id = %user_id,
            provider = "google",
            "Google account unlinked"
        );

        Ok(())
    }

    /// Logs out by revoking the given session token and immediately disconnecting its WebSocket connections
    pub async fn logout(&self, raw_token: &str) -> Result<(), AppError> {
        let token_hash = Self::hash_token(raw_token);
        let revoked_opt = self.session_repo.revoke_session_returning(&token_hash).await?;
        if let Some((session_id, user_id)) = revoked_opt {
            if let Some(ref pm) = self.presence_mgr {
                pm.revoke_session_connections(user_id, session_id).await;
            }
        } else {
            tracing::debug!(target: "nexus_server::auth", "Session not found or already revoked");
        }
        Ok(())
    }

    /// Refreshes a session by revoking the old token and issuing a new one
    pub async fn refresh(&self, raw_token: &str) -> Result<RefreshResponse, AppError> {
        let old_token_hash = Self::hash_token(raw_token);
        let session = self
            .session_repo
            .find_active_by_token_hash(&old_token_hash)
            .await?
            .ok_or(AppError::InvalidToken)?;

        // Revoke old session
        self.session_repo.revoke_session(&old_token_hash).await?;
        if let Some(ref pm) = self.presence_mgr {
            pm.revoke_session_connections(session.user_id, session.id)
                .await;
        }

        // Issue new session
        let new_token = Self::generate_token();
        let new_token_hash = Self::hash_token(&new_token);
        let expires_at = Utc::now() + Duration::hours(self.config.session_ttl_hours);

        self.session_repo
            .create_session(session.user_id, &new_token_hash, expires_at)
            .await?;

        tracing::info!(
            target: "nexus_server::auth",
            user_id = %session.user_id,
            "Session successfully refreshed"
        );

        Ok(RefreshResponse {
            session_token: new_token,
            expires_at,
        })
    }

    /// Validates an active session token and returns both the session ID and current user profile
    pub async fn validate_token_and_get_session(
        &self,
        raw_token: &str,
    ) -> Result<(Uuid, UserProfileResponse), AppError> {
        let token_hash = Self::hash_token(raw_token);
        let session = self
            .session_repo
            .find_active_by_token_hash(&token_hash)
            .await?
            .ok_or(AppError::InvalidToken)?;

        let user_profile = self
            .user_repo
            .find_user_profile_by_id(session.user_id)
            .await?
            .ok_or(AppError::InvalidToken)?;

        Ok((session.id, user_profile))
    }

    /// Validates an active session token and returns the current user profile
    pub async fn validate_token_and_get_user(
        &self,
        raw_token: &str,
    ) -> Result<UserProfileResponse, AppError> {
        let (_session_id, user_profile) = self.validate_token_and_get_session(raw_token).await?;
        Ok(user_profile)
    }

    /// Checks whether a session ID is still active (not revoked and not expired)
    pub async fn is_session_active(&self, session_id: Uuid) -> bool {
        self.session_repo
            .is_session_active(session_id)
            .await
            .unwrap_or(false)
    }

    /// Retrieves user profile by user_id
    pub async fn get_user_profile(&self, user_id: Uuid) -> Result<UserProfileResponse, AppError> {
        self.user_repo
            .find_user_profile_by_id(user_id)
            .await?
            .ok_or(AppError::NotFound("Perfil do usuário não encontrado.".into()))
    }

    /// Atomically updates editable fields of user profile
    pub async fn update_profile(
        &self,
        user_id: Uuid,
        req: UpdateProfileRequest,
    ) -> Result<UserProfileResponse, AppError> {
        let display_name_trimmed = req.display_name.as_deref().map(|s| s.trim());
        if let Some(dn) = display_name_trimmed {
            if dn.is_empty() {
                return Err(AppError::ValidationError(
                    "O nome de exibição não pode ficar vazio.".to_string(),
                ));
            }
        }

        let updated = self
            .user_repo
            .update_user_profile(
                user_id,
                req.username.as_deref(),
                display_name_trimmed,
                req.bio.as_deref().map(|s| s.trim()),
                req.custom_status.as_deref().map(|s| s.trim()),
            )
            .await?;

        tracing::info!(
            target: "nexus_server::auth",
            user_id = %user_id,
            username = %updated.username,
            "User profile successfully updated"
        );

        Ok(updated)
    }
}

fn sanitize_username(name: Option<&str>, email: &str) -> String {
    let source = name.unwrap_or(email);
    let mut clean: String = source
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();

    if clean.len() < 3 {
        let email_prefix: String = email
            .split('@')
            .next()
            .unwrap_or("user")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        clean = format!("nx_{}", email_prefix);
    }

    if clean.len() > 24 {
        clean.truncate(24);
    }

    if clean.len() < 3 {
        clean = "nexus_user".to_string();
    }

    clean.to_lowercase()
}
