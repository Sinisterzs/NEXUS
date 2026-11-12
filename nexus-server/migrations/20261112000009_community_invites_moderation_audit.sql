-- NEXUS Database Migration: v0.4.0 Etapa B1 - Invites, Bans, Mutes & Audit Logs
-- Logical reference: 009_community_invites_moderation_audit.sql (monotonic timestamp > 20261111000001 for sqlx 0.8)

CREATE TABLE IF NOT EXISTS community_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES community_channels(id) ON DELETE SET NULL,
    inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code VARCHAR(16) NOT NULL UNIQUE,
    max_uses INTEGER CONSTRAINT chk_community_invites_max_uses CHECK (max_uses IS NULL OR max_uses > 0),
    uses_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT chk_community_invites_uses_count CHECK (uses_count >= 0),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_invites_community
    ON community_invites(community_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_bans (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reason VARCHAR(500),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_community_bans_user ON community_bans(user_id);

CREATE TABLE IF NOT EXISTS community_member_mutes (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    muted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reason VARCHAR(500),
    text_muted_until TIMESTAMPTZ,
    voice_muted_until TIMESTAMPTZ,
    server_voice_muted BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_community_member_mutes_user ON community_member_mutes(user_id);

CREATE TABLE IF NOT EXISTS community_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    action VARCHAR(64) NOT NULL,
    target_type VARCHAR(32) NOT NULL,
    target_id UUID,
    reason VARCHAR(500),
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_audit_logs_timeline
    ON community_audit_logs(community_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_community_audit_logs_actor
    ON community_audit_logs(community_id, actor_id, created_at DESC);
