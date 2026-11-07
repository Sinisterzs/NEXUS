use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use uuid::Uuid;
use validator::Validate;

use crate::errors::AppError;
use crate::middleware::{CurrentSessionId, CurrentUser};
use crate::models::{
    CreateConversationRequest, DirectConversationDto, DirectMessageDto, EditMessageRequest,
    GatewayTicketResponse, MarkDeliveredRequest, MarkReadRequest, SendMessageRequest,
};
use crate::services::DmService;

#[derive(Debug, Deserialize)]
pub struct ListMessagesQuery {
    pub before_id: Option<Uuid>,
    pub limit: Option<i64>,
}

/// GET /v1/dm/conversations - List DM conversations with other users
pub async fn list_conversations(
    State(dm_service): State<DmService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
) -> Result<Json<Vec<DirectConversationDto>>, AppError> {
    let convs = dm_service.list_conversations(auth_user.id).await?;
    Ok(Json(convs))
}

/// POST /v1/dm/conversations - Find or create conversation with user
pub async fn create_conversation(
    State(dm_service): State<DmService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Json(payload): Json<CreateConversationRequest>,
) -> Result<Json<DirectConversationDto>, AppError> {
    let conv = dm_service
        .get_or_create_conversation(auth_user.id, payload.target_user_id, payload.username)
        .await?;
    Ok(Json(conv))
}

/// GET /v1/dm/conversations/:id/messages - Paginated message history
pub async fn list_messages(
    State(dm_service): State<DmService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(conv_id): Path<Uuid>,
    Query(params): Query<ListMessagesQuery>,
) -> Result<Json<Vec<DirectMessageDto>>, AppError> {
    let limit = params.limit.unwrap_or(50);
    let messages = dm_service
        .list_messages(conv_id, auth_user.id, params.before_id, limit)
        .await?;
    Ok(Json(messages))
}

/// POST /v1/dm/conversations/:id/messages - Send message with idempotency key
pub async fn send_message(
    State(dm_service): State<DmService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(conv_id): Path<Uuid>,
    Json(payload): Json<SendMessageRequest>,
) -> Result<Json<DirectMessageDto>, AppError> {
    payload.validate().map_err(|e| AppError::BadRequest(e.to_string()))?;

    let msg = dm_service
        .send_message(
            conv_id,
            auth_user.id,
            payload.client_message_id,
            &payload.content,
        )
        .await?;
    Ok(Json(msg))
}

/// PATCH /v1/dm/messages/:id - Edit own message
pub async fn edit_message(
    State(dm_service): State<DmService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(message_id): Path<Uuid>,
    Json(payload): Json<EditMessageRequest>,
) -> Result<Json<DirectMessageDto>, AppError> {
    payload.validate().map_err(|e| AppError::BadRequest(e.to_string()))?;

    let edited = dm_service
        .edit_message(message_id, auth_user.id, &payload.content)
        .await?;
    Ok(Json(edited))
}

/// DELETE /v1/dm/messages/:id - Soft-delete own message
pub async fn delete_message(
    State(dm_service): State<DmService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(message_id): Path<Uuid>,
) -> Result<Json<DirectMessageDto>, AppError> {
    let deleted = dm_service.delete_message(message_id, auth_user.id).await?;
    Ok(Json(deleted))
}

/// POST /v1/dm/conversations/:id/read - Mark conversation as read
pub async fn mark_read(
    State(dm_service): State<DmService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(conv_id): Path<Uuid>,
    Json(payload): Json<Option<MarkReadRequest>>,
) -> Result<Json<serde_json::Value>, AppError> {
    let last_id = payload.and_then(|p| p.last_read_message_id);
    dm_service.mark_read(conv_id, auth_user.id, last_id).await?;
    Ok(Json(serde_json::json!({ "success": true })))
}

/// POST /v1/dm/conversations/:id/delivered - Mark delivered messages
pub async fn mark_delivered(
    State(dm_service): State<DmService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Path(_conv_id): Path<Uuid>,
    Json(payload): Json<MarkDeliveredRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    dm_service.mark_delivered(auth_user.id, &payload.message_ids).await?;
    Ok(Json(serde_json::json!({ "success": true })))
}

/// POST /v1/gateway/ticket - Generate short-lived ticket for WebSocket handshake
pub async fn create_gateway_ticket(
    State(dm_service): State<DmService>,
    Extension(CurrentUser(auth_user)): Extension<CurrentUser>,
    Extension(CurrentSessionId(session_id)): Extension<CurrentSessionId>,
) -> Result<Json<GatewayTicketResponse>, AppError> {
    let ticket = dm_service.create_gateway_ticket(auth_user.id).await?;
    dm_service
        .presence_manager()
        .bind_ticket_to_session(&ticket, session_id)
        .await;
    Ok(Json(GatewayTicketResponse {
        ticket,
        expires_in_secs: 60,
    }))
}
