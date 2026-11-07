use chrono::{Duration, Utc};
use rand::RngCore;
use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::{
    DirectConversation, DirectConversationDto, DirectMessageDto, FriendDto,
};

#[derive(Clone)]
pub struct DmRepository {
    pool: PgPool,
}

impl DmRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Finds or creates a direct conversation between two users
    pub async fn get_or_create_conversation(
        &self,
        user_a: Uuid,
        user_b: Uuid,
    ) -> Result<DirectConversation, AppError> {
        if user_a == user_b {
            return Err(AppError::BadRequest("Não é possível criar conversa consigo mesmo.".into()));
        }

        let u1 = std::cmp::min(user_a, user_b);
        let u2 = std::cmp::max(user_a, user_b);

        let row = sqlx::query_as!(
            DirectConversation,
            r#"
            INSERT INTO direct_conversations (user_a_id, user_b_id, created_at, updated_at)
            VALUES ($1, $2, NOW(), NOW())
            ON CONFLICT (LEAST(user_a_id, user_b_id), GREATEST(user_a_id, user_b_id))
            DO UPDATE SET updated_at = direct_conversations.updated_at
            RETURNING id, user_a_id, user_b_id, created_at, updated_at
            "#,
            u1,
            u2
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// Finds a conversation by its unique ID
    pub async fn find_conversation_by_id(
        &self,
        conv_id: Uuid,
    ) -> Result<Option<DirectConversation>, AppError> {
        let conv = sqlx::query_as!(
            DirectConversation,
            r#"
            SELECT id, user_a_id, user_b_id, created_at, updated_at
            FROM direct_conversations
            WHERE id = $1
            "#,
            conv_id
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(conv)
    }

    /// Checks if a user is a participant in a conversation
    pub async fn is_participant(&self, conv_id: Uuid, user_id: Uuid) -> Result<bool, AppError> {
        let exists = sqlx::query_scalar!(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM direct_conversations
                WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)
            ) as "exists!"
            "#,
            conv_id,
            user_id
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(exists)
    }

    /// Returns the other participant's UUID in a conversation
    pub async fn get_other_participant(
        &self,
        conv_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<Uuid>, AppError> {
        let row = sqlx::query!(
            r#"
            SELECT 
                CASE WHEN user_a_id = $2 THEN user_b_id ELSE user_a_id END as "other_id!"
            FROM direct_conversations
            WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)
            "#,
            conv_id,
            user_id
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| r.other_id))
    }

    /// Lists all DM conversations for a user with the other user's profile and last message
    pub async fn list_conversations(
        &self,
        user_id: Uuid,
    ) -> Result<Vec<DirectConversationDto>, AppError> {
        let rows = sqlx::query!(
            r#"
            SELECT 
                c.id as conv_id,
                c.created_at as conv_created_at,
                c.updated_at as conv_updated_at,
                u.id as other_id,
                u.username as other_username,
                p.display_name as other_display_name,
                p.avatar_url as other_avatar_url,
                p.bio as other_bio,
                p.status as other_status,
                p.custom_status as other_custom_status,
                p.activity as other_activity,
                p.last_seen_at as other_last_seen_at,
                (
                    SELECT COUNT(*)::bigint
                    FROM direct_messages dm
                    JOIN direct_message_receipts r ON dm.id = r.message_id
                    WHERE dm.conversation_id = c.id
                      AND r.user_id = $1
                      AND r.read_at IS NULL
                      AND dm.deleted_at IS NULL
                ) as "unread_count!"
            FROM direct_conversations c
            JOIN users u ON (CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END) = u.id
            JOIN user_profiles p ON u.id = p.user_id
            WHERE (c.user_a_id = $1 OR c.user_b_id = $1)
            ORDER BY c.updated_at DESC
            "#,
            user_id
        )
        .fetch_all(&self.pool)
        .await?;

        let mut dtos = Vec::with_capacity(rows.len());

        for r in rows {
            let last_msg = self.get_latest_message(r.conv_id, user_id).await?;
            let tag = format!("#{}", &r.other_username.chars().take(4).collect::<String>());

            dtos.push(DirectConversationDto {
                id: r.conv_id,
                other_user: FriendDto {
                    id: r.other_id,
                    username: r.other_username,
                    tag,
                    display_name: r.other_display_name,
                    avatar_url: r.other_avatar_url,
                    bio: r.other_bio,
                    status: r.other_status,
                    custom_status: r.other_custom_status,
                    activity: r.other_activity,
                    last_seen_at: r.other_last_seen_at,
                },
                last_message: last_msg,
                unread_count: r.unread_count,
                created_at: r.conv_created_at,
                updated_at: r.conv_updated_at,
            });
        }

        Ok(dtos)
    }

    /// Fetches latest single message of a conversation
    pub async fn get_latest_message(
        &self,
        conv_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<DirectMessageDto>, AppError> {
        let row = sqlx::query!(
            r#"
            SELECT 
                m.id,
                m.conversation_id,
                m.sender_id,
                m.client_message_id,
                m.content,
                m.created_at,
                m.edited_at,
                m.deleted_at,
                r.delivered_at,
                r.read_at
            FROM direct_messages m
            LEFT JOIN direct_message_receipts r ON m.id = r.message_id
            WHERE m.conversation_id = $1
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT 1
            "#,
            conv_id
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| DirectMessageDto {
            id: r.id,
            conversation_id: r.conversation_id,
            sender_id: r.sender_id,
            client_message_id: r.client_message_id,
            content: if r.deleted_at.is_some() {
                "[Mensagem apagada]".to_string()
            } else {
                r.content
            },
            created_at: r.created_at,
            edited_at: r.edited_at,
            deleted_at: r.deleted_at,
            delivered_at: r.delivered_at,
            read_at: r.read_at,
            is_mine: r.sender_id == user_id,
        }))
    }

    /// Saves a direct message idempotently. Returns (DirectMessageDto, is_new).
    pub async fn save_message(
        &self,
        conv_id: Uuid,
        sender_id: Uuid,
        recipient_id: Uuid,
        client_message_id: Uuid,
        content: &str,
    ) -> Result<(DirectMessageDto, bool), AppError> {
        let mut tx = self.pool.begin().await?;

        // 1. Try idempotent insert into direct_messages
        let inserted = sqlx::query!(
            r#"
            INSERT INTO direct_messages (conversation_id, sender_id, client_message_id, content, created_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (sender_id, client_message_id) DO NOTHING
            RETURNING id, conversation_id, sender_id, client_message_id, content, created_at, edited_at, deleted_at
            "#,
            conv_id,
            sender_id,
            client_message_id,
            content
        )
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(msg) = inserted {
            // New message: create receipt entry for recipient
            sqlx::query!(
                r#"
                INSERT INTO direct_message_receipts (message_id, user_id)
                VALUES ($1, $2)
                ON CONFLICT (message_id, user_id) DO NOTHING
                "#,
                msg.id,
                recipient_id
            )
            .execute(&mut *tx)
            .await?;

            // Update conversation updated_at
            sqlx::query!(
                r#"
                UPDATE direct_conversations
                SET updated_at = NOW()
                WHERE id = $1
                "#,
                conv_id
            )
            .execute(&mut *tx)
            .await?;

            tx.commit().await?;

            let dto = DirectMessageDto {
                id: msg.id,
                conversation_id: msg.conversation_id,
                sender_id: msg.sender_id,
                client_message_id: msg.client_message_id,
                content: msg.content,
                created_at: msg.created_at,
                edited_at: msg.edited_at,
                deleted_at: msg.deleted_at,
                delivered_at: None,
                read_at: None,
                is_mine: true,
            };

            Ok((dto, true))
        } else {
            // Duplicate client_message_id: fetch existing message
            tx.rollback().await?;

            let existing = sqlx::query!(
                r#"
                SELECT 
                    m.id,
                    m.conversation_id,
                    m.sender_id,
                    m.client_message_id,
                    m.content,
                    m.created_at,
                    m.edited_at,
                    m.deleted_at,
                    r.delivered_at,
                    r.read_at
                FROM direct_messages m
                LEFT JOIN direct_message_receipts r ON m.id = r.message_id
                WHERE m.sender_id = $1 AND m.client_message_id = $2
                "#,
                sender_id,
                client_message_id
            )
            .fetch_one(&self.pool)
            .await?;

            let dto = DirectMessageDto {
                id: existing.id,
                conversation_id: existing.conversation_id,
                sender_id: existing.sender_id,
                client_message_id: existing.client_message_id,
                content: if existing.deleted_at.is_some() {
                    "[Mensagem apagada]".to_string()
                } else {
                    existing.content
                },
                created_at: existing.created_at,
                edited_at: existing.edited_at,
                deleted_at: existing.deleted_at,
                delivered_at: existing.delivered_at,
                read_at: existing.read_at,
                is_mine: existing.sender_id == sender_id,
            };

            Ok((dto, false))
        }
    }

    /// Keyset pagination with cursor (before_id)
    pub async fn list_messages_cursor(
        &self,
        conv_id: Uuid,
        user_id: Uuid,
        before_id: Option<Uuid>,
        limit: i64,
    ) -> Result<Vec<DirectMessageDto>, AppError> {
        let page_size = limit.clamp(1, 100);

        let mut dtos: Vec<DirectMessageDto> = if let Some(cursor_id) = before_id {
            // Look up cursor (created_at, id)
            let cursor = sqlx::query!(
                "SELECT created_at, id FROM direct_messages WHERE id = $1 AND conversation_id = $2",
                cursor_id,
                conv_id
            )
            .fetch_optional(&self.pool)
            .await?;

            if let Some(c) = cursor {
                let rows = sqlx::query!(
                    r#"
                    SELECT 
                        m.id,
                        m.conversation_id,
                        m.sender_id,
                        m.client_message_id,
                        m.content,
                        m.created_at,
                        m.edited_at,
                        m.deleted_at,
                        r.delivered_at,
                        r.read_at
                    FROM direct_messages m
                    LEFT JOIN direct_message_receipts r ON m.id = r.message_id
                    WHERE m.conversation_id = $1
                      AND (m.created_at, m.id) < ($2, $3)
                    ORDER BY m.created_at DESC, m.id DESC
                    LIMIT $4
                    "#,
                    conv_id,
                    c.created_at,
                    c.id,
                    page_size
                )
                .fetch_all(&self.pool)
                .await?;

                rows.into_iter()
                    .map(|r| DirectMessageDto {
                        id: r.id,
                        conversation_id: r.conversation_id,
                        sender_id: r.sender_id,
                        client_message_id: r.client_message_id,
                        content: if r.deleted_at.is_some() {
                            "[Mensagem apagada]".to_string()
                        } else {
                            r.content
                        },
                        created_at: r.created_at,
                        edited_at: r.edited_at,
                        deleted_at: r.deleted_at,
                        delivered_at: r.delivered_at,
                        read_at: r.read_at,
                        is_mine: r.sender_id == user_id,
                    })
                    .collect()
            } else {
                Vec::new()
            }
        } else {
            let rows = sqlx::query!(
                r#"
                SELECT 
                    m.id,
                    m.conversation_id,
                    m.sender_id,
                    m.client_message_id,
                    m.content,
                    m.created_at,
                    m.edited_at,
                    m.deleted_at,
                    r.delivered_at,
                    r.read_at
                FROM direct_messages m
                LEFT JOIN direct_message_receipts r ON m.id = r.message_id
                WHERE m.conversation_id = $1
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT $2
                "#,
                conv_id,
                page_size
            )
            .fetch_all(&self.pool)
            .await?;

            rows.into_iter()
                .map(|r| DirectMessageDto {
                    id: r.id,
                    conversation_id: r.conversation_id,
                    sender_id: r.sender_id,
                    client_message_id: r.client_message_id,
                    content: if r.deleted_at.is_some() {
                        "[Mensagem apagada]".to_string()
                    } else {
                        r.content
                    },
                    created_at: r.created_at,
                    edited_at: r.edited_at,
                    deleted_at: r.deleted_at,
                    delivered_at: r.delivered_at,
                    read_at: r.read_at,
                    is_mine: r.sender_id == user_id,
                })
                .collect()
        };

        dtos.reverse();
        Ok(dtos)
    }

    /// Fetches a single message by ID
    pub async fn get_message_by_id(
        &self,
        message_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<DirectMessageDto>, AppError> {
        let row = sqlx::query!(
            r#"
            SELECT 
                m.id,
                m.conversation_id,
                m.sender_id,
                m.client_message_id,
                m.content,
                m.created_at,
                m.edited_at,
                m.deleted_at,
                r.delivered_at,
                r.read_at
            FROM direct_messages m
            LEFT JOIN direct_message_receipts r ON m.id = r.message_id
            WHERE m.id = $1
            "#,
            message_id
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| DirectMessageDto {
            id: r.id,
            conversation_id: r.conversation_id,
            sender_id: r.sender_id,
            client_message_id: r.client_message_id,
            content: if r.deleted_at.is_some() {
                "[Mensagem apagada]".to_string()
            } else {
                r.content
            },
            created_at: r.created_at,
            edited_at: r.edited_at,
            deleted_at: r.deleted_at,
            delivered_at: r.delivered_at,
            read_at: r.read_at,
            is_mine: r.sender_id == user_id,
        }))
    }

    /// Edits own message (only if sender matches and not deleted)
    pub async fn edit_message(
        &self,
        message_id: Uuid,
        sender_id: Uuid,
        new_content: &str,
    ) -> Result<DirectMessageDto, AppError> {
        let updated = sqlx::query!(
            r#"
            UPDATE direct_messages
            SET content = $1, edited_at = NOW()
            WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL
            RETURNING id, conversation_id, sender_id, client_message_id, content, created_at, edited_at, deleted_at
            "#,
            new_content,
            message_id,
            sender_id
        )
        .fetch_optional(&self.pool)
        .await?;

        let msg = match updated {
            Some(m) => m,
            None => {
                // Check if message exists to produce clear error
                let exists = sqlx::query_scalar!(
                    "SELECT sender_id FROM direct_messages WHERE id = $1",
                    message_id
                )
                .fetch_optional(&self.pool)
                .await?;

                match exists {
                    Some(s_id) if s_id != sender_id => {
                        return Err(AppError::Forbidden(
                            "Você só pode editar mensagens de sua autoria.".into(),
                        ));
                    }
                    Some(_) => {
                        return Err(AppError::BadRequest(
                            "Mensagens apagadas não podem ser editadas.".into(),
                        ));
                    }
                    None => {
                        return Err(AppError::NotFound("Mensagem não encontrada.".into()));
                    }
                }
            }
        };

        // Fetch receipts
        let receipts = sqlx::query!(
            "SELECT delivered_at, read_at FROM direct_message_receipts WHERE message_id = $1",
            msg.id
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(DirectMessageDto {
            id: msg.id,
            conversation_id: msg.conversation_id,
            sender_id: msg.sender_id,
            client_message_id: msg.client_message_id,
            content: msg.content,
            created_at: msg.created_at,
            edited_at: msg.edited_at,
            deleted_at: msg.deleted_at,
            delivered_at: receipts.as_ref().and_then(|r| r.delivered_at),
            read_at: receipts.as_ref().and_then(|r| r.read_at),
            is_mine: true,
        })
    }

    /// Soft-deletes own message (tombstone pattern)
    pub async fn delete_message(
        &self,
        message_id: Uuid,
        sender_id: Uuid,
    ) -> Result<DirectMessageDto, AppError> {
        let updated = sqlx::query!(
            r#"
            UPDATE direct_messages
            SET deleted_at = NOW(), content = '[Mensagem apagada]'
            WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
            RETURNING id, conversation_id, sender_id, client_message_id, content, created_at, edited_at, deleted_at
            "#,
            message_id,
            sender_id
        )
        .fetch_optional(&self.pool)
        .await?;

        let msg = match updated {
            Some(m) => m,
            None => {
                let exists = sqlx::query_scalar!(
                    "SELECT sender_id FROM direct_messages WHERE id = $1",
                    message_id
                )
                .fetch_optional(&self.pool)
                .await?;

                match exists {
                    Some(s_id) if s_id != sender_id => {
                        return Err(AppError::Forbidden(
                            "Você só pode excluir mensagens de sua autoria.".into(),
                        ));
                    }
                    Some(_) => {
                        return Err(AppError::BadRequest("Mensagem já foi excluída.".into()));
                    }
                    None => {
                        return Err(AppError::NotFound("Mensagem não encontrada.".into()));
                    }
                }
            }
        };

        let receipts = sqlx::query!(
            "SELECT delivered_at, read_at FROM direct_message_receipts WHERE message_id = $1",
            msg.id
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(DirectMessageDto {
            id: msg.id,
            conversation_id: msg.conversation_id,
            sender_id: msg.sender_id,
            client_message_id: msg.client_message_id,
            content: "[Mensagem apagada]".to_string(),
            created_at: msg.created_at,
            edited_at: msg.edited_at,
            deleted_at: msg.deleted_at,
            delivered_at: receipts.as_ref().and_then(|r| r.delivered_at),
            read_at: receipts.as_ref().and_then(|r| r.read_at),
            is_mine: true,
        })
    }

    /// Marks conversation as read up to a message
    pub async fn mark_conversation_read(
        &self,
        conv_id: Uuid,
        user_id: Uuid,
        last_read_message_id: Option<Uuid>,
    ) -> Result<Vec<Uuid>, AppError> {
        let mut tx = self.pool.begin().await?;

        // 1. Upsert conversation state
        sqlx::query!(
            r#"
            INSERT INTO direct_conversation_state (conversation_id, user_id, last_read_message_id, last_read_at, updated_at)
            VALUES ($1, $2, $3, NOW(), NOW())
            ON CONFLICT (conversation_id, user_id)
            DO UPDATE SET 
                last_read_message_id = COALESCE(EXCLUDED.last_read_message_id, direct_conversation_state.last_read_message_id),
                last_read_at = NOW(),
                updated_at = NOW()
            "#,
            conv_id,
            user_id,
            last_read_message_id
        )
        .execute(&mut *tx)
        .await?;

        // 2. Mark receipts read where user is recipient
        let marked = sqlx::query_scalar!(
            r#"
            UPDATE direct_message_receipts r
            SET read_at = NOW()
            FROM direct_messages m
            WHERE r.message_id = m.id
              AND m.conversation_id = $1
              AND r.user_id = $2
              AND r.read_at IS NULL
            RETURNING r.message_id
            "#,
            conv_id,
            user_id
        )
        .fetch_all(&mut *tx)
        .await?;

        tx.commit().await?;

        Ok(marked)
    }

    /// Marks delivered receipts for recipient
    pub async fn mark_messages_delivered(
        &self,
        user_id: Uuid,
        message_ids: &[Uuid],
    ) -> Result<Vec<(Uuid, Uuid)>, AppError> {
        if message_ids.is_empty() {
            return Ok(Vec::new());
        }

        let rows = sqlx::query!(
            r#"
            UPDATE direct_message_receipts r
            SET delivered_at = NOW()
            FROM direct_messages m
            WHERE r.message_id = m.id
              AND r.user_id = $1
              AND r.delivered_at IS NULL
              AND r.message_id = ANY($2)
            RETURNING m.conversation_id as "conv_id!", r.message_id as "msg_id!"
            "#,
            user_id,
            message_ids
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(|r| (r.conv_id, r.msg_id)).collect())
    }

    /// Creates an ephemeral 60s gateway ticket
    pub async fn create_gateway_ticket(&self, user_id: Uuid) -> Result<String, AppError> {
        let mut rand_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut rand_bytes);
        let mut ticket_hex = String::with_capacity(64);
        for b in rand_bytes {
            use std::fmt::Write;
            let _ = write!(&mut ticket_hex, "{:02x}", b);
        }
        let ticket = format!("gw_tkt_{}", ticket_hex);

        let expires_at = Utc::now() + Duration::seconds(60);

        sqlx::query!(
            r#"
            INSERT INTO gateway_auth_tickets (ticket, user_id, expires_at)
            VALUES ($1, $2, $3)
            "#,
            ticket,
            user_id,
            expires_at
        )
        .execute(&self.pool)
        .await?;

        Ok(ticket)
    }

    /// Consumes a single-use gateway ticket (deletes and returns user_id if valid)
    pub async fn consume_gateway_ticket(&self, ticket: &str) -> Result<Option<Uuid>, AppError> {
        let user_id = sqlx::query_scalar!(
            r#"
            DELETE FROM gateway_auth_tickets
            WHERE ticket = $1 AND expires_at > NOW()
            RETURNING user_id
            "#,
            ticket
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(user_id)
    }
}
