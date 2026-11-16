-- NEXUS Database Migration: Phase 7C.6 Age Declaration Idempotency
-- Exclusively additive unique partial index for concurrent idempotent 16+ confirmations.

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_age_declarations_confirmed
    ON user_age_declarations (user_id, minimum_age)
    WHERE confirmed = TRUE;
