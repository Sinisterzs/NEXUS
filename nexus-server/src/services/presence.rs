use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::sync::{mpsc, Notify, RwLock};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::models::{FriendDto, GatewayEvent};
use crate::repositories::FriendRepository;

pub const MAX_CONNECTIONS_PER_USER: usize = 10;
pub const GATEWAY_CRITICAL_QUEUE_CAPACITY: usize = 128;
pub const GATEWAY_EPHEMERAL_QUEUE_CAPACITY: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventPriority {
    /// Authoritative events that must never be silently dropped:
    /// call invites/accepts/ends/SDP/ICE, persisted DMs/receipts, friend mutations, session revocation, connection ready.
    Critical,
    /// Ephemeral events recoverable via synchronization:
    /// presence broadcasts, heartbeats (pong), mute indicators.
    Ephemeral,
}

pub fn classify_event_priority(event_type: &str) -> EventPriority {
    match event_type {
        "presence.updated" | "pong" | "call.participant_muted" => EventPriority::Ephemeral,
        _ => EventPriority::Critical,
    }
}

#[derive(Clone)]
pub struct ClientConnection {
    pub connection_id: Uuid,
    pub critical_tx: mpsc::Sender<GatewayEvent>,
    pub ephemeral_tx: mpsc::Sender<GatewayEvent>,
    pub slow_consumer_disconnect: Arc<Notify>,
}

impl ClientConnection {
    pub fn new(
        connection_id: Uuid,
        critical_tx: mpsc::Sender<GatewayEvent>,
        ephemeral_tx: mpsc::Sender<GatewayEvent>,
        slow_consumer_disconnect: Arc<Notify>,
    ) -> Self {
        Self {
            connection_id,
            critical_tx,
            ephemeral_tx,
            slow_consumer_disconnect,
        }
    }

    /// Enqueues an event according to its priority and backpressure policy.
    /// - Ephemeral events are shed if the ephemeral queue is full.
    /// - Critical events trigger a controlled slow-consumer disconnection if the critical queue is full,
    ///   never failing silently.
    pub fn try_enqueue(&self, user_id: Uuid, event: GatewayEvent) -> bool {
        match classify_event_priority(&event.event_type) {
            EventPriority::Critical => match self.critical_tx.try_send(event) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(dropped)) => {
                    warn!(
                        "[Gateway] Cliente lento detectado (fila crítica cheia, cap={}) para usuário {} [Conn: {}] ao enviar '{}'. Encerrando conexão para ressincronização.",
                        GATEWAY_CRITICAL_QUEUE_CAPACITY,
                        user_id,
                        self.connection_id,
                        dropped.event_type
                    );
                    self.slow_consumer_disconnect.notify_one();
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            },
            EventPriority::Ephemeral => match self.ephemeral_tx.try_send(event) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(dropped)) => {
                    debug!(
                        "[Gateway] Evento efêmero '{}' descartado por backpressure (cap={}) para usuário {} [Conn: {}].",
                        dropped.event_type,
                        GATEWAY_EPHEMERAL_QUEUE_CAPACITY,
                        user_id,
                        self.connection_id
                    );
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            },
        }
    }
}

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
    // user_id -> (connection_id -> ClientConnection)
    connections: Arc<RwLock<HashMap<Uuid, HashMap<Uuid, ClientConnection>>>>,
    // connection_id -> session_id
    connection_sessions: Arc<RwLock<HashMap<Uuid, Uuid>>>,
    // ticket -> session_id
    ticket_sessions: Arc<RwLock<HashMap<String, Uuid>>>,
    // user_id -> current live presence
    live_presence: Arc<RwLock<HashMap<Uuid, LivePresence>>>,
    friend_repo: FriendRepository,
}

impl PresenceManager {
    pub fn new(friend_repo: FriendRepository) -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            connection_sessions: Arc::new(RwLock::new(HashMap::new())),
            ticket_sessions: Arc::new(RwLock::new(HashMap::new())),
            live_presence: Arc::new(RwLock::new(HashMap::new())),
            friend_repo,
        }
    }

    pub async fn bind_ticket_to_session(&self, ticket: &str, session_id: Uuid) {
        let mut map = self.ticket_sessions.write().await;
        if map.len() > 2048 {
            map.clear();
        }
        map.insert(ticket.to_string(), session_id);
    }

    pub async fn take_ticket_session(&self, ticket: &str) -> Option<Uuid> {
        let mut map = self.ticket_sessions.write().await;
        map.remove(ticket)
    }

    pub async fn bind_connection_to_session(&self, connection_id: Uuid, session_id: Uuid) {
        let mut map = self.connection_sessions.write().await;
        map.insert(connection_id, session_id);
    }

    /// Immediately notifies and closes all WebSocket connections associated with a revoked session,
    /// and purges any unconsumed Gateway tickets issued by that session.
    pub async fn revoke_session_connections(&self, user_id: Uuid, session_id: Uuid) {
        {
            let mut tickets = self.ticket_sessions.write().await;
            tickets.retain(|_, sid| *sid != session_id);
        }

        let target_conn_ids: Vec<Uuid> = {
            let mut conn_sessions = self.connection_sessions.write().await;
            let matching: Vec<Uuid> = conn_sessions
                .iter()
                .filter_map(|(cid, sid)| if *sid == session_id { Some(*cid) } else { None })
                .collect();
            for cid in &matching {
                conn_sessions.remove(cid);
            }
            matching
        };

        if target_conn_ids.is_empty() {
            return;
        }

        let revoked_event = GatewayEvent::new(
            "session.revoked",
            serde_json::json!({
                "message": "Sessão encerrada ou revogada."
            }),
        );

        let conns = self.connections.read().await;
        if let Some(user_conns) = conns.get(&user_id) {
            for cid in target_conn_ids {
                if let Some(conn) = user_conns.get(&cid) {
                    if !conn.try_enqueue(user_id, revoked_event.clone()) {
                        conn.slow_consumer_disconnect.notify_one();
                    }
                }
            }
        }
    }

    /// Register new WebSocket connection for a user.
    /// Returns `Result<(is_first_connection, friend_ids, effective_status), String>`
    pub async fn register_connection(
        &self,
        user_id: Uuid,
        connection_id: Uuid,
        conn: ClientConnection,
    ) -> Result<(bool, Vec<Uuid>, String), String> {
        let was_empty = {
            let mut conns = self.connections.write().await;
            let user_conns = conns.entry(user_id).or_default();

            if user_conns.len() >= MAX_CONNECTIONS_PER_USER {
                return Err("Limite de conexões simultâneas atingido.".to_string());
            }

            let was_empty = user_conns.is_empty();
            user_conns.insert(connection_id, conn);
            was_empty
        };

        if was_empty {
            // Retrieve preferred status from database (without holding connections lock)
            let pref = match self.friend_repo.get_presence(user_id).await {
                Ok(p) => Some(p),
                Err(e) => {
                    warn!(
                        "[Presence] Falha ao carregar preferência de presença do usuário {}: {}",
                        user_id, e
                    );
                    None
                }
            };

            let raw_preferred = pref
                .as_ref()
                .map(|p| p.preferred_status.as_str())
                .unwrap_or("online");

            let preferred_status = match raw_preferred {
                "online" | "idle" | "dnd" | "invisible" => raw_preferred.to_string(),
                _ => "online".to_string(),
            };

            let custom_status = pref.as_ref().and_then(|p| p.custom_status.clone());
            let activity = pref.as_ref().and_then(|p| p.activity.clone());

            let effective_status = if preferred_status == "invisible" {
                "offline".to_string()
            } else {
                preferred_status.clone()
            };

            let last_seen = match self
                .friend_repo
                .set_connectivity_status(user_id, &effective_status)
                .await
            {
                Ok(ts) => ts,
                Err(e) => {
                    warn!(
                        "[Presence] Falha ao atualizar status de conectividade inicial para {}: {}",
                        user_id, e
                    );
                    Utc::now()
                }
            };

            {
                let mut presences = self.live_presence.write().await;
                presences.insert(
                    user_id,
                    LivePresence {
                        preferred_status: preferred_status.clone(),
                        status: effective_status.clone(),
                        custom_status,
                        activity,
                        last_seen_at: Some(last_seen),
                    },
                );
            }

            // If user is invisible, we do NOT broadcast presence to friends
            let friend_ids = if preferred_status == "invisible" {
                Vec::new()
            } else {
                match self.friend_repo.get_friend_ids(user_id).await {
                    Ok(ids) => ids,
                    Err(e) => {
                        warn!(
                            "[Presence] Falha ao buscar lista de amigos para broadcast de {}: {}",
                            user_id, e
                        );
                        Vec::new()
                    }
                }
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
        {
            let mut conn_sessions = self.connection_sessions.write().await;
            conn_sessions.remove(&connection_id);
        }

        let is_now_offline = {
            let mut conns = self.connections.write().await;
            let mut offline = false;

            if let Some(user_conns) = conns.get_mut(&user_id) {
                user_conns.remove(&connection_id);
                if user_conns.is_empty() {
                    conns.remove(&user_id);
                    offline = true;
                }
            }
            offline
        };

        if is_now_offline {
            // Persist effective 'offline' connectivity status and last_seen_at in user_profiles
            // WITHOUT mutating user_presence_preferences.preferred_status or custom_status/activity.
            let persisted_last_seen = match self
                .friend_repo
                .set_connectivity_status(user_id, "offline")
                .await
            {
                Ok(ts) => ts,
                Err(e) => {
                    warn!(
                        "[Presence] Falha ao persistir status offline e last_seen_at para {}: {}",
                        user_id, e
                    );
                    Utc::now()
                }
            };

            let was_invisible = {
                let mut presences = self.live_presence.write().await;
                let was_invisible = presences
                    .get(&user_id)
                    .map(|p| p.preferred_status == "invisible")
                    .unwrap_or(false);

                if let Some(presence) = presences.get_mut(&user_id) {
                    presence.status = "offline".to_string();
                    presence.last_seen_at = Some(persisted_last_seen);
                }
                was_invisible
            };

            // If user was invisible, friends already saw them as offline, so no need to broadcast
            if was_invisible {
                (true, Vec::new())
            } else {
                let friend_ids = match self.friend_repo.get_friend_ids(user_id).await {
                    Ok(ids) => ids,
                    Err(e) => {
                        warn!(
                            "[Presence] Falha ao buscar amigos no disconnect de {}: {}",
                            user_id, e
                        );
                        Vec::new()
                    }
                };
                (true, friend_ids)
            }
        } else {
            (false, Vec::new())
        }
    }

    /// Update user presence and return `(effective_status, friend_ids)` for broadcasting
    pub async fn update_user_presence(
        &self,
        user_id: Uuid,
        status: &str,
        custom_status: Option<&str>,
        activity: Option<&str>,
    ) -> (String, Vec<Uuid>) {
        let now = Utc::now();
        let normalized_pref = match status {
            "online" | "idle" | "dnd" | "invisible" => status,
            "offline" => "invisible",
            _ => "online",
        };

        let is_connected = self.is_user_connected(user_id).await;
        let effective_status = if normalized_pref == "invisible" || !is_connected {
            "offline".to_string()
        } else {
            normalized_pref.to_string()
        };

        {
            let mut presences = self.live_presence.write().await;
            let prev_custom = presences
                .get(&user_id)
                .and_then(|p| p.custom_status.clone());
            let prev_activity = presences.get(&user_id).and_then(|p| p.activity.clone());

            presences.insert(
                user_id,
                LivePresence {
                    preferred_status: normalized_pref.to_string(),
                    status: effective_status.clone(),
                    custom_status: custom_status.map(|s| s.to_string()).or(prev_custom),
                    activity: activity.map(|s| s.to_string()).or(prev_activity),
                    last_seen_at: Some(now),
                },
            );
        }

        if let Err(e) = self
            .friend_repo
            .update_presence(user_id, Some(normalized_pref), custom_status, activity, None)
            .await
        {
            warn!(
                "[Presence] Falha ao persistir atualização de presença para {}: {}",
                user_id, e
            );
        }

        if !is_connected {
            let _ = self
                .friend_repo
                .set_connectivity_status(user_id, "offline")
                .await;
        }

        let friend_ids = match self.friend_repo.get_friend_ids(user_id).await {
            Ok(ids) => ids,
            Err(e) => {
                warn!(
                    "[Presence] Falha ao buscar lista de amigos para atualização de {}: {}",
                    user_id, e
                );
                Vec::new()
            }
        };

        (effective_status, friend_ids)
    }

    /// Overlay live in-memory presence on friend list
    pub async fn enrich_friends_presence(&self, friends: &mut [FriendDto]) {
        // Collect active user IDs and release connections lock immediately
        let active_user_ids: std::collections::HashSet<Uuid> = {
            let conns = self.connections.read().await;
            conns.keys().copied().collect()
        };

        let presences = self.live_presence.read().await;

        for friend in friends.iter_mut() {
            // Se o usuário não tem nenhuma conexão WebSocket aberta ativa, ele está offline
            let has_active_conn = active_user_ids.contains(&friend.id);
            if !has_active_conn {
                friend.status = "offline".to_string();
                if let Some(live) = presences.get(&friend.id) {
                    if live.last_seen_at.is_some() {
                        friend.last_seen_at = live.last_seen_at;
                    }
                }
                continue;
            }

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
            } else {
                friend.status = "offline".to_string();
            }
        }
    }

    /// Send event to all active connections of a specific user
    pub async fn send_to_user(&self, target_user_id: Uuid, event: &GatewayEvent) {
        let conns = self.connections.read().await;
        if let Some(user_conns) = conns.get(&target_user_id) {
            info!(
                "[Gateway] Despachando evento '{}' para usuário {} em {} conexões ativas.",
                event.event_type,
                target_user_id,
                user_conns.len()
            );
            for conn in user_conns.values() {
                conn.try_enqueue(target_user_id, event.clone());
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
        self.broadcast_to_users(friend_ids, event).await;
    }

    /// Broadcast event to all active connections of a list of users
    pub async fn broadcast_to_users(&self, user_ids: &[Uuid], event: &GatewayEvent) {
        if user_ids.is_empty() {
            return;
        }
        let conns = self.connections.read().await;
        for user_id in user_ids {
            if let Some(user_conns) = conns.get(user_id) {
                for conn in user_conns.values() {
                    conn.try_enqueue(*user_id, event.clone());
                }
            }
        }
    }

    /// Send a critical event to all active connections of a specific user (no-op if offline)
    pub async fn send_critical_event(&self, target_user_id: Uuid, event: &GatewayEvent) {
        let conns = self.connections.read().await;
        if let Some(user_conns) = conns.get(&target_user_id) {
            for conn in user_conns.values() {
                conn.try_enqueue(target_user_id, event.clone());
            }
        }
    }

    /// List all user IDs that currently have at least one active WebSocket connection
    pub async fn list_connected_user_ids(&self) -> Vec<Uuid> {
        let conns = self.connections.read().await;
        conns.keys().copied().collect()
    }

    /// Check if a user's preferred presence status is currently "invisible"
    pub async fn is_user_invisible(&self, user_id: Uuid) -> bool {
        let presences = self.live_presence.read().await;
        presences
            .get(&user_id)
            .map(|p| p.preferred_status == "invisible")
            .unwrap_or(false)
    }

    /// Check if a user has any active connections
    pub async fn is_user_connected(&self, user_id: Uuid) -> bool {
        let conns = self.connections.read().await;
        conns.contains_key(&user_id)
    }

    /// Get current number of active connections for a specific user
    pub async fn user_connection_count(&self, user_id: Uuid) -> usize {
        let conns = self.connections.read().await;
        conns.get(&user_id).map(|m| m.len()).unwrap_or(0)
    }

    /// Get current total number of active connections across all users
    pub async fn total_connections(&self) -> usize {
        let conns = self.connections.read().await;
        conns.values().map(|m| m.len()).sum()
    }
}
