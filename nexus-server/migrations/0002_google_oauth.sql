-- NEXUS Database Migration: Phase 2.1.1 Google Sign-In & OAuth Accounts

-- Allow nullable password_hash for users authenticated via OAuth
ALTER TABLE user_credentials ALTER COLUMN password_hash DROP NOT NULL;

-- External OAuth identity providers table
CREATE TABLE IF NOT EXISTS user_oauth_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(32) NOT NULL,
    provider_subject VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_oauth_provider_subject UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_user_oauth_accounts_user_id ON user_oauth_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_user_oauth_accounts_provider_sub ON user_oauth_accounts(provider, provider_subject);
