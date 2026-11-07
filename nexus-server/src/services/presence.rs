use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::sync::{mpsc, RwLock};
use tracing::{info, warn};
use uuid::Uuid;

use crate::models::{FriendDto, GatewayEvent};
use crate::repositories::FriendRepository;

pub const MAX_CONNECTIONS_PER_USER: usize = 10;

#[derive(Debug, Clone)]
pub struct LivePresence {
    pub preferred_status: String,
    pub status: String,
    pub custom_status: Option<String>,
    pub activity: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Clone)]
pub struct PresenceManager {
    // user_id -> (connection_id -> sender)
    connections: Arc<RwLock<HashMap<Uuid, HashMap<Uuid, mpsc::UnboundedSender<GatewayEvent>>>>>,
    // user_id -> current live presence
    live_presence: Arc<RwLock<HashMap<Uuid, LivePresence>>>,
    friend_repo: FriendRepository,
}

impl PresenceManager {
    pub fn new(friend_repo: FriendRepository) -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            live_presence: Arc::new(RwLock::new(HashMap::new())),
            friend_repo,
        }
    }

    /// Register new WebSocket connection for a user.
    /// Returns `Result<(is_first_connection, friend_ids, effective_status), String>`
    pub async fn register_connection(
        &self,
        user_id: Uuid,
        connection_id: Uuid,
        tx: mpsc::UnboundedSender<GatewayEvent>,
    ) -> Result<(bool, Vec<Uuid>, String), String> {
        let mut conns = self.connections.write().await;
        let user_conns = conns.entry(user_id).or_default();

        if user_conns.len() >= MAX_CONNECTIONS_PER_USER {
            return Err("Limite de conexões simultâneas atingido.".to_string());
        }

        let was_empty = user_conns.is_empty();
        user_conns.insert(connection_id, tx);

        if was_empty {
            // Retrieve preferred status from database
            let pref = self.friend_repo.get_presence(user_id).await.ok();
            let preferred_status = pref
                .as_ref()
                .map(|p| p.preferred_status.clone())
                .unwrap_or_else(|| "online".to_string());
            let custom_status = pref.as_ref().and_then(|p| p.custom_status.clone());
            let activity = pref.as_ref().and_then(|p| p.activity.clone());

            let effective_status = if preferred_status == "invisible" {
                "offline".to_string()
            } else {
                preferred_status.clone()
            };

            let mut presences = self.live_presence.write().await;
            presences.insert(
                user_id,
                LivePresence {
                    preferred_status: preferred_status.clone(),
                    status: effective_status.clone(),
                    custom_status: custom_status.clone(),
                    activity: activity.clone(),
                    last_seen_at: Some(Utc::now()),
                },
            );

            // If user is invisible, we do NOT broadcast presence to friends
            let friend_ids = if preferred_status == "invisible" {
                Vec::new()
            } else {
                self.friend_repo
                    .get_friend_ids(user_id)
                    .await
                    .unwrap_or_default()
            };

            Ok((true, friend_ids, effective_status))
        } else {
            let presences = self.live_presence.read().await;
            let effective_status = presences
                .get(&user_id)
                .map(|p| p.status.clone())
                .unwrap_or_else(|| "online".to_string());
            Ok((false, Vec::new(), effective_status))
        }
    }

    /// Unregister a WebSocket connection.
    /// Returns `(is_now_offline, friend_ids)`
    pub async fn unregister_connection(
        &self,
        user_id: Uuid,
        connection_id: Uuid,
    ) -> (bool, Vec<Uuid>) {
        let mut conns = self.connections.write().await;
        let mut is_now_offline = false;

        if let Some(user_conns) = conns.get_mut(&user_id) {
            user_conns.remove(&connection_id);
            if user_conns.is_empty() {
                conns.remove(&user_id);
                is_now_offline = true;
            }
        }

        if is_now_offline {
            let mut presences = self.live_presence.write().await;
            let now = Utc::now();
            let was_invisible = presences
                .get(&user_id)
                .map(|p| p.preferred_status == "invisible")
                .unwrap_or(false);

            if let Some(presence) = presences.get_mut(&user_id) {
                presence.status = "offline".to_string();
                presence.last_seen_at = Some(now);
            }

            // Update persistent database status
            let _ = self
                .friend_repo
                .update_presence(user_id, Some("offline"), None, None, None)
                .await;

            // If user was invisible, friends already saw them as offline, so no need to broadcast
            if was_invisible {
                (true, Vec::new())
            } else {
                let friend_ids = self
                    .friend_repo
                    .get_friend_ids(user_id)
                    .await
                    .unwrap_or_default();
                (true, friend_ids)
            }
        } else {
            (false, Vec::new())
        }
    }

    /// Update user presence and return friend IDs for broadcasting
    pub async fn update_user_presence(
        &self,
        user_id: Uuid,
        status: &str,
        custom_status: Option<&str>,
        activity: Option<&str>,
    ) -> (String, Vec<Uuid>) {
        let now = Utc::now();
        let effective_status = if status == "invisible" {
            "offline".to_string()
        } else {
            status.to_string()
        };

        {
            let mut presences = self.live_presence.write().await;
            presences.insert(
                user_id,
                LivePresence {
                    preferred_status: status.to_string(),
                    status: effective_status.clone(),
                    custom_status: custom_status.map(|s| s.to_string()),
                    activity: activity.map(|s| s.to_string()),
                    last_seen_at: Some(now),
                },
            );
        }

        let _ = self
            .friend_repo
            .update_presence(user_id, Some(status), custom_status, activity, None)
            .await;

        let friend_ids = self
            .friend_repo
            .get_friend_ids(user_id)
            .await
            .unwrap_or_default();

        (effective_status, friend_ids)
    }

    /// Overlay live in-memory presence on friend list
    pub async fn enrich_friends_presence(&self, friends: &mut [FriendDto]) {
        let presences = self.live_presence.read().await;
        for friend in friends.iter_mut() {
            if let Some(live) = presences.get(&friend.id) {
                // If friend chose "invisible", to others they are "offline"
                if live.preferred_status == "invisible" {
                    friend.status = "offline".to_string();
                } else {
                    friend.status = live.status.clone();
                    if live.custom_status.is_some() {
                        friend.custom_status = live.custom_status.clone();
                    }
                    if live.activity.is_some() {
                        friend.activity = live.activity.clone();
                    }
                    if live.last_seen_at.is_some() {
                        friend.last_seen_at = live.last_seen_at;
                    }
                }
            }
        }
    }

    /// Send event to all active connections of a specific user
    pub async fn send_to_user(&self, target_user_id: Uuid, event: &GatewayEvent) {
        let conns = self.connections.read().await;
        if let Some(user_conns) = conns.get(&target_user_id) {
            info!(
                "[Gateway] Despachando evento '{}' para usuário {} em {} conexões ativas.",
                event.event_type, target_user_id, user_conns.len()
            );
            for sender in user_conns.values() {
                let _ = sender.send(event.clone());
            }
        } else {
            warn!(
                "[Gateway] ATENÇÃO: Falha ao entregar evento '{}'. Usuário {} não possui conexões ativas no Gateway!",
                event.event_type, target_user_id
            );
        }
    }

    /// Broadcast event to a list of friend IDs
    pub async fn broadcast_to_friends(&self, friend_ids: &[Uuid], event: &GatewayEvent) {
        let conns = self.connections.read().await;
        for friend_id in friend_ids {
            if let Some(user_conns) = conns.get(friend_id) {
                for sender in user_conns.values() {
                    let _ = sender.send(event.clone());
                }
            }
        }
    }

    /// Check if a user has any active connections
    pub async fn is_user_connected(&self, user_id: Uuid) -> bool {
        let conns = self.connections.read().await;
        conns.contains_key(&user_id)
    }

    /// Get current total number of active connections across all users
    pub async fn total_connections(&self) -> usize {
        let conns = self.connections.read().await;
        conns.values().map(|m| m.len()).sum()
    }
}
