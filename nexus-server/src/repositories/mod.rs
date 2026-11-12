pub mod friends;
pub use friends::FriendRepository;
pub mod dm;
pub use dm::DmRepository;
pub mod communities;
pub use communities::CommunityRepository;

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::{
    Session, User, UserCredentials, UserOAuthAccount, UserProfile, UserProfileResponse,
};

#[derive(Clone)]
pub struct UserRepository {
    pool: PgPool,
}

impl UserRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn exists_username(&self, username: &str) -> Result<bool, AppError> {
        let count: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) FROM users WHERE LOWER(username) = LOWER($1)"#,
            username
        )
        .fetch_one(&self.pool)
        .await?
        .unwrap_or(0);

        Ok(count > 0)
    }

    pub async fn exists_email(&self, email: &str) -> Result<bool, AppError> {
        let count: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) FROM user_credentials WHERE email = $1"#,
            email
        )
        .fetch_one(&self.pool)
        .await?
        .unwrap_or(0);

        Ok(count > 0)
    }

    /// Returns the owner of an e-mail (read-only; never used to link identities).
    pub async fn find_user_id_by_email(&self, email: &str) -> Result<Option<Uuid>, AppError> {
        let id = sqlx::query_scalar::<_, Uuid>("SELECT user_id FROM user_credentials WHERE email = $1")
            .bind(email)
            .fetch_optional(&self.pool)
            .await?;
        Ok(id)
    }

    pub async fn create_user(
        &self,
        username: &str,
        email: &str,
        password_hash: &str,
        display_name: &str,
    ) -> Result<UserProfileResponse, AppError> {
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        // 1. Insert into users
        let user = sqlx::query_as!(
            User,
            r#"
            INSERT INTO users (username)
            VALUES ($1)
            RETURNING id, username, created_at, updated_at
            "#,
            username
        )
        .fetch_one(&mut *tx)
        .await?;

        // 2. Insert into user_credentials
        sqlx::query_as!(
            UserCredentials,
            r#"
            INSERT INTO user_credentials (user_id, email, password_hash)
            VALUES ($1, $2, $3)
            RETURNING user_id, email, password_hash, updated_at
            "#,
            user.id,
            email,
            password_hash as _
        )
        .fetch_one(&mut *tx)
        .await?;

        // 3. Insert into user_profiles
        let profile = sqlx::query_as!(
            UserProfile,
            r#"
            INSERT INTO user_profiles (user_id, display_name, status)
            VALUES ($1, $2, 'online')
            RETURNING user_id, display_name, avatar_url, bio, status
            "#,
            user.id,
            display_name
        )
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;

        Ok(UserProfileResponse {
            id: user.id,
            username: user.username,
            email: email.to_string(),
            display_name: profile.display_name,
            avatar_url: profile.avatar_url,
            bio: profile.bio,
            status: profile.status,
            custom_status: None,
            activity: None,
            has_password: true,
            has_google: false,
            created_at: user.created_at,
        })
    }

    pub async fn create_oauth_user(
        &self,
        username: &str,
        email: &str,
        display_name: &str,
        avatar_url: Option<&str>,
        provider: &str,
        provider_subject: &str,
    ) -> Result<UserProfileResponse, AppError> {
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        // 1. Insert user
        let user = sqlx::query_as!(
            User,
            r#"
            INSERT INTO users (username)
            VALUES ($1)
            RETURNING id, username, created_at, updated_at
            "#,
            username
        )
        .fetch_one(&mut *tx)
        .await?;

        // 2. Insert credentials with NULL password_hash
        sqlx::query_as!(
            UserCredentials,
            r#"
            INSERT INTO user_credentials (user_id, email, password_hash)
            VALUES ($1, $2, NULL)
            RETURNING user_id, email, password_hash, updated_at
            "#,
            user.id,
            email
        )
        .fetch_one(&mut *tx)
        .await?;

        // 3. Insert profile
        let profile = sqlx::query_as!(
            UserProfile,
            r#"
            INSERT INTO user_profiles (user_id, display_name, avatar_url, status)
            VALUES ($1, $2, $3, 'online')
            RETURNING user_id, display_name, avatar_url, bio, status
            "#,
            user.id,
            display_name,
            avatar_url
        )
        .fetch_one(&mut *tx)
        .await?;

        // 4. Insert oauth link
        sqlx::query_as!(
            UserOAuthAccount,
            r#"
            INSERT INTO user_oauth_accounts (user_id, provider, provider_subject)
            VALUES ($1, $2, $3)
            RETURNING id, user_id, provider, provider_subject, created_at, updated_at
            "#,
            user.id,
            provider,
            provider_subject
        )
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;

        Ok(UserProfileResponse {
            id: user.id,
            username: user.username,
            email: email.to_string(),
            display_name: profile.display_name,
            avatar_url: profile.avatar_url,
            bio: profile.bio,
            status: profile.status,
            custom_status: None,
            activity: None,
            has_password: false,
            has_google: true,
            created_at: user.created_at,
        })
    }

    pub async fn find_oauth_account(
        &self,
        provider: &str,
        provider_subject: &str,
    ) -> Result<Option<UserOAuthAccount>, AppError> {
        let account = sqlx::query_as!(
            UserOAuthAccount,
            r#"
            SELECT id, user_id, provider, provider_subject, created_at, updated_at
            FROM user_oauth_accounts
            WHERE provider = $1 AND provider_subject = $2
            "#,
            provider,
            provider_subject
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(account)
    }

    pub async fn link_oauth_account(
        &self,
        user_id: Uuid,
        provider: &str,
        provider_subject: &str,
    ) -> Result<(), AppError> {
        sqlx::query!(
            r#"
            INSERT INTO user_oauth_accounts (user_id, provider, provider_subject)
            VALUES ($1, $2, $3)
            "#,
            user_id,
            provider,
            provider_subject
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn unlink_oauth_account(
        &self,
        user_id: Uuid,
        provider: &str,
    ) -> Result<bool, AppError> {
        let res = sqlx::query!(
            r#"
            DELETE FROM user_oauth_accounts
            WHERE user_id = $1 AND provider = $2
            "#,
            user_id,
            provider
        )
        .execute(&self.pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    pub async fn has_password(&self, user_id: Uuid) -> Result<bool, AppError> {
        let count = sqlx::query_scalar!(
            r#"SELECT COUNT(*) FROM user_credentials WHERE user_id = $1 AND password_hash IS NOT NULL"#,
            user_id
        )
        .fetch_one(&self.pool)
        .await?
        .unwrap_or(0);

        Ok(count > 0)
    }

    pub async fn has_oauth_account(&self, user_id: Uuid, provider: &str) -> Result<bool, AppError> {
        let count = sqlx::query_scalar!(
            r#"SELECT COUNT(*) FROM user_oauth_accounts WHERE user_id = $1 AND provider = $2"#,
            user_id,
            provider
        )
        .fetch_one(&self.pool)
        .await?
        .unwrap_or(0);

        Ok(count > 0)
    }

    pub async fn find_by_login(
        &self,
        login: &str,
    ) -> Result<Option<(User, UserCredentials, UserProfile)>, AppError> {
        let normalized = login.trim().to_lowercase();

        let row = sqlx::query!(
            r#"
            SELECT 
                u.id as user_id, u.username, u.created_at as user_created_at, u.updated_at as user_updated_at,
                c.email, c.password_hash, c.updated_at as cred_updated_at,
                p.display_name, p.avatar_url, p.bio, p.status
            FROM users u
            JOIN user_credentials c ON u.id = c.user_id
            JOIN user_profiles p ON u.id = p.user_id
            WHERE LOWER(u.username) = $1 OR c.email = $1
            "#,
            normalized
        )
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(r) => {
                let user = User {
                    id: r.user_id,
                    username: r.username,
                    created_at: r.user_created_at,
                    updated_at: r.user_updated_at,
                };
                let creds = UserCredentials {
                    user_id: r.user_id,
                    email: r.email,
                    password_hash: r.password_hash,
                    updated_at: r.cred_updated_at,
                };
                let profile = UserProfile {
                    user_id: r.user_id,
                    display_name: r.display_name,
                    avatar_url: r.avatar_url,
                    bio: r.bio,
                    status: r.status,
                };
                Ok(Some((user, creds, profile)))
            }
            None => Ok(None),
        }
    }

    pub async fn find_user_profile_by_id(
        &self,
        user_id: Uuid,
    ) -> Result<Option<UserProfileResponse>, AppError> {
        let row = sqlx::query!(
            r#"
            SELECT 
                u.id, u.username, u.created_at,
                c.email,
                p.display_name, p.avatar_url, p.bio, p.status, p.custom_status, p.activity,
                (c.password_hash IS NOT NULL) as "has_password!",
                EXISTS(SELECT 1 FROM user_oauth_accounts WHERE user_id = u.id AND provider = 'google') as "has_google!"
            FROM users u
            JOIN user_credentials c ON u.id = c.user_id
            JOIN user_profiles p ON u.id = p.user_id
            WHERE u.id = $1
            "#,
            user_id
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| UserProfileResponse {
            id: r.id,
            username: r.username,
            email: r.email,
            display_name: r.display_name,
            avatar_url: r.avatar_url,
            bio: r.bio,
            status: r.status,
            custom_status: r.custom_status,
            activity: r.activity,
            has_password: r.has_password,
            has_google: r.has_google,
            created_at: r.created_at,
        }))
    }

    /// Atomically updates editable fields of user profile and/or username
    pub async fn update_user_profile(
        &self,
        user_id: Uuid,
        username: Option<&str>,
        display_name: Option<&str>,
        bio: Option<&str>,
        custom_status: Option<&str>,
    ) -> Result<UserProfileResponse, AppError> {
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;

        if let Some(raw_u) = username {
            let u = raw_u.trim();
            if u.len() < 3 || u.len() > 32 {
                return Err(AppError::ValidationError(
                    "O nome de usuário deve ter entre 3 e 32 caracteres.".to_string(),
                ));
            }
            if !u.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(AppError::ValidationError(
                    "O nome de usuário deve conter apenas caracteres alfanuméricos e underscore.".to_string(),
                ));
            }

            // Check if username is already taken by another user (case-insensitive)
            let exists: i64 = sqlx::query_scalar!(
                r#"SELECT COUNT(*) FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2"#,
                u,
                user_id
            )
            .fetch_one(&mut *tx)
            .await?
            .unwrap_or(0);

            if exists > 0 {
                return Err(AppError::UsernameAlreadyExists);
            }

            sqlx::query!(
                r#"
                UPDATE users
                SET username = $2, updated_at = NOW()
                WHERE id = $1
                "#,
                user_id,
                u
            )
            .execute(&mut *tx)
            .await?;
        }

        if display_name.is_some() || bio.is_some() || custom_status.is_some() {
            sqlx::query!(
                r#"
                UPDATE user_profiles
                SET 
                    display_name = COALESCE($2, display_name),
                    bio = COALESCE($3, bio),
                    custom_status = COALESCE($4, custom_status)
                WHERE user_id = $1
                "#,
                user_id,
                display_name,
                bio,
                custom_status
            )
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;

        self.find_user_profile_by_id(user_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Perfil do usuário não encontrado.".to_string()))
    }
}

#[derive(Clone)]
pub struct SessionRepository {
    pool: PgPool,
}

impl SessionRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn create_session(
        &self,
        user_id: Uuid,
        token_hash: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<Session, AppError> {
        let session = sqlx::query_as!(
            Session,
            r#"
            INSERT INTO sessions (user_id, token_hash, expires_at)
            VALUES ($1, $2, $3)
            RETURNING id, user_id, token_hash, created_at, expires_at, revoked_at
            "#,
            user_id,
            token_hash,
            expires_at
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(session)
    }

    pub async fn find_active_by_token_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<Session>, AppError> {
        let session = sqlx::query_as!(
            Session,
            r#"
            SELECT id, user_id, token_hash, created_at, expires_at, revoked_at
            FROM sessions
            WHERE token_hash = $1 
              AND revoked_at IS NULL 
              AND expires_at > NOW()
            "#,
            token_hash
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(session)
    }

    pub async fn revoke_session(&self, token_hash: &str) -> Result<bool, AppError> {
        Ok(self.revoke_session_returning(token_hash).await?.is_some())
    }

    pub async fn revoke_session_returning(
        &self,
        token_hash: &str,
    ) -> Result<Option<(Uuid, Uuid)>, AppError> {
        let row = sqlx::query!(
            r#"
            UPDATE sessions
            SET revoked_at = NOW()
            WHERE token_hash = $1 AND revoked_at IS NULL
            RETURNING id, user_id
            "#,
            token_hash
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| (r.id, r.user_id)))
    }

    pub async fn is_session_active(&self, session_id: Uuid) -> Result<bool, AppError> {
        let row = sqlx::query!(
            r#"
            SELECT id
            FROM sessions
            WHERE id = $1
              AND revoked_at IS NULL
              AND expires_at > NOW()
            "#,
            session_id
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.is_some())
    }

    pub async fn revoke_all_user_sessions(&self, user_id: Uuid) -> Result<u64, AppError> {
        let result = sqlx::query!(
            r#"
            UPDATE sessions
            SET revoked_at = NOW()
            WHERE user_id = $1 AND revoked_at IS NULL
            "#,
            user_id
        )
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected())
    }
}
