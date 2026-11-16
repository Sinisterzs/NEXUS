-- NEXUS Database Migration: Phase S1.4 DM Message Requests
-- Exclusively additive. Preserves all existing direct_conversations and direct_messages.

CREATE TABLE IF NOT EXISTS dm_message_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMPTZ,
    cooldown_until TIMESTAMPTZ,
    CONSTRAINT chk_dm_requests_no_self CHECK (sender_id <> recipient_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dm_requests_pending_pair
    ON dm_message_requests (sender_id, recipient_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_dm_requests_recipient_status
    ON dm_message_requests (recipient_id, status, created_at DESC);
