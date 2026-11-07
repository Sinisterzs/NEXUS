use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::{
    DirectConversationDto, DirectMessageDto, GatewayEvent,
};
use crate::repositories::{DmRepository, FriendRepository, UserRepository};
use crate::services::presence::PresenceManager;

#[derive(Clone)]
pub struct DmService {
    dm_repo: DmRepository,
    friend_repo: FriendRepository,
    user_repo: UserRepository,
    presence_mgr: PresenceManager,
}

impl DmService {
    pub fn new(
        dm_repo: DmRepository,
        friend_repo: FriendRepository,
        user_repo: UserRepository,
        presence_mgr: PresenceManager,
    ) -> Self {
        Self {
            dm_repo,
            friend_repo,
            user_repo,
            presence_mgr,
        }
    }

    pub fn dm_repo(&self) -> &DmRepository {
        &self.dm_repo
    }

    pub fn presence_manager(&self) -> &PresenceManager {
        &self.presence_mgr
    }

    /// List conversations for the given user, enriched with live presence
    pub async fn list_conversations(
        &self,
        user_id: Uuid,
    ) -> Result<Vec<DirectConversationDto>, AppError> {
        let mut convs = self.dm_repo.list_conversations(user_id).await?;

        // Enrich the other user presence
        let mut friends_dto: Vec<_> = convs.iter().map(|c| c.other_user.clone()).collect();
        self.presence_mgr.enrich_friends_presence(&mut friends_dto).await;

        for (c, f) in convs.iter_mut().zip(friends_dto.into_iter()) {
            c.other_user = f;
        }

        Ok(convs)
    }

    /// Finds or creates a DM conversation with a target user (by target_user_id or username)
    pub async fn get_or_create_conversation(
        &self,
        user_id: Uuid,
        target_user_id: Option<Uuid>,
        username: Option<String>,
    ) -> Result<DirectConversationDto, AppError> {
        let target_id = if let Some(t_id) = target_user_id {
            t_id
        } else if let Some(name) = username {
            let found = self.user_repo.find_by_login(&name).await?;
            match found {
                Some((u, _, _)) => u.id,
                None => return Err(AppError::NotFound("Usuário não encontrado.".into())),
            }
        } else {
            return Err(AppError::BadRequest("Destinatário não informado.".into()));
        };

        if target_id == user_id {
            return Err(AppError::BadRequest("Não é possível criar conversa consigo mesmo.".into()));
        }

        // Check if either user is blocked
        if self.friend_repo.is_blocked(user_id, target_id).await? {
            return Err(AppError::Forbidden("Não é possível iniciar conversa com um usuário bloqueado.".into()));
        }

        let conv = self.dm_repo.get_or_create_conversation(user_id, target_id).await?;

        // Retrieve other user's FriendDto
        let mut other_friend = self.friend_repo.get_friend_dto(target_id).await?
            .ok_or_else(|| AppError::NotFound("Perfil do destinatário não encontrado.".into()))?;
        let mut slice = [other_friend];
        self.presence_mgr.enrich_friends_presence(&mut slice).await;
        other_friend = slice[0].clone();

        let last_message = self.dm_repo.get_latest_message(conv.id, user_id).await?;

        // Count unread
        let unread_count: i64 = sqlx::query_scalar!(
            r#"
            SELECT COUNT(*)::bigint
            FROM direct_messages dm
            JOIN direct_message_receipts r ON dm.id = r.message_id
            WHERE dm.conversation_id = $1
              AND r.user_id = $2
              AND r.read_at IS NULL
              AND dm.deleted_at IS NULL
            "#,
            conv.id,
            user_id
        )
        .fetch_one(self.dm_repo.pool())
        .await?
        .unwrap_or(0);

        Ok(DirectConversationDto {
            id: conv.id,
            other_user: other_friend,
            last_message,
            unread_count,
            created_at: conv.created_at,
            updated_at: conv.updated_at,
        })
    }

    /// List messages in conversation with keyset pagination
    pub async fn list_messages(
        &self,
        conv_id: Uuid,
        user_id: Uuid,
        before_id: Option<Uuid>,
        limit: i64,
    ) -> Result<Vec<DirectMessageDto>, AppError> {
        if !self.dm_repo.is_participant(conv_id, user_id).await? {
            return Err(AppError::Forbidden("Você não tem acesso a esta conversa.".into()));
        }

        if let Some(other_id) = self.dm_repo.get_other_participant(conv_id, user_id).await? {
            if self.friend_repo.is_blocked(user_id, other_id).await? {
                return Err(AppError::Forbidden("Conversa inacessível devido a bloqueio mútuo.".into()));
            }
        }

        self.dm_repo.list_messages_cursor(conv_id, user_id, before_id, limit).await
    }

    /// Send a message in a conversation.
    /// Requires active friendship and no blocking.
    pub async fn send_message(
        &self,
        conv_id: Uuid,
        sender_id: Uuid,
        client_message_id: Uuid,
        raw_content: &str,
    ) -> Result<DirectMessageDto, AppError> {
        let trimmed = raw_content.trim();
        if trimmed.is_empty() {
            return Err(AppError::BadRequest("A mensagem não pode estar vazia.".into()));
        }
        if trimmed.chars().count() > 2000 {
            return Err(AppError::BadRequest("A mensagem não pode ter mais de 2000 caracteres.".into()));
        }

        if !self.dm_repo.is_participant(conv_id, sender_id).await? {
            return Err(AppError::Forbidden("Você não tem acesso a esta conversa.".into()));
        }

        let recipient_id = self.dm_repo.get_other_participant(conv_id, sender_id).await?
            .ok_or_else(|| AppError::BadRequest("Conversa inválida ou sem participante.".into()))?;

        // 1. Block check
        if self.friend_repo.is_blocked(sender_id, recipient_id).await? {
            return Err(AppError::Forbidden("Não é possível enviar mensagens para um usuário bloqueado.".into()));
        }

        // 2. Friendship check: Must be active friends to send new messages
        if !self.friend_repo.is_friend(sender_id, recipient_id).await? {
            return Err(AppError::Forbidden("É necessário ter uma amizade ativa para enviar mensagens.".into()));
        }

        // 3. Save message idempotently
        let (mut msg_dto, is_new) = self.dm_repo.save_message(
            conv_id,
            sender_id,
            recipient_id,
            client_message_id,
            trimmed,
        ).await?;

        if is_new {
            // Check if recipient is online in Gateway
            let is_recipient_online = self.presence_mgr.is_user_connected(recipient_id).await;
            if is_recipient_online {
                let _ = self.dm_repo.mark_messages_delivered(recipient_id, &[msg_dto.id]).await;
                msg_dto.delivered_at = Some(Utc::now());
            }

            // Emit to recipient
            let mut recipient_msg = msg_dto.clone();
            recipient_msg.is_mine = false;
            let recv_ev = GatewayEvent::new("dm.message.created", json!({ "message": recipient_msg }));
            self.presence_mgr.send_to_user(recipient_id, &recv_ev).await;

            // Emit to sender's other sessions
            let sender_ev = GatewayEvent::new("dm.message.created", json!({ "message": msg_dto }));
            self.presence_mgr.send_to_user(sender_id, &sender_ev).await;

            // If recipient is online, notify sender that message was delivered
            if msg_dto.delivered_at.is_some() {
                let deliv_ev = GatewayEvent::new(
                    "dm.message.delivered",
                    json!({
                        "conversation_id": conv_id,
                        "message_ids": [msg_dto.id],
                        "delivered_at": msg_dto.delivered_at,
                    }),
                );
                self.presence_mgr.send_to_user(sender_id, &deliv_ev).await;
            }

            // Emit conversation update
            let conv_update_recipient = GatewayEvent::new(
                "dm.conversation.updated",
                json!({
                    "conversation_id": conv_id,
                    "last_message": recipient_msg,
                }),
            );
            self.presence_mgr.send_to_user(recipient_id, &conv_update_recipient).await;

            let conv_update_sender = GatewayEvent::new(
                "dm.conversation.updated",
                json!({
                    "conversation_id": conv_id,
                    "last_message": msg_dto,
                }),
            );
            self.presence_mgr.send_to_user(sender_id, &conv_update_sender).await;
        }

        Ok(msg_dto)
    }

    /// Edits own message (requires active friendship and no blocking)
    pub async fn edit_message(
        &self,
        message_id: Uuid,
        user_id: Uuid,
        raw_content: &str,
    ) -> Result<DirectMessageDto, AppError> {
        let trimmed = raw_content.trim();
        if trimmed.is_empty() {
            return Err(AppError::BadRequest("A mensagem não pode estar vazia.".into()));
        }
        if trimmed.chars().count() > 2000 {
            return Err(AppError::BadRequest("A mensagem não pode ter mais de 2000 caracteres.".into()));
        }

        let existing = self
            .dm_repo
            .get_message_by_id(message_id, user_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Mensagem não encontrada.".into()))?;

        if existing.sender_id != user_id {
            return Err(AppError::Forbidden(
                "Você só pode editar mensagens de sua autoria.".into(),
            ));
        }

        let other_id = self
            .dm_repo
            .get_other_participant(existing.conversation_id, user_id)
            .await?
            .ok_or_else(|| AppError::BadRequest("Conversa inválida ou sem participante.".into()))?;

        if self.friend_repo.is_blocked(user_id, other_id).await? {
            return Err(AppError::Forbidden(
                "Não é possível editar mensagens para um usuário bloqueado.".into(),
            ));
        }

        if !self.friend_repo.is_friend(user_id, other_id).await? {
            return Err(AppError::Forbidden(
                "É necessário ter uma amizade ativa para editar mensagens.".into(),
            ));
        }

        let edited = self.dm_repo.edit_message(message_id, user_id, trimmed).await?;

        // Notify both participants
        let mut other_msg = edited.clone();
        other_msg.is_mine = false;
        let other_ev = GatewayEvent::new("dm.message.updated", json!({ "message": other_msg }));
        self.presence_mgr.send_to_user(other_id, &other_ev).await;

        let self_ev = GatewayEvent::new("dm.message.updated", json!({ "message": edited }));
        self.presence_mgr.send_to_user(user_id, &self_ev).await;

        Ok(edited)
    }

    /// Soft-deletes own message
    pub async fn delete_message(
        &self,
        message_id: Uuid,
        user_id: Uuid,
    ) -> Result<DirectMessageDto, AppError> {
        let deleted = self.dm_repo.delete_message(message_id, user_id).await?;

        let ev_payload = json!({
            "id": deleted.id,
            "conversation_id": deleted.conversation_id,
            "deleted_at": deleted.deleted_at,
        });

        if let Some(other_id) = self.dm_repo.get_other_participant(deleted.conversation_id, user_id).await? {
            let other_ev = GatewayEvent::new("dm.message.deleted", ev_payload.clone());
            self.presence_mgr.send_to_user(other_id, &other_ev).await;
        }

        let self_ev = GatewayEvent::new("dm.message.deleted", ev_payload);
        self.presence_mgr.send_to_user(user_id, &self_ev).await;

        Ok(deleted)
    }

    /// Mark conversation as read
    pub async fn mark_read(
        &self,
        conv_id: Uuid,
        user_id: Uuid,
        last_read_message_id: Option<Uuid>,
    ) -> Result<(), AppError> {
        if !self.dm_repo.is_participant(conv_id, user_id).await? {
            return Err(AppError::Forbidden("Você não tem acesso a esta conversa.".into()));
        }

        let marked_ids = self.dm_repo.mark_conversation_read(conv_id, user_id, last_read_message_id).await?;

        if !marked_ids.is_empty() {
            if let Some(other_id) = self.dm_repo.get_other_participant(conv_id, user_id).await? {
                let ev = GatewayEvent::new(
                    "dm.message.read",
                    json!({
                        "conversation_id": conv_id,
                        "reader_id": user_id,
                        "message_ids": marked_ids,
                        "last_read_message_id": last_read_message_id,
                        "read_at": Utc::now(),
                    }),
                );
                self.presence_mgr.send_to_user(other_id, &ev).await;
            }
        }

        Ok(())
    }

    /// Mark specific messages as delivered
    pub async fn mark_delivered(
        &self,
        user_id: Uuid,
        message_ids: &[Uuid],
    ) -> Result<(), AppError> {
        let delivered_pairs = self.dm_repo.mark_messages_delivered(user_id, message_ids).await?;

        for (conv_id, msg_id) in delivered_pairs {
            if let Some(other_id) = self.dm_repo.get_other_participant(conv_id, user_id).await? {
                let ev = GatewayEvent::new(
                    "dm.message.delivered",
                    json!({
                        "conversation_id": conv_id,
                        "message_ids": [msg_id],
                        "delivered_at": Utc::now(),
                    }),
                );
                self.presence_mgr.send_to_user(other_id, &ev).await;
            }
        }

        Ok(())
    }

    /// Create ephemeral gateway ticket
    pub async fn create_gateway_ticket(&self, user_id: Uuid) -> Result<String, AppError> {
        self.dm_repo.create_gateway_ticket(user_id).await
    }

    /// Validate and consume gateway ticket
    pub async fn consume_gateway_ticket(&self, ticket: &str) -> Result<Option<Uuid>, AppError> {
        self.dm_repo.consume_gateway_ticket(ticket).await
    }
}
