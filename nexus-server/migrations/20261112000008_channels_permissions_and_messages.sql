-- NEXUS Database Migration: v0.4.0 Etapa B1 - Channel Permission Overwrites, Messages & Read States
-- Logical reference: 008_channels_permissions_and_messages.sql (monotonic timestamp > 20261111000001 for sqlx 0.8)

CREATE TABLE IF NOT EXISTS channel_permission_overwrites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES community_channels(id) ON DELETE CASCADE,
    target_type VARCHAR(16) NOT NULL
        CONSTRAINT chk_channel_overwrites_target_type CHECK (target_type IN ('role', 'user')),
    target_id UUID NOT NULL,
    allow_bitmask BIGINT NOT NULL DEFAULT 0 CONSTRAINT chk_channel_overwrites_allow CHECK (allow_bitmask >= 0),
    deny_bitmask BIGINT NOT NULL DEFAULT 0 CONSTRAINT chk_channel_overwrites_deny CHECK (deny_bitmask >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_channel_overwrites_target UNIQUE (channel_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_overwrites_channel
    ON channel_permission_overwrites(channel_id);

CREATE INDEX IF NOT EXISTS idx_channel_overwrites_target
    ON channel_permission_overwrites(target_type, target_id);

CREATE TABLE IF NOT EXISTS channel_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES community_channels(id) ON DELETE CASCADE,
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reply_to_message_id UUID REFERENCES channel_messages(id) ON DELETE SET NULL,
    content TEXT NOT NULL
        CONSTRAINT chk_channel_messages_content_len CHECK (char_length(content) >= 1 AND char_length(content) <= 4000),
    client_message_id VARCHAR(64),
    attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    CONSTRAINT fk_channel_messages_same_community_channel
        FOREIGN KEY (community_id, channel_id)
        REFERENCES community_channels(community_id, id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_messages_client_id
    ON channel_messages(sender_id, client_message_id)
    WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_messages_feed
    ON channel_messages(channel_id, created_at DESC, id DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_channel_messages_sender
    ON channel_messages(sender_id);

CREATE INDEX IF NOT EXISTS idx_channel_messages_community
    ON channel_messages(community_id);

CREATE TABLE IF NOT EXISTS channel_read_states (
    channel_id UUID NOT NULL REFERENCES community_channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id UUID REFERENCES channel_messages(id) ON DELETE SET NULL,
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_read_states_user
    ON channel_read_states(user_id, last_read_at DESC);
