-- NEXUS Administrative Script: Temporal Cutoff Session Revocation
-- Usage:
--   1. Verify target database (`current_database()`, `inet_server_addr()`) before running.
--   2. Replace :'cutoff_utc' with the explicit UTC timestamp of Nightly propagation.
--   3. Run Step 1 (Dry-Run) first; only run Step 2 after confirming the count.

-- Step 0: Environment check
SELECT current_database() AS database_name, NOW() AS server_time_utc;

-- Step 1: Dry-run count (sessions created strictly BEFORE cutoff_utc)
SELECT
    COUNT(*) FILTER (WHERE revoked_at IS NULL AND created_at < :'cutoff_utc'::timestamptz) AS will_revoke,
    COUNT(*) FILTER (WHERE revoked_at IS NULL AND created_at >= :'cutoff_utc'::timestamptz) AS will_preserve
FROM sessions;

-- Step 2: Idempotent revocation (uncomment only when authorized to execute)
-- BEGIN;
-- UPDATE sessions
-- SET revoked_at = NOW()
-- WHERE revoked_at IS NULL
--   AND created_at < :'cutoff_utc'::timestamptz;
-- COMMIT;
