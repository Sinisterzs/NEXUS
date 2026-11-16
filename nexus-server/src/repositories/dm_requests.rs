use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppError;
use crate::services::social_policy::{SocialPermissionDecision, SocialPolicyService};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DmMessageRequest {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub sender_id: Uuid,
    pub recipient_id: Uuid,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub responded_at: Option<DateTime<Utc>>,
    pub cooldown_until: Option<DateTime<Utc>>,
}

#[derive(Clone)]
pub struct DmRequestRepository {
    pool: PgPool,
}

impl DmRequestRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn create_request(
        &self,
        policy: &SocialPolicyService,
        conversation_id: Uuid,
        sender_id: Uuid,
        recipient_id: Uuid,
    ) -> Result<DmMessageRequest, AppError> {
        let (ua, ub) = if sender_id < recipient_id {
            (sender_id, recipient_id)
        } else {
            (recipient_id, sender_id)
        };
        let conv_matches: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM direct_conversations
                WHERE id = $1 AND user_a_id = $2 AND user_b_id = $3
            )
            "#,
        )
        .bind(conversation_id)
        .bind(ua)
        .bind(ub)
        .fetch_one(&self.pool)
        .await?;

        if !conv_matches {
            return Err(AppError::ValidationError(
                "Conversa incompatível com os participantes informados.".to_string(),
            ));
        }

        let decision = policy.can_start_dm(sender_id, recipient_id).await?;
        if decision == SocialPermissionDecision::Denied {
            return Err(AppError::Forbidden(
                "Não é possível enviar solicitação de mensagem para este usuário.".to_string(),
            ));
        }
        if decision == SocialPermissionDecision::Allowed {
            return Err(AppError::ValidationError(
                "Usuários amigos não precisam de solicitação de mensagem.".to_string(),
            ));
        }

        let in_cooldown: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM dm_message_requests
                WHERE sender_id = $1
                  AND recipient_id = $2
                  AND status = 'declined'
                  AND cooldown_until IS NOT NULL
                  AND cooldown_until > NOW()
            )
            "#,
        )
        .bind(sender_id)
        .bind(recipient_id)
        .fetch_one(&self.pool)
        .await?;

        if in_cooldown {
            return Err(AppError::Forbidden(
                "Aguarde antes de enviar uma nova solicitação para este usuário.".to_string(),
            ));
        }

        let inserted = sqlx::query_as::<_, DmMessageRequest>(
            r#"
            INSERT INTO dm_message_requests (conversation_id, sender_id, recipient_id, status)
            VALUES ($1, $2, $3, 'pending')
            ON CONFLICT (sender_id, recipient_id) WHERE status = 'pending' DO NOTHING
            RETURNING id, conversation_id, sender_id, recipient_id, status, created_at, responded_at, cooldown_until
            "#,
        )
        .bind(conversation_id)
        .bind(sender_id)
        .bind(recipient_id)
        .fetch_optional(&self.pool)
        .await?;

        if let Some(req) = inserted {
            return Ok(req);
        }

        let existing = sqlx::query_as::<_, DmMessageRequest>(
            r#"
            SELECT id, conversation_id, sender_id, recipient_id, status, created_at, responded_at, cooldown_until
            FROM dm_message_requests
            WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'
            LIMIT 1
            "#,
        )
        .bind(sender_id)
        .bind(recipient_id)
        .fetch_one(&self.pool)
        .await?;

        Ok(existing)
    }

    pub async fn list_incoming_pending(
        &self,
        recipient_id: Uuid,
    ) -> Result<Vec<DmMessageRequest>, AppError> {
        let rows = sqlx::query_as::<_, DmMessageRequest>(
            r#"
            SELECT id, conversation_id, sender_id, recipient_id, status, created_at, responded_at, cooldown_until
            FROM dm_message_requests
            WHERE recipient_id = $1 AND status = 'pending'
            ORDER BY created_at DESC
            "#,
        )
        .bind(recipient_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    pub async fn accept_request(
        &self,
        request_id: Uuid,
        recipient_id: Uuid,
    ) -> Result<DmMessageRequest, AppError> {
        let updated = sqlx::query_as::<_, DmMessageRequest>(
            r#"
            UPDATE dm_message_requests
            SET status = 'accepted', responded_at = NOW()
            WHERE id = $1 AND recipient_id = $2 AND status = 'pending'
            RETURNING id, conversation_id, sender_id, recipient_id, status, created_at, responded_at, cooldown_until
            "#,
        )
        .bind(request_id)
        .bind(recipient_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Solicitação não encontrada ou não autorizada.".to_string()))?;

        Ok(updated)
    }

    pub async fn decline_request(
        &self,
        request_id: Uuid,
        recipient_id: Uuid,
        cooldown_hours: i64,
    ) -> Result<DmMessageRequest, AppError> {
        let cooldown_until = Utc::now() + Duration::hours(cooldown_hours.max(1));
        let updated = sqlx::query_as::<_, DmMessageRequest>(
            r#"
            UPDATE dm_message_requests
            SET status = 'declined', responded_at = NOW(), cooldown_until = $3
            WHERE id = $1 AND recipient_id = $2 AND status = 'pending'
            RETURNING id, conversation_id, sender_id, recipient_id, status, created_at, responded_at, cooldown_until
            "#,
        )
        .bind(request_id)
        .bind(recipient_id)
        .bind(cooldown_until)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Solicitação não encontrada ou não autorizada.".to_string()))?;

        Ok(updated)
    }

    pub async fn get_status_between(
        &self,
        sender_id: Uuid,
        recipient_id: Uuid,
    ) -> Result<Option<DmMessageRequest>, AppError> {
        let row = sqlx::query_as::<_, DmMessageRequest>(
            r#"
            SELECT id, conversation_id, sender_id, recipient_id, status, created_at, responded_at, cooldown_until
            FROM dm_message_requests
            WHERE sender_id = $1 AND recipient_id = $2
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(sender_id)
        .bind(recipient_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row)
    }
}
