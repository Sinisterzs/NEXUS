use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::{
    FriendDto, FriendRequestDto, FriendRequestsResponse, GatewayEvent, PresenceResponse,
    UserSearchDto,
};
use crate::repositories::FriendRepository;
use crate::services::presence::PresenceManager;

#[derive(Clone)]
pub struct FriendService {
    repo: FriendRepository,
    presence_mgr: PresenceManager,
}

impl FriendService {
    pub fn new(repo: FriendRepository, presence_mgr: PresenceManager) -> Self {
        Self { repo, presence_mgr }
    }

    pub fn presence_manager(&self) -> &PresenceManager {
        &self.presence_mgr
    }

    pub fn friend_repository(&self) -> &FriendRepository {
        &self.repo
    }

    /// List friends with live presence applied
    pub async fn get_friends(&self, user_id: Uuid) -> Result<Vec<FriendDto>, AppError> {
        let mut friends = self.repo.get_friends(user_id).await?;
        self.presence_mgr.enrich_friends_presence(&mut friends).await;
        Ok(friends)
    }

    /// List pending friend requests
    pub async fn get_requests(&self, user_id: Uuid) -> Result<FriendRequestsResponse, AppError> {
        self.repo.get_requests(user_id).await
    }

    /// Send a friend request
    pub async fn send_request(
        &self,
        sender_id: Uuid,
        target: &str,
    ) -> Result<FriendRequestDto, AppError> {
        let (req_dto, auto_accepted, maybe_friend, receiver_id) =
            self.repo.send_request(sender_id, target).await?;

        if auto_accepted {
            if let Some(friend_dto) = maybe_friend {
                // Notify sender
                let event = GatewayEvent::new(
                    "friend.request.accepted",
                    json!({ "friend": friend_dto }),
                );
                self.presence_mgr.send_to_user(sender_id, &event).await;

                // Notify receiver with sender's info
                if let Ok(Some(sender_dto)) = self.repo.get_friend_dto(sender_id).await {
                    let event = GatewayEvent::new(
                        "friend.request.accepted",
                        json!({ "friend": sender_dto }),
                    );
                    self.presence_mgr.send_to_user(receiver_id, &event).await;
                }
            }
        } else {
            // Push notification to receiver via WebSocket
            let sender_dto = self.repo.get_friend_dto(sender_id).await?;
            if let Some(sender) = sender_dto {
                let incoming_dto = FriendRequestDto {
                    id: req_dto.id,
                    user_id: sender_id,
                    username: sender.username,
                    tag: sender.tag,
                    display_name: sender.display_name,
                    avatar_url: sender.avatar_url,
                    status: sender.status,
                    created_at: req_dto.created_at,
                };
                let event = GatewayEvent::new(
                    "friend.request.received",
                    json!({ "request": incoming_dto }),
                );
                self.presence_mgr.send_to_user(receiver_id, &event).await;
            }
        }

        Ok(req_dto)
    }

    /// Accept friend request
    pub async fn accept_request(
        &self,
        request_id: Uuid,
        user_id: Uuid,
    ) -> Result<FriendDto, AppError> {
        let (sender_dto, receiver_dto, sender_id) =
            self.repo.accept_request(request_id, user_id).await?;

        // Notify sender via WebSocket that request was accepted
        let event_for_sender = GatewayEvent::new(
            "friend.request.accepted",
            json!({ "friend": receiver_dto }),
        );
        self.presence_mgr.send_to_user(sender_id, &event_for_sender).await;

        // Notify receiver via WebSocket that friend was added
        let event_for_receiver = GatewayEvent::new(
            "friend.request.accepted",
            json!({ "friend": sender_dto.clone() }),
        );
        self.presence_mgr.send_to_user(user_id, &event_for_receiver).await;

        Ok(sender_dto)
    }

    /// Reject incoming friend request
    pub async fn reject_request(&self, request_id: Uuid, user_id: Uuid) -> Result<(), AppError> {
        let sender_id = self.repo.reject_request(request_id, user_id).await?;

        let event = GatewayEvent::new(
            "friend.request.rejected",
            json!({ "request_id": request_id }),
        );
        self.presence_mgr.send_to_user(sender_id, &event).await;

        Ok(())
    }

    /// Cancel outgoing friend request
    pub async fn cancel_request(&self, request_id: Uuid, user_id: Uuid) -> Result<(), AppError> {
        self.repo.cancel_request(request_id, user_id).await?;
        Ok(())
    }

    /// Remove a friend
    pub async fn remove_friend(&self, user_id: Uuid, friend_id: Uuid) -> Result<(), AppError> {
        self.repo.remove_friend(user_id, friend_id).await?;

        let event1 = GatewayEvent::new("friend.removed", json!({ "friend_id": friend_id }));
        let event2 = GatewayEvent::new("friend.removed", json!({ "friend_id": user_id }));

        self.presence_mgr.send_to_user(user_id, &event1).await;
        self.presence_mgr.send_to_user(friend_id, &event2).await;

        Ok(())
    }

    /// Block a user
    pub async fn block_user(&self, blocker_id: Uuid, blocked_id: Uuid) -> Result<(), AppError> {
        self.repo.block_user(blocker_id, blocked_id).await?;

        let event_blocker = GatewayEvent::new("friend.blocked", json!({ "user_id": blocked_id }));
        let event_removed_1 = GatewayEvent::new("friend.removed", json!({ "friend_id": blocked_id }));
        let event_removed_2 = GatewayEvent::new("friend.removed", json!({ "friend_id": blocker_id }));

        self.presence_mgr.send_to_user(blocker_id, &event_blocker).await;
        self.presence_mgr.send_to_user(blocker_id, &event_removed_1).await;
        self.presence_mgr.send_to_user(blocked_id, &event_removed_2).await;

        Ok(())
    }

    /// Unblock a user
    pub async fn unblock_user(&self, blocker_id: Uuid, blocked_id: Uuid) -> Result<(), AppError> {
        self.repo.unblock_user(blocker_id, blocked_id).await
    }

    /// Search users
    pub async fn search_users(
        &self,
        current_user_id: Uuid,
        query: &str,
    ) -> Result<Vec<UserSearchDto>, AppError> {
        self.repo.search_users(current_user_id, query).await
    }

    /// Get user presence
    pub async fn get_presence(&self, user_id: Uuid) -> Result<PresenceResponse, AppError> {
        let mut presence = self.repo.get_presence(user_id).await?;
        let is_connected = self.presence_mgr.is_user_connected(user_id).await;
        if !is_connected || presence.preferred_status == "invisible" {
            presence.status = "offline".to_string();
        } else {
            presence.status = presence.preferred_status.clone();
        }
        Ok(presence)
    }

    /// Update user presence status and broadcast to friends
    pub async fn update_presence(
        &self,
        user_id: Uuid,
        preferred_status: Option<&str>,
        custom_status: Option<&str>,
        activity: Option<&str>,
        allow_friend_requests: Option<bool>,
    ) -> Result<PresenceResponse, AppError> {
        let mut presence = self
            .repo
            .update_presence(
                user_id,
                preferred_status,
                custom_status,
                activity,
                allow_friend_requests,
            )
            .await?;

        let is_connected = self.presence_mgr.is_user_connected(user_id).await;
        if !is_connected {
            let _ = self.repo.set_connectivity_status(user_id, "offline").await;
            presence.status = "offline".to_string();
        }

        let (effective_status, friend_ids) = if let Some(pref) = preferred_status {
            self.presence_mgr
                .update_user_presence(user_id, pref, custom_status, activity)
                .await
        } else {
            let eff = if !is_connected || presence.preferred_status == "invisible" {
                "offline".to_string()
            } else {
                presence.preferred_status.clone()
            };
            (eff, self.repo.get_friend_ids(user_id).await.unwrap_or_default())
        };

        // Only broadcast presence updates to friends when the user is actively connected to the Gateway
        if is_connected {
            let broadcast_status = if presence.preferred_status == "invisible" {
                "offline"
            } else {
                &effective_status
            };

            let event = GatewayEvent::new(
                "presence.updated",
                json!({
                    "user_id": user_id,
                    "status": broadcast_status,
                    "custom_status": presence.custom_status,
                    "activity": presence.activity,
                    "last_seen_at": Utc::now(),
                }),
            );

            self.presence_mgr.broadcast_to_friends(&friend_ids, &event).await;
        }

        Ok(presence)
    }
}
