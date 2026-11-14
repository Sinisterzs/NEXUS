-- Execute only after explicit approval, service rollback and diagnostics disabled.
BEGIN;
DROP TABLE IF EXISTS diagnostics_events;
DROP TABLE IF EXISTS diagnostics_participants;
DROP TABLE IF EXISTS diagnostics_consent_audit;
DROP TABLE IF EXISTS diagnostics_consent;
DROP TABLE IF EXISTS diagnostics_budgets;
-- Preserve sqlx migration history: do not downgrade/reapply migrations blindly.
COMMIT;
