-- NEXUS Database Migration: Phase S1.2 User Privacy Preferences
-- Exclusively additive. Existing users without rows use explicit application defaults.

CREATE TABLE IF NOT EXISTS user_privacy_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    dm_policy VARCHAR(32) NOT NULL DEFAULT 'friends_and_community'
        CHECK (dm_policy IN ('friends_only', 'friends_and_community', 'nobody')),
    friend_request_policy VARCHAR(32) NOT NULL DEFAULT 'everyone'
        CHECK (friend_request_policy IN ('everyone', 'community_only', 'nobody')),
    private_call_policy VARCHAR(32) NOT NULL DEFAULT 'friends_only'
        CHECK (private_call_policy IN ('friends_only', 'nobody')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
