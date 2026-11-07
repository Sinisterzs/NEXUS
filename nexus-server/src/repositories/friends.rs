use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::{
    FriendDto, FriendRequestDto, FriendRequestsResponse, PresenceResponse, UserSearchDto,
};

#[derive(Clone)]
pub struct FriendRepository {
    pool: PgPool,
}

impl FriendRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Check if two users are currently friends
    pub async fn is_friend(&self, user_a_id: Uuid, user_b_id: Uuid) -> Result<bool, AppError> {
        let exists = sqlx::query_scalar!(
            r#"
            SELECT EXISTS (
                SELECT 1 FROM friendships
                WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid)
            ) as "exists!"
            "#,
            user_a_id,
            user_b_id
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(exists)
    }

    /// Check if either user has blocked the other
    pub async fn is_blocked(&self, user_a_id: Uuid, user_b_id: Uuid) -> Result<bool, AppError> {
        let exists = sqlx::query_scalar!(
            r#"
            SELECT EXISTS (
                SELECT 1 FROM user_blocks
                WHERE (blocker_id = $1 AND blocked_id = $2)
                   OR (blocker_id = $2 AND blocked_id = $1)
            ) as "exists!"
            "#,
            user_a_id,
            user_b_id
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(exists)
    }

    /// List all friends of a given user with presence and profiles
    pub async fn get_friends(&self, user_id: Uuid) -> Result<Vec<FriendDto>, AppError> {
        let rows = sqlx::query!(
            r#"
            SELECT 
                u.id,
                u.username,
                p.display_name,
                p.avatar_url,
                p.bio,
                p.status,
                p.custom_status,
                p.activity,
                p.last_seen_at
            FROM friendships f
            JOIN users u ON (CASE WHEN f.user_a_id = $1 THEN f.user_b_id ELSE f.user_a_id END) = u.id
            JOIN user_profiles p ON u.id = p.user_id
            WHERE (f.user_a_id = $1 OR f.user_b_id = $1)
              AND NOT EXISTS (
                  SELECT 1 FROM user_blocks b 
                  WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                     OR (b.blocker_id = u.id AND b.blocked_id = $1)
              )
            ORDER BY 
                CASE 
                    WHEN p.status = 'online' THEN 1
                    WHEN p.status = 'idle' THEN 2
                    WHEN p.status = 'dnd' THEN 3
                    ELSE 4 
                END,
                p.display_name ASC
            "#,
            user_id
        )
        .fetch_all(&self.pool)
        .await?;

        let friends = rows
            .into_iter()
            .map(|r| {
                let tag = format!("#{}", &r.username.chars().take(4).collect::<String>());
                FriendDto {
                    id: r.id,
                    username: r.username,
                    tag,
                    display_name: r.display_name,
                    avatar_url: r.avatar_url,
                    bio: r.bio,
                    status: r.status,
                    custom_status: r.custom_status,
                    activity: r.activity,
                    last_seen_at: r.last_seen_at,
                }
            })
            .collect();

        Ok(friends)
    }

    /// Retrieve a single FriendDto for a user
    pub async fn get_friend_dto(&self, user_id: Uuid) -> Result<Option<FriendDto>, AppError> {
        let row = sqlx::query!(
            r#"
            SELECT 
                u.id,
                u.username,
                p.display_name,
                p.avatar_url,
                p.bio,
                p.status,
                p.custom_status,
                p.activity,
                p.last_seen_at
            FROM users u
            JOIN user_profiles p ON u.id = p.user_id
            WHERE u.id = $1
            "#,
            user_id
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| {
            let tag = format!("#{}", &r.username.chars().take(4).collect::<String>());
            FriendDto {
                id: r.id,
                username: r.username,
                tag,
                display_name: r.display_name,
                avatar_url: r.avatar_url,
                bio: r.bio,
                status: r.status,
                custom_status: r.custom_status,
                activity: r.activity,
                last_seen_at: r.last_seen_at,
            }
        }))
    }

    /// List pending incoming and outgoing friend requests
    pub async fn get_requests(&self, user_id: Uuid) -> Result<FriendRequestsResponse, AppError> {
        let incoming_rows = sqlx::query!(
            r#"
            SELECT 
                r.id,
                u.id as user_id,
                u.username,
                p.display_name,
                p.avatar_url,
                p.status,
                r.created_at
            FROM friend_requests r
            JOIN users u ON r.sender_id = u.id
            JOIN user_profiles p ON u.id = p.user_id
            WHERE r.receiver_id = $1 AND r.status = 'pending'
              AND NOT EXISTS (
                  SELECT 1 FROM user_blocks b 
                  WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                     OR (b.blocker_id = u.id AND b.blocked_id = $1)
              )
            ORDER BY r.created_at DESC
            "#,
            user_id
        )
        .fetch_all(&self.pool)
        .await?;

        let incoming = incoming_rows
            .into_iter()
            .map(|r| {
                let tag = format!("#{}", &r.username.chars().take(4).collect::<String>());
                FriendRequestDto {
                    id: r.id,
                    user_id: r.user_id,
                    username: r.username,
                    tag,
                    display_name: r.display_name,
                    avatar_url: r.avatar_url,
                    status: r.status,
                    created_at: r.created_at,
                }
            })
            .collect();

        let outgoing_rows = sqlx::query!(
            r#"
            SELECT 
                r.id,
                u.id as user_id,
                u.username,
                p.display_name,
                p.avatar_url,
                p.status,
                r.created_at
            FROM friend_requests r
            JOIN users u ON r.receiver_id = u.id
            JOIN user_profiles p ON u.id = p.user_id
            WHERE r.sender_id = $1 AND r.status = 'pending'
            ORDER BY r.created_at DESC
            "#,
            user_id
        )
        .fetch_all(&self.pool)
        .await?;

        let outgoing = outgoing_rows
            .into_iter()
            .map(|r| {
                let tag = format!("#{}", &r.username.chars().take(4).collect::<String>());
                FriendRequestDto {
                    id: r.id,
                    user_id: r.user_id,
                    username: r.username,
                    tag,
                    display_name: r.display_name,
                    avatar_url: r.avatar_url,
                    status: r.status,
                    created_at: r.created_at,
                }
            })
            .collect();

        Ok(FriendRequestsResponse { incoming, outgoing })
    }

    /// Send a friend request (or auto-accept if reverse request already pending)
    pub async fn send_request(
        &self,
        sender_id: Uuid,
        target: &str,
    ) -> Result<(FriendRequestDto, bool, Option<FriendDto>, Uuid), AppError> {
        let clean_target = if let Some(pos) = target.find('#') {
            &target[..pos]
        } else {
            target
        }
        .trim();

        if clean_target.is_empty() {
            return Err(AppError::BadRequest("Identificador do usuário inválido.".to_string()));
        }

        // Look up by exact username (never by email, preserving privacy)
        let receiver_opt: Option<(Uuid, String)> = sqlx::query!(
            r#"
            SELECT id, username
            FROM users
            WHERE LOWER(username) = LOWER($1)
            "#,
            clean_target
        )
        .fetch_optional(&self.pool)
        .await?
        .map(|r| (r.id, r.username));

        let (receiver_id, receiver_username) = receiver_opt.ok_or_else(|| {
            AppError::NotFound("Nenhum usuário foi encontrado com este identificador.".to_string())
        })?;

        if receiver_id == sender_id {
            return Err(AppError::BadRequest(
                "Você não pode enviar solicitação de amizade para si mesmo.".to_string(),
            ));
        }

        // Check if either user has blocked the other
        let is_blocked = sqlx::query_scalar!(
            r#"
            SELECT COUNT(*) FROM user_blocks 
            WHERE (blocker_id = $1 AND blocked_id = $2)
               OR (blocker_id = $2 AND blocked_id = $1)
            "#,
            sender_id,
            receiver_id
        )
        .fetch_one(&self.pool)
        .await?
        .unwrap_or(0);

        if is_blocked > 0 {
            return Err(AppError::Forbidden(
                "Não é possível enviar solicitação de amizade para este usuário.".to_string(),
            ));
        }

        // Check privacy preferences of receiver
        let allow_requests = sqlx::query_scalar!(
            r#"
            SELECT allow_friend_requests 
            FROM user_presence_preferences 
            WHERE user_id = $1
            "#,
            receiver_id
        )
        .fetch_optional(&self.pool)
        .await?
        .unwrap_or(true);

        if !allow_requests {
            return Err(AppError::BadRequest(
                "Este usuário configurou a conta para não receber solicitações de amizade.".to_string(),
            ));
        }

        // Check if already friends
        let already_friends = sqlx::query_scalar!(
            r#"
            SELECT COUNT(*) as "count!" FROM friendships 
            WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid)
            "#,
            sender_id,
            receiver_id
        )
        .fetch_one(&self.pool)
        .await?;

        if already_friends > 0 {
            return Err(AppError::Conflict("Você e este usuário já são amigos.".to_string()));
        }

        // Check if reverse request is pending -> auto-accept
        let reverse_req = sqlx::query!(
            r#"
            SELECT id FROM friend_requests 
            WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'
            "#,
            receiver_id,
            sender_id
        )
        .fetch_optional(&self.pool)
        .await?;

        if let Some(rev) = reverse_req {
            let (friend_dto, _, _) = self.accept_request(rev.id, sender_id).await?;
            let req_dto = FriendRequestDto {
                id: rev.id,
                user_id: receiver_id,
                username: receiver_username.clone(),
                tag: format!("#{}", &receiver_username.chars().take(4).collect::<String>()),
                display_name: friend_dto.display_name.clone(),
                avatar_url: friend_dto.avatar_url.clone(),
                status: "accepted".to_string(),
                created_at: Utc::now(),
            };
            return Ok((req_dto, true, Some(friend_dto), receiver_id));
        }

        // Check if sender already has a pending request
        let existing_req = sqlx::query_scalar!(
            r#"
            SELECT COUNT(*) FROM friend_requests 
            WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'
            "#,
            sender_id,
            receiver_id
        )
        .fetch_one(&self.pool)
        .await?
        .unwrap_or(0);

        if existing_req > 0 {
            return Err(AppError::Conflict(
                "Já existe uma solicitação de amizade pendente para este usuário.".to_string(),
            ));
        }

        let request = sqlx::query!(
            r#"
            INSERT INTO friend_requests (sender_id, receiver_id, status)
            VALUES ($1, $2, 'pending')
            RETURNING id, created_at
            "#,
            sender_id,
            receiver_id
        )
        .fetch_one(&self.pool)
        .await?;

        let receiver_dto = self.get_friend_dto(receiver_id).await?
            .ok_or_else(|| AppError::NotFound("Perfil do usuário não encontrado.".to_string()))?;

        let req_dto = FriendRequestDto {
            id: request.id,
            user_id: receiver_id,
            username: receiver_username.clone(),
            tag: format!("#{}", &receiver_username.chars().take(4).collect::<String>()),
            display_name: receiver_dto.display_name,
            avatar_url: receiver_dto.avatar_url,
            status: "pending".to_string(),
            created_at: request.created_at,
        };

        Ok((req_dto, false, None, receiver_id))
    }

    /// Accept incoming friend request (atomic transaction)
    pub async fn accept_request(
        &self,
        request_id: Uuid,
        user_id: Uuid,
    ) -> Result<(FriendDto, FriendDto, Uuid), AppError> {
        let req = sqlx::query!(
            r#"
            SELECT sender_id, receiver_id, status
            FROM friend_requests
            WHERE id = $1
            "#,
            request_id
        )
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Solicitação de amizade não encontrada.".to_string()))?;

        if req.receiver_id != user_id {
            return Err(AppError::Forbidden(
                "Você não tem permissão para aceitar esta solicitação.".to_string(),
            ));
        }

        if req.status != "pending" {
            return Err(AppError::BadRequest("Esta solicitação já foi respondida.".to_string()));
        }

        let mut tx = self.pool.begin().await?;

        sqlx::query!(
            r#"
            UPDATE friend_requests
            SET status = 'accepted', updated_at = NOW()
            WHERE id = $1
            "#,
            request_id
        )
        .execute(&mut *tx)
        .await?;

        sqlx::query!(
            r#"
            INSERT INTO friendships (user_a_id, user_b_id)
            VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
            ON CONFLICT DO NOTHING
            "#,
            req.sender_id,
            req.receiver_id
        )
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        let sender_dto = self
            .get_friend_dto(req.sender_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Perfil do amigo não encontrado.".to_string()))?;
        let receiver_dto = self
            .get_friend_dto(req.receiver_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Perfil do usuário não encontrado.".to_string()))?;

        Ok((sender_dto, receiver_dto, req.sender_id))
    }

    /// Reject incoming friend request
    pub async fn reject_request(&self, request_id: Uuid, user_id: Uuid) -> Result<Uuid, AppError> {
        let req = sqlx::query!(
            r#"
            SELECT sender_id, receiver_id, status
            FROM friend_requests
            WHERE id = $1
            "#,
            request_id
        )
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Solicitação de amizade não encontrada.".to_string()))?;

        if req.receiver_id != user_id {
            return Err(AppError::Forbidden(
                "Você não tem permissão para rejeitar esta solicitação.".to_string(),
            ));
        }

        sqlx::query!(
            r#"
            UPDATE friend_requests
            SET status = 'rejected', updated_at = NOW()
            WHERE id = $1
            "#,
            request_id
        )
        .execute(&self.pool)
        .await?;

        Ok(req.sender_id)
    }

    /// Cancel outgoing friend request or delete pending request
    pub async fn cancel_request(&self, request_id: Uuid, user_id: Uuid) -> Result<Uuid, AppError> {
        let req = sqlx::query!(
            r#"
            SELECT sender_id, receiver_id, status
            FROM friend_requests
            WHERE id = $1
            "#,
            request_id
        )
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Solicitação de amizade não encontrada.".to_string()))?;

        if req.sender_id != user_id && req.receiver_id != user_id {
            return Err(AppError::Forbidden(
                "Você não tem permissão para cancelar esta solicitação.".to_string(),
            ));
        }

        sqlx::query!(
            r#"
            UPDATE friend_requests
            SET status = 'cancelled', updated_at = NOW()
            WHERE id = $1
            "#,
            request_id
        )
        .execute(&self.pool)
        .await?;

        let target_id = if req.sender_id == user_id {
            req.receiver_id
        } else {
            req.sender_id
        };

        Ok(target_id)
    }

    /// Remove friendship
    pub async fn remove_friend(&self, user_id: Uuid, friend_id: Uuid) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await?;

        sqlx::query!(
            r#"
            DELETE FROM friendships
            WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid)
            "#,
            user_id,
            friend_id
        )
        .execute(&mut *tx)
        .await?;

        sqlx::query!(
            r#"
            DELETE FROM friend_requests
            WHERE (sender_id = $1 AND receiver_id = $2)
               OR (sender_id = $2 AND receiver_id = $1)
            "#,
            user_id,
            friend_id
        )
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        Ok(())
    }

    /// Block a user (atomic: block + remove friendship + cancel pending requests)
    pub async fn block_user(&self, blocker_id: Uuid, blocked_id: Uuid) -> Result<(), AppError> {
        if blocker_id == blocked_id {
            return Err(AppError::BadRequest("Você não pode bloquear a si mesmo.".to_string()));
        }

        let mut tx = self.pool.begin().await?;

        sqlx::query!(
            r#"
            INSERT INTO user_blocks (blocker_id, blocked_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
            "#,
            blocker_id,
            blocked_id
        )
        .execute(&mut *tx)
        .await?;

        // Remove friendship if one existed
        sqlx::query!(
            r#"
            DELETE FROM friendships
            WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid)
            "#,
            blocker_id,
            blocked_id
        )
        .execute(&mut *tx)
        .await?;

        // Cancel any pending requests
        sqlx::query!(
            r#"
            DELETE FROM friend_requests
            WHERE (sender_id = $1 AND receiver_id = $2)
               OR (sender_id = $2 AND receiver_id = $1)
            "#,
            blocker_id,
            blocked_id
        )
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        Ok(())
    }

    /// Unblock a user
    pub async fn unblock_user(&self, blocker_id: Uuid, blocked_id: Uuid) -> Result<(), AppError> {
        sqlx::query!(
            r#"
            DELETE FROM user_blocks
            WHERE blocker_id = $1 AND blocked_id = $2
            "#,
            blocker_id,
            blocked_id
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// Search registered users by exact or prefix username (never reveals email)
    pub async fn search_users(
        &self,
        current_user_id: Uuid,
        query: &str,
    ) -> Result<Vec<UserSearchDto>, AppError> {
        let clean_query = query.trim();
        if clean_query.is_empty() {
            return Ok(Vec::new());
        }

        let pattern = format!("%{}%", clean_query);

        let rows = sqlx::query!(
            r#"
            SELECT 
                u.id,
                u.username,
                p.display_name,
                p.avatar_url,
                EXISTS(
                    SELECT 1 FROM friendships 
                    WHERE user_a_id = LEAST($1::uuid, u.id) AND user_b_id = GREATEST($1::uuid, u.id)
                ) as "is_friend!",
                EXISTS(
                    SELECT 1 FROM friend_requests 
                    WHERE status = 'pending' 
                      AND ((sender_id = $1 AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = $1))
                ) as "has_pending_request!",
                EXISTS(
                    SELECT 1 FROM user_blocks 
                    WHERE (blocker_id = $1 AND blocked_id = u.id)
                       OR (blocker_id = u.id AND blocked_id = $1)
                ) as "is_blocked!"
            FROM users u
            JOIN user_profiles p ON u.id = p.user_id
            WHERE u.id <> $1
              AND (LOWER(u.username) LIKE LOWER($2) OR LOWER(p.display_name) LIKE LOWER($2))
            ORDER BY 
                CASE WHEN LOWER(u.username) = LOWER($3) THEN 0 ELSE 1 END,
                p.display_name ASC
            LIMIT 20
            "#,
            current_user_id,
            pattern,
            clean_query
        )
        .fetch_all(&self.pool)
        .await?;

        let results = rows
            .into_iter()
            .map(|r| {
                let tag = format!("#{}", &r.username.chars().take(4).collect::<String>());
                UserSearchDto {
                    id: r.id,
                    username: r.username,
                    tag,
                    display_name: r.display_name,
                    avatar_url: r.avatar_url,
                    is_friend: r.is_friend,
                    has_pending_request: r.has_pending_request,
                    is_blocked: r.is_blocked,
                }
            })
            .collect();

        Ok(results)
    }

    /// Get user presence preference and profile status
    pub async fn get_presence(&self, user_id: Uuid) -> Result<PresenceResponse, AppError> {
        let pref = sqlx::query!(
            r#"
            SELECT preferred_status, allow_friend_requests
            FROM user_presence_preferences
            WHERE user_id = $1
            "#,
            user_id
        )
        .fetch_optional(&self.pool)
        .await?;

        let profile = sqlx::query!(
            r#"
            SELECT status, custom_status, activity, last_seen_at
            FROM user_profiles
            WHERE user_id = $1
            "#,
            user_id
        )
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Perfil não encontrado.".to_string()))?;

        let preferred_status = pref
            .as_ref()
            .map(|p| p.preferred_status.clone())
            .unwrap_or_else(|| "online".to_string());
        let allow_friend_requests = pref.map(|p| p.allow_friend_requests).unwrap_or(true);

        Ok(PresenceResponse {
            user_id,
            status: profile.status,
            preferred_status,
            custom_status: profile.custom_status,
            activity: profile.activity,
            allow_friend_requests,
            last_seen_at: profile.last_seen_at,
        })
    }

    /// Update only the effective connectivity status and `last_seen_at` in `user_profiles`
    /// without altering `user_presence_preferences.preferred_status`, `custom_status`, or `activity`.
    pub async fn set_connectivity_status(
        &self,
        user_id: Uuid,
        effective_status: &str,
    ) -> Result<chrono::DateTime<chrono::Utc>, AppError> {
        let row = sqlx::query!(
            r#"
            UPDATE user_profiles
            SET status = $2, last_seen_at = NOW()
            WHERE user_id = $1
            RETURNING last_seen_at
            "#,
            user_id,
            effective_status
        )
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Perfil não encontrado.".to_string()))?;

        Ok(row.last_seen_at.unwrap_or_else(chrono::Utc::now))
    }

    /// Update user presence status and preferences in database
    pub async fn update_presence(
        &self,
        user_id: Uuid,
        preferred_status: Option<&str>,
        custom_status: Option<&str>,
        activity: Option<&str>,
        allow_friend_requests: Option<bool>,
    ) -> Result<PresenceResponse, AppError> {
        let mut tx = self.pool.begin().await?;

        if let Some(status) = preferred_status {
            match status {
                "online" | "idle" | "dnd" | "invisible" => {
                    sqlx::query!(
                        r#"
                        INSERT INTO user_presence_preferences (user_id, preferred_status, allow_friend_requests, updated_at)
                        VALUES ($1, $2, COALESCE($3, true), NOW())
                        ON CONFLICT (user_id) DO UPDATE
                        SET 
                            preferred_status = EXCLUDED.preferred_status,
                            allow_friend_requests = COALESCE($3, user_presence_preferences.allow_friend_requests),
                            updated_at = NOW()
                        "#,
                        user_id,
                        status,
                        allow_friend_requests
                    )
                    .execute(&mut *tx)
                    .await?;

                    let effective_profile_status = if status == "invisible" {
                        "offline"
                    } else {
                        status
                    };

                    sqlx::query!(
                        r#"
                        UPDATE user_profiles
                        SET status = $2, last_seen_at = NOW()
                        WHERE user_id = $1
                        "#,
                        user_id,
                        effective_profile_status
                    )
                    .execute(&mut *tx)
                    .await?;
                }
                "offline" => {
                    // Never write 'offline' into user_presence_preferences.preferred_status (violates CHECK constraint).
                    // Only update effective connectivity status and last_seen_at on user_profiles.
                    sqlx::query!(
                        r#"
                        UPDATE user_profiles
                        SET status = 'offline', last_seen_at = NOW()
                        WHERE user_id = $1
                        "#,
                        user_id
                    )
                    .execute(&mut *tx)
                    .await?;

                    if let Some(allow) = allow_friend_requests {
                        sqlx::query!(
                            r#"
                            INSERT INTO user_presence_preferences (user_id, preferred_status, allow_friend_requests, updated_at)
                            VALUES ($1, 'online', $2, NOW())
                            ON CONFLICT (user_id) DO UPDATE
                            SET 
                                allow_friend_requests = EXCLUDED.allow_friend_requests,
                                updated_at = NOW()
                            "#,
                            user_id,
                            allow
                        )
                        .execute(&mut *tx)
                        .await?;
                    }
                }
                _ => {
                    return Err(AppError::BadRequest(
                        "Status de presença inválido. Use online, idle, dnd ou invisible.".to_string(),
                    ));
                }
            }
        } else if let Some(allow) = allow_friend_requests {
            sqlx::query!(
                r#"
                INSERT INTO user_presence_preferences (user_id, preferred_status, allow_friend_requests, updated_at)
                VALUES ($1, 'online', $2, NOW())
                ON CONFLICT (user_id) DO UPDATE
                SET 
                    allow_friend_requests = EXCLUDED.allow_friend_requests,
                    updated_at = NOW()
                "#,
                user_id,
                allow
            )
            .execute(&mut *tx)
            .await?;
        }

        if custom_status.is_some() || activity.is_some() {
            sqlx::query!(
                r#"
                UPDATE user_profiles
                SET 
                    custom_status = COALESCE($2, custom_status),
                    activity = COALESCE($3, activity),
                    last_seen_at = NOW()
                WHERE user_id = $1
                "#,
                user_id,
                custom_status,
                activity
            )
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;

        self.get_presence(user_id).await
    }

    /// Get list of friend IDs for broadcasting (excluding any blocked users)
    pub async fn get_friend_ids(&self, user_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        let rows = sqlx::query_scalar!(
            r#"
            SELECT (CASE WHEN f.user_a_id = $1 THEN f.user_b_id ELSE f.user_a_id END) as "friend_id!"
            FROM friendships f
            WHERE (f.user_a_id = $1 OR f.user_b_id = $1)
              AND NOT EXISTS (
                  SELECT 1 FROM user_blocks b 
                  WHERE (b.blocker_id = $1 AND b.blocked_id = (CASE WHEN f.user_a_id = $1 THEN f.user_b_id ELSE f.user_a_id END))
                     OR (b.blocker_id = (CASE WHEN f.user_a_id = $1 THEN f.user_b_id ELSE f.user_a_id END) AND b.blocked_id = $1)
              )
            "#,
            user_id
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }
}
