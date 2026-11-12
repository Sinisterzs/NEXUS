-- NEXUS Database Migration: v0.4.0 Etapa B1 - Communities Core
-- Logical reference: 007_communities_core.sql (monotonic timestamp > 20261111000001 for sqlx 0.8)
-- Additive-only schema: does not alter or drop any pre-existing tables.

CREATE TABLE IF NOT EXISTS communities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name VARCHAR(64) NOT NULL,
    description VARCHAR(500),
    icon_url TEXT,
    initials VARCHAR(4) NOT NULL,
    icon_bg VARCHAR(32) NOT NULL DEFAULT '#1f2937',
    accent_color VARCHAR(32) NOT NULL DEFAULT '#38bdf8',
    appearance_preset VARCHAR(32) NOT NULL DEFAULT 'steam-dark',
    privacy VARCHAR(24) NOT NULL DEFAULT 'invite_only'
        CONSTRAINT chk_communities_privacy CHECK (privacy IN ('public', 'invite_only', 'private')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_communities_owner_id ON communities(owner_id);
CREATE INDEX IF NOT EXISTS idx_communities_active ON communities(id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS community_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name VARCHAR(64) NOT NULL,
    position INTEGER NOT NULL DEFAULT 0 CONSTRAINT chk_community_categories_position CHECK (position >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_categories_order
    ON community_categories(community_id, position, created_at);

CREATE TABLE IF NOT EXISTS community_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    category_id UUID REFERENCES community_categories(id) ON DELETE SET NULL,
    name VARCHAR(64) NOT NULL,
    channel_type VARCHAR(16) NOT NULL
        CONSTRAINT chk_community_channels_type CHECK (channel_type IN ('text', 'voice')),
    topic VARCHAR(500),
    position INTEGER NOT NULL DEFAULT 0 CONSTRAINT chk_community_channels_position CHECK (position >= 0),
    is_private BOOLEAN NOT NULL DEFAULT FALSE,
    is_read_only BOOLEAN NOT NULL DEFAULT FALSE,
    voice_bitrate_bps INTEGER
        CONSTRAINT chk_community_channels_bitrate CHECK (voice_bitrate_bps IS NULL OR voice_bitrate_bps BETWEEN 16000 AND 512000),
    voice_user_limit INTEGER
        CONSTRAINT chk_community_channels_user_limit CHECK (voice_user_limit IS NULL OR voice_user_limit BETWEEN 1 AND 99),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT uq_community_channels_community_id_id UNIQUE (community_id, id)
);

CREATE INDEX IF NOT EXISTS idx_community_channels_order
    ON community_channels(community_id, category_id, position)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS community_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name VARCHAR(48) NOT NULL,
    color VARCHAR(16),
    position INTEGER NOT NULL DEFAULT 0 CONSTRAINT chk_community_roles_position CHECK (position >= 0),
    permissions_bitmask BIGINT NOT NULL DEFAULT 0 CONSTRAINT chk_community_roles_bitmask CHECK (permissions_bitmask >= 0),
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_hoisted BOOLEAN NOT NULL DEFAULT FALSE,
    is_mentionable BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_community_roles_community_id_id UNIQUE (community_id, id)
);

-- Garante exatamente um cargo @everyone / padrão por comunidade
CREATE UNIQUE INDEX IF NOT EXISTS uq_community_default_role
    ON community_roles(community_id)
    WHERE is_default = TRUE;

CREATE INDEX IF NOT EXISTS idx_community_roles_hierarchy
    ON community_roles(community_id, position DESC);

CREATE TABLE IF NOT EXISTS community_members (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname VARCHAR(48),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_community_members_user_id ON community_members(user_id);

CREATE TABLE IF NOT EXISTS community_member_roles (
    community_id UUID NOT NULL,
    user_id UUID NOT NULL,
    role_id UUID NOT NULL REFERENCES community_roles(id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, user_id, role_id),
    CONSTRAINT fk_community_member_roles_member
        FOREIGN KEY (community_id, user_id)
        REFERENCES community_members(community_id, user_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_community_member_roles_same_community_role
        FOREIGN KEY (community_id, role_id)
        REFERENCES community_roles(community_id, id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_community_member_roles_role ON community_member_roles(role_id);
