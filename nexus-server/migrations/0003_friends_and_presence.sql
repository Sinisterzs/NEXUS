-- NEXUS Database Migration: Phase 2.2 Friends, Real-Time Presence, Blocks & Preferences

-- 1. friendships
-- - id: UUID
-- - user_a_id: UUID
-- - user_b_id: UUID
-- - created_at: TIMESTAMPTZ
-- Unicidade do par independentemente da ordem e sem amizade consigo mesmo
CREATE TABLE IF NOT EXISTS friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_a_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_friendships_no_self CHECK (user_a_id <> user_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_friendships_canonical_pair 
    ON friendships (LEAST(user_a_id, user_b_id), GREATEST(user_a_id, user_b_id));

CREATE INDEX IF NOT EXISTS idx_friendships_user_a ON friendships(user_a_id);
CREATE INDEX IF NOT EXISTS idx_friendships_user_b ON friendships(user_b_id);

-- 2. friend_requests
-- - id: UUID
-- - sender_id: UUID
-- - receiver_id: UUID
-- - status: pending, accepted, rejected, cancelled
-- - created_at
-- - updated_at
CREATE TABLE IF NOT EXISTS friend_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_friend_requests_no_self CHECK (sender_id <> receiver_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_sender_id ON friend_requests(sender_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver_id ON friend_requests(receiver_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_friend_requests_pending_pair 
    ON friend_requests(sender_id, receiver_id) 
    WHERE status = 'pending';

-- 3. user_blocks
-- - blocker_id: UUID
-- - blocked_id: UUID
-- - created_at
CREATE TABLE IF NOT EXISTS user_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_user_blocks_no_self CHECK (blocker_id <> blocked_id),
    CONSTRAINT uq_user_blocks_pair UNIQUE (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

-- 4. user_presence_preferences
-- - user_id: UUID
-- - preferred_status: online, idle, dnd, invisible
-- - allow_friend_requests: BOOLEAN
-- - updated_at
CREATE TABLE IF NOT EXISTS user_presence_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferred_status VARCHAR(20) NOT NULL DEFAULT 'online' CHECK (preferred_status IN ('online', 'idle', 'dnd', 'invisible')),
    allow_friend_requests BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Enhance user_profiles with custom_status, activity and last_seen_at
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS custom_status TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS activity TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW();
