use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DmPolicy {
    FriendsOnly,
    FriendsAndCommunity,
    Nobody,
}

impl DmPolicy {
    pub fn from_db(s: &str) -> Self {
        match s {
            "friends_only" => Self::FriendsOnly,
            "nobody" => Self::Nobody,
            _ => Self::FriendsAndCommunity,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FriendRequestPolicy {
    Everyone,
    CommunityOnly,
    Nobody,
}

impl FriendRequestPolicy {
    pub fn from_db(s: &str) -> Self {
        match s {
            "community_only" => Self::CommunityOnly,
            "nobody" => Self::Nobody,
            _ => Self::Everyone,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivateCallPolicy {
    FriendsOnly,
    Nobody,
}

impl PrivateCallPolicy {
    pub fn from_db(s: &str) -> Self {
        match s {
            "nobody" => Self::Nobody,
            _ => Self::FriendsOnly,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserPrivacyPreferences {
    pub user_id: Uuid,
    pub dm_policy: DmPolicy,
    pub friend_request_policy: FriendRequestPolicy,
    pub private_call_policy: PrivateCallPolicy,
    pub updated_at: Option<DateTime<Utc>>,
}

impl UserPrivacyPreferences {
    pub fn default_for(user_id: Uuid) -> Self {
        Self {
            user_id,
            dm_policy: DmPolicy::FriendsAndCommunity,
            friend_request_policy: FriendRequestPolicy::Everyone,
            private_call_policy: PrivateCallPolicy::FriendsOnly,
            updated_at: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SocialPermissionDecision {
    Allowed,
    RequestRequired,
    Denied,
}

#[derive(Clone)]
pub struct SocialPolicyService {
    pool: PgPool,
    enforcement_enabled: bool,
}

impl SocialPolicyService {
    pub fn new(pool: PgPool) -> Self {
        let enforcement_enabled = std::env::var("SOCIAL_POLICY_ENFORCEMENT_ENABLED")
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        Self {
            pool,
            enforcement_enabled,
        }
    }

    pub fn with_enforcement(mut self, enabled: bool) -> Self {
        self.enforcement_enabled = enabled;
        self
    }

    pub fn is_enforcement_enabled(&self) -> bool {
        self.enforcement_enabled
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn get_preferences(&self, user_id: Uuid) -> Result<UserPrivacyPreferences, AppError> {
        let row: Option<(String, String, String, DateTime<Utc>)> = sqlx::query_as(
            r#"
            SELECT dm_policy, friend_request_policy, private_call_policy, updated_at
            FROM user_privacy_preferences
            WHERE user_id = $1
            "#,
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(match row {
            Some((dm, fr, pc, updated_at)) => UserPrivacyPreferences {
                user_id,
                dm_policy: DmPolicy::from_db(&dm),
                friend_request_policy: FriendRequestPolicy::from_db(&fr),
                private_call_policy: PrivateCallPolicy::from_db(&pc),
                updated_at: Some(updated_at),
            },
            None => UserPrivacyPreferences::default_for(user_id),
        })
    }

    async fn user_exists(&self, user_id: Uuid) -> Result<bool, AppError> {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(user_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(exists)
    }

    async fn is_blocked_either_way(&self, a: Uuid, b: Uuid) -> Result<bool, AppError> {
        let blocked: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM user_blocks
                WHERE (blocker_id = $1 AND blocked_id = $2)
                   OR (blocker_id = $2 AND blocked_id = $1)
            )
            "#,
        )
        .bind(a)
        .bind(b)
        .fetch_one(&self.pool)
        .await?;
        Ok(blocked)
    }

    async fn are_friends(&self, a: Uuid, b: Uuid) -> Result<bool, AppError> {
        let friends: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM friendships
                WHERE (user_a_id = $1 AND user_b_id = $2)
                   OR (user_a_id = $2 AND user_b_id = $1)
            )
            "#,
        )
        .bind(a)
        .bind(b)
        .fetch_one(&self.pool)
        .await?;
        Ok(friends)
    }

    async fn share_community(&self, a: Uuid, b: Uuid) -> Result<bool, AppError> {
        let shared: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM community_members cm1
                INNER JOIN community_members cm2 ON cm1.community_id = cm2.community_id
                WHERE cm1.user_id = $1 AND cm2.user_id = $2
            )
            "#,
        )
        .bind(a)
        .bind(b)
        .fetch_one(&self.pool)
        .await?;
        Ok(shared)
    }

    pub async fn can_send_friend_request(
        &self,
        actor_id: Uuid,
        target_id: Uuid,
    ) -> Result<SocialPermissionDecision, AppError> {
        if actor_id == target_id || !self.user_exists(target_id).await? {
            return Ok(SocialPermissionDecision::Denied);
        }
        if self.is_blocked_either_way(actor_id, target_id).await? {
            return Ok(SocialPermissionDecision::Denied);
        }
        if self.are_friends(actor_id, target_id).await? {
            return Ok(SocialPermissionDecision::Denied);
        }

        let prefs = self.get_preferences(target_id).await?;
        Ok(match prefs.friend_request_policy {
            FriendRequestPolicy::Everyone => SocialPermissionDecision::Allowed,
            FriendRequestPolicy::CommunityOnly => {
                if self.share_community(actor_id, target_id).await? {
                    SocialPermissionDecision::Allowed
                } else {
                    SocialPermissionDecision::Denied
                }
            }
            FriendRequestPolicy::Nobody => SocialPermissionDecision::Denied,
        })
    }

    pub async fn can_start_dm(
        &self,
        actor_id: Uuid,
        target_id: Uuid,
    ) -> Result<SocialPermissionDecision, AppError> {
        if actor_id == target_id || !self.user_exists(target_id).await? {
            return Ok(SocialPermissionDecision::Denied);
        }
        if self.is_blocked_either_way(actor_id, target_id).await? {
            return Ok(SocialPermissionDecision::Denied);
        }

        let prefs = self.get_preferences(target_id).await?;
        if prefs.dm_policy == DmPolicy::Nobody {
            return Ok(SocialPermissionDecision::Denied);
        }

        if self.are_friends(actor_id, target_id).await? {
            return Ok(SocialPermissionDecision::Allowed);
        }

        if prefs.dm_policy == DmPolicy::FriendsAndCommunity
            && self.share_community(actor_id, target_id).await?
        {
            return Ok(SocialPermissionDecision::RequestRequired);
        }

        Ok(SocialPermissionDecision::Denied)
    }

    pub async fn can_start_private_call(
        &self,
        actor_id: Uuid,
        target_id: Uuid,
    ) -> Result<SocialPermissionDecision, AppError> {
        if actor_id == target_id || !self.user_exists(target_id).await? {
            return Ok(SocialPermissionDecision::Denied);
        }
        if self.is_blocked_either_way(actor_id, target_id).await? {
            return Ok(SocialPermissionDecision::Denied);
        }

        let prefs = self.get_preferences(target_id).await?;
        if prefs.private_call_policy == PrivateCallPolicy::Nobody {
            return Ok(SocialPermissionDecision::Denied);
        }

        if self.are_friends(actor_id, target_id).await? {
            Ok(SocialPermissionDecision::Allowed)
        } else {
            Ok(SocialPermissionDecision::Denied)
        }
    }

    pub async fn can_send_direct_invite(
        &self,
        actor_id: Uuid,
        target_id: Uuid,
    ) -> Result<SocialPermissionDecision, AppError> {
        if actor_id == target_id || !self.user_exists(target_id).await? {
            return Ok(SocialPermissionDecision::Denied);
        }
        if self.is_blocked_either_way(actor_id, target_id).await? {
            return Ok(SocialPermissionDecision::Denied);
        }

        if self.are_friends(actor_id, target_id).await? {
            Ok(SocialPermissionDecision::Allowed)
        } else {
            Ok(SocialPermissionDecision::Denied)
        }
    }
}
