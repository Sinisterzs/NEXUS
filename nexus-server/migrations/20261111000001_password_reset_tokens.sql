-- NEXUS Database Migration: v0.2.5 Password Recovery by E-mail
--
-- Single-use, short-lived (15 min) password reset tokens.
-- SECURITY: only the SHA-256 hex digest of the raw token is stored. The raw
-- token exists exclusively in the e-mail sent to the account owner and is never
-- persisted or logged by the server.
--
-- Reversibility:
-- DOWN: DROP TABLE IF EXISTS password_reset_tokens;
-- (dropping the table also drops the indexes below; no other table is altered)

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ NULL,
    request_ip VARCHAR(64) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);
