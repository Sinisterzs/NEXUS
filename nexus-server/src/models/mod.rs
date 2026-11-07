use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

// ==========================================
// Database Models
// ==========================================

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct UserProfile {
    pub user_id: Uuid,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct UserCredentials {
    pub user_id: Uuid,
    pub email: String,
    pub password_hash: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Session {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token_hash: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct UserOAuthAccount {
    pub id: Uuid,
    pub user_id: Uuid,
    pub provider: String,
    pub provider_subject: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ==========================================
// Request DTOs
// ==========================================

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct RegisterRequest {
    #[validate(length(min = 3, max = 32, message = "O nome de usuário deve ter entre 3 e 32 caracteres."))]
    pub username: String,

    #[validate(email(message = "O e-mail informado é inválido."))]
    pub email: String,

    #[validate(length(min = 8, max = 128, message = "A senha deve ter no mínimo 8 caracteres."))]
    pub password: String,

    #[validate(length(max = 64, message = "O nome de exibição deve ter no máximo 64 caracteres."))]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct LoginRequest {
    #[validate(length(min = 1, message = "O usuário ou e-mail é obrigatório."))]
    pub login: String,

    #[validate(length(min = 1, message = "A senha é obrigatória."))]
    pub password: String,
}

// Response DTOs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfileResponse {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub status: String,
    pub custom_status: Option<String>,
    pub activity: Option<String>,
    pub has_password: bool,
    pub has_google: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct UpdateProfileRequest {
    #[validate(length(min = 3, max = 32, message = "O nome de usuário deve ter entre 3 e 32 caracteres."))]
    pub username: Option<String>,

    #[validate(length(min = 1, max = 64, message = "O nome de exibição deve ter entre 1 e 64 caracteres."))]
    pub display_name: Option<String>,

    #[validate(length(max = 300, message = "A biografia deve ter no máximo 300 caracteres."))]
    pub bio: Option<String>,

    #[validate(length(max = 120, message = "O status personalizado deve ter no máximo 120 caracteres."))]
    pub custom_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub user: UserProfileResponse,
    pub session_token: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshResponse {
    pub session_token: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageResponse {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub timestamp: DateTime<Utc>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleAuthRequest {
    pub id_token: Option<String>,
    pub code: Option<String>,
    pub code_verifier: Option<String>,
    pub redirect_uri: Option<String>,
    pub nonce: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleLinkRequest {
    pub id_token: Option<String>,
    pub code: Option<String>,
    pub code_verifier: Option<String>,
    pub redirect_uri: Option<String>,
    pub nonce: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleLinkResponse {
    pub message: String,
    pub provider: String,
    pub provider_subject: String,
}

// ==========================================
// Friend & Social Models (Phase 2.2)
// ==========================================

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Friendship {
    pub id: Uuid,
    pub user_a_id: Uuid,
    pub user_b_id: Uuid,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct FriendRequest {
    pub id: Uuid,
    pub sender_id: Uuid,
    pub receiver_id: Uuid,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct UserBlock {
    pub id: Uuid,
    pub blocker_id: Uuid,
    pub blocked_id: Uuid,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct UserPresencePreference {
    pub user_id: Uuid,
    pub preferred_status: String,
    pub allow_friend_requests: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendDto {
    pub id: Uuid,
    pub username: String,
    pub tag: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub status: String, // "online" | "idle" | "dnd" | "invisible" | "offline"
    pub custom_status: Option<String>,
    pub activity: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendRequestDto {
    pub id: Uuid,
    pub user_id: Uuid, // The other party's user id
    pub username: String,
    pub tag: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendRequestsResponse {
    pub incoming: Vec<FriendRequestDto>,
    pub outgoing: Vec<FriendRequestDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct SendFriendRequest {
    #[validate(length(min = 1, max = 255, message = "O identificador do usuário é obrigatório."))]
    pub username: Option<String>,
    pub target: Option<String>,
}

impl SendFriendRequest {
    pub fn get_target(&self) -> &str {
        if let Some(ref u) = self.username {
            u.trim()
        } else if let Some(ref t) = self.target {
            t.trim()
        } else {
            ""
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct UpdatePresenceRequest {
    pub preferred_status: Option<String>,
    pub status: Option<String>,
    pub custom_status: Option<String>,
    pub activity: Option<String>,
    pub allow_friend_requests: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceResponse {
    pub user_id: Uuid,
    pub status: String,
    pub preferred_status: String,
    pub custom_status: Option<String>,
    pub activity: Option<String>,
    pub allow_friend_requests: bool,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSearchDto {
    pub id: Uuid,
    pub username: String,
    pub tag: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub is_friend: bool,
    pub has_pending_request: bool,
    pub is_blocked: bool,
}

// ==========================================
// Gateway Protocol Events & Messages (Phase 2.2)
// ==========================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayEvent {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub event_type: String,
    pub version: String,
    pub payload: serde_json::Value,
}

impl GatewayEvent {
    pub fn new(event_type: &str, payload: serde_json::Value) -> Self {
        Self {
            id: Uuid::new_v4(),
            event_type: event_type.to_string(),
            version: "1.0".to_string(),
            payload,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum GatewayClientMessage {
    #[serde(rename = "authenticate")]
    Authenticate {
        token: Option<String>,
        ticket: Option<String>,
    },
    #[serde(rename = "set_presence")]
    SetPresence {
        status: String,
        custom_status: Option<String>,
        activity: Option<String>,
    },
    #[serde(rename = "dm.delivery_ack")]
    DmDeliveryAck {
        message_ids: Vec<Uuid>,
    },
    #[serde(rename = "dm.read_ack")]
    DmReadAck {
        conversation_id: Uuid,
        last_message_id: Option<Uuid>,
    },
    #[serde(rename = "ping")]
    Ping,
    // Phase 2.4: Call Signaling
    #[serde(rename = "call.invite")]
    CallInvite {
        target_user_id: Uuid,
    },
    #[serde(rename = "call.accept")]
    CallAccept {
        call_id: Uuid,
    },
    #[serde(rename = "call.reject")]
    CallReject {
        call_id: Uuid,
        reason: Option<String>,
    },
    #[serde(rename = "call.cancel")]
    CallCancel {
        call_id: Uuid,
    },
    #[serde(rename = "call.end")]
    CallEnd {
        call_id: Uuid,
    },
    #[serde(rename = "call.mute")]
    CallMute {
        call_id: Uuid,
        is_muted: bool,
    },
    #[serde(rename = "call.webrtc.offer")]
    CallWebrtcOffer {
        call_id: Uuid,
        target_user_id: Uuid,
        sdp: String,
    },
    #[serde(rename = "call.webrtc.answer")]
    CallWebrtcAnswer {
        call_id: Uuid,
        target_user_id: Uuid,
        sdp: String,
    },
    #[serde(rename = "call.webrtc.ice_candidate")]
    CallWebrtcIceCandidate {
        call_id: Uuid,
        target_user_id: Uuid,
        candidate: serde_json::Value,
    },
}

// ==========================================
// Phase 2.4: Voice Calls Models
// ==========================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallStatus {
    Ringing,
    Active,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallSession {
    pub id: Uuid,
    pub caller_id: Uuid,
    pub callee_id: Uuid,
    pub status: CallStatus,
    pub caller_muted: bool,
    pub callee_muted: bool,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
}

// ==========================================
// Phase 2.3: Direct Messages (DM) Models
// ==========================================

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DirectConversation {
    pub id: Uuid,
    pub user_a_id: Uuid,
    pub user_b_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DirectMessage {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub sender_id: Uuid,
    pub client_message_id: Uuid,
    pub content: String,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DirectMessageReceipt {
    pub message_id: Uuid,
    pub user_id: Uuid,
    pub delivered_at: Option<DateTime<Utc>>,
    pub read_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DirectConversationState {
    pub conversation_id: Uuid,
    pub user_id: Uuid,
    pub last_read_message_id: Option<Uuid>,
    pub last_read_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectMessageDto {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub sender_id: Uuid,
    pub client_message_id: Uuid,
    pub content: String,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub delivered_at: Option<DateTime<Utc>>,
    pub read_at: Option<DateTime<Utc>>,
    pub is_mine: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectConversationDto {
    pub id: Uuid,
    pub other_user: FriendDto,
    pub last_message: Option<DirectMessageDto>,
    pub unread_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct SendMessageRequest {
    pub client_message_id: Uuid,
    #[validate(length(min = 1, max = 2000, message = "A mensagem deve ter entre 1 e 2000 caracteres."))]
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct EditMessageRequest {
    #[validate(length(min = 1, max = 2000, message = "A mensagem editada deve ter entre 1 e 2000 caracteres."))]
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateConversationRequest {
    pub target_user_id: Option<Uuid>,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkReadRequest {
    pub last_read_message_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkDeliveredRequest {
    pub message_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayTicketResponse {
    pub ticket: String,
    pub expires_in_secs: u64,
}

