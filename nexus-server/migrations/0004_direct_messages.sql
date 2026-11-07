-- NEXUS Database Migration: Phase 2.3 Real Direct Messages System
-- PostgreSQL Schema for Conversations, Messages, Receipts, Conversation State and Gateway Tickets

-- 1. direct_conversations
-- Unique canonical pair: user_a_id and user_b_id (user_a_id <> user_b_id)
CREATE TABLE IF NOT EXISTS direct_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_a_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_direct_conversations_no_self CHECK (user_a_id <> user_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_conversations_canonical_pair
    ON direct_conversations (LEAST(user_a_id, user_b_id), GREATEST(user_a_id, user_b_id));

CREATE INDEX IF NOT EXISTS idx_direct_conversations_user_a ON direct_conversations(user_a_id);
CREATE INDEX IF NOT EXISTS idx_direct_conversations_user_b ON direct_conversations(user_b_id);
CREATE INDEX IF NOT EXISTS idx_direct_conversations_updated_at ON direct_conversations(updated_at DESC);

-- 2. direct_messages
-- Idempotent per sender_id + client_message_id, length 1..=2000, soft delete via deleted_at
CREATE TABLE IF NOT EXISTS direct_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_message_id UUID NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    CONSTRAINT uq_direct_messages_client_id UNIQUE (sender_id, client_message_id),
    CONSTRAINT chk_direct_messages_content_len CHECK (length(content) >= 1 AND length(content) <= 2000)
);

CREATE INDEX IF NOT EXISTS idx_direct_messages_conv_order 
    ON direct_messages(conversation_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_direct_messages_sender ON direct_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_direct_messages_conv_created_desc 
    ON direct_messages(conversation_id, created_at DESC, id DESC);

-- 3. direct_message_receipts
-- Delivered & read receipts per message per recipient
CREATE TABLE IF NOT EXISTS direct_message_receipts (
    message_id UUID NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_direct_message_receipts_user ON direct_message_receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_direct_message_receipts_unread ON direct_message_receipts(user_id, read_at) WHERE read_at IS NULL;

-- 4. direct_conversation_state
-- Tracks per-user conversation state: last read message and last read timestamp
CREATE TABLE IF NOT EXISTS direct_conversation_state (
    conversation_id UUID NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id UUID REFERENCES direct_messages(id) ON DELETE SET NULL,
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_direct_conv_state_user ON direct_conversation_state(user_id);

-- 5. gateway_auth_tickets
-- Ephemeral 60s tickets for establishing Gateway WebSocket connection without exposing persistent session token
CREATE TABLE IF NOT EXISTS gateway_auth_tickets (
    ticket VARCHAR(128) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gateway_auth_tickets_expires ON gateway_auth_tickets(expires_at);
