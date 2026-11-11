-- NEXUS Google login: READ-ONLY diagnostic (psql).
-- Only SELECT inside a READ ONLY transaction. Prints booleans and aggregate counts ONLY:
-- never emails, subjects, tokens, hashes or user ids.
--
-- Usage (authorized operator, read-only DB role):
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql -v ON_ERROR_STOP=1 -f google_login_readonly_diagnostic.sql "$DATABASE_URL"
-- Optional single-account check (email stays local in psql variable; never selected or printed):
--   psql -v ON_ERROR_STOP=1 -v target_email='person@example.com' -f google_login_readonly_diagnostic.sql "$DATABASE_URL"
--
-- Schema verified against migrations 0001, 0002:
--   users(id UUID PRIMARY KEY, username VARCHAR UNIQUE)
--   user_credentials(user_id UUID FK REFERENCES users(id), email VARCHAR UNIQUE, password_hash VARCHAR NULL)
--   user_oauth_accounts(id UUID PRIMARY KEY, user_id UUID FK REFERENCES users(id), provider VARCHAR, provider_subject VARCHAR, UNIQUE(provider, provider_subject))

\set QUIET on
\pset format aligned
\pset tuples_only off
BEGIN READ ONLY;

\echo '== A. Global aggregates (counts only) =='

SELECT
  (SELECT COUNT(*) FROM users)                                        AS users_total,
  (SELECT COUNT(*) FROM user_credentials)                             AS credentials_total,
  (SELECT COUNT(*) FROM user_oauth_accounts)                          AS oauth_links_total,
  -- users without a credentials row
  (SELECT COUNT(*) FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = u.id))
                                                                      AS users_without_credentials,
  -- orphans: NULL password hash and no OAuth link (cannot log in by any method)
  (SELECT COUNT(*) FROM user_credentials c
     WHERE c.password_hash IS NULL
       AND NOT EXISTS (SELECT 1 FROM user_oauth_accounts o WHERE o.user_id = c.user_id))
                                                                      AS orphans_null_hash_no_link,
  -- OAuth links whose user has no credentials row
  (SELECT COUNT(*) FROM user_oauth_accounts o
     WHERE NOT EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = o.user_id))
                                                                      AS links_without_credentials;

SELECT
  -- email groups that collide after trim+lower (distinct rows sharing a normalized email)
  (SELECT COUNT(*) FROM (
      SELECT 1 FROM user_credentials
      GROUP BY lower(btrim(email)) HAVING COUNT(*) > 1) d)            AS duplicate_email_groups_normalized,
  (SELECT COUNT(*) FROM user_credentials
     WHERE email <> lower(btrim(email)))                              AS emails_not_normalized,
  (SELECT COUNT(*) FROM user_credentials
     WHERE email <> btrim(email))                                     AS emails_with_whitespace,
  (SELECT COUNT(*) FROM user_credentials
     WHERE email <> lower(email))                                     AS emails_mixed_case;

SELECT
  (SELECT COUNT(*) FROM (
      SELECT 1 FROM user_oauth_accounts
      GROUP BY provider, btrim(provider_subject) HAVING COUNT(*) > 1) d)
                                                                      AS duplicate_provider_subject_trimmed,
  (SELECT COUNT(*) FROM (
      SELECT 1 FROM user_oauth_accounts
      GROUP BY lower(btrim(provider)), btrim(provider_subject) HAVING COUNT(*) > 1) d)
                                                                      AS duplicate_provider_subject_trim_case,
  (SELECT COUNT(*) FROM user_oauth_accounts
     WHERE provider_subject <> btrim(provider_subject))               AS subjects_with_whitespace,
  (SELECT COUNT(*) FROM user_oauth_accounts
     WHERE provider <> lower(btrim(provider)))                        AS providers_not_normalized,
  (SELECT COUNT(*) FROM (
      SELECT 1 FROM user_oauth_accounts
      WHERE lower(btrim(provider)) = 'google'
      GROUP BY user_id HAVING COUNT(*) > 1) d)                        AS users_with_more_than_one_google_link;

\echo '== B. Provider distribution (counts only) =='
SELECT provider, COUNT(*) AS links
FROM user_oauth_accounts
GROUP BY provider
ORDER BY links DESC;

\echo '== C. Single-account check (booleans/counts only) =='
\if :{?target_email}
  WITH input_param AS (
    SELECT :'target_email'::text AS raw_val,
           lower(btrim(:'target_email'::text)) AS norm_val
  ),
  -- Exact matches as stored in DB (case and whitespace sensitive)
  exact_raw AS (
    SELECT c.* FROM user_credentials c, input_param i WHERE c.email = i.raw_val
  ),
  -- Exact matches if the server applied standard normalization (lower + btrim)
  exact_norm AS (
    SELECT c.* FROM user_credentials c, input_param i WHERE c.email = i.norm_val
  ),
  -- All rows that collide with target_email under normalized comparison
  normalized_matches AS (
    SELECT c.* FROM user_credentials c, input_param i WHERE lower(btrim(c.email)) = i.norm_val
  ),
  -- Scope of users to inspect: union of exact and normalized candidates
  candidate_users AS (
    SELECT DISTINCT user_id FROM normalized_matches
  ),
  user_links AS (
    SELECT 
      o.user_id,
      COUNT(*) AS total_links,
      COUNT(*) FILTER (WHERE lower(btrim(o.provider)) = 'google') AS google_links
    FROM user_oauth_accounts o
    JOIN candidate_users cu ON cu.user_id = o.user_id
    GROUP BY o.user_id
  )
  SELECT
    -- 1. Exact raw string matches stored value
    EXISTS (SELECT 1 FROM exact_raw)                                   AS has_exact_raw_credentials_match,

    -- 2. Exact match on normalized value (what modern backend queries check)
    EXISTS (SELECT 1 FROM exact_norm)                                  AS has_exact_normalized_credentials_match,

    -- 3. Any credential matches when both target and DB column are normalized (catches legacy unnormalized rows)
    EXISTS (SELECT 1 FROM normalized_matches)                          AS has_any_normalized_credentials_match,

    -- 4. Count of distinct credential rows colliding on the normalized email
    (SELECT COUNT(*) FROM normalized_matches)                          AS count_rows_matching_normalized_email,

    -- 5. Indicator if existing matching row(s) in DB are NOT stored in normalized form
    EXISTS (
      SELECT 1 FROM normalized_matches WHERE email <> lower(btrim(email))
    )                                                                  AS matching_credentials_unnormalized_in_db,

    -- 6. Password existence indicators across matched candidate accounts
    EXISTS (
      SELECT 1 FROM normalized_matches WHERE password_hash IS NOT NULL AND length(password_hash) > 0
    )                                                                  AS any_matched_account_has_password,

    EXISTS (
      SELECT 1 FROM normalized_matches WHERE password_hash IS NULL OR length(password_hash) = 0
    )                                                                  AS any_matched_account_is_passwordless,

    -- 7. Google OAuth link indicators
    -- IMPORTANT: has_registered_google_link indicates ONLY that a row exists with provider='google'.
    -- It does NOT prove that provider_subject matches the incoming Google token of the current attempt.
    EXISTS (
      SELECT 1 FROM user_links WHERE google_links > 0
    )                                                                  AS has_registered_google_link,

    COALESCE((SELECT SUM(google_links) FROM user_links), 0)            AS total_google_links_for_matched_accounts,

    COALESCE((SELECT SUM(total_links) FROM user_links), 0)             AS total_oauth_links_all_providers,

    -- 8. Multiple accounts ambiguity indicator
    ((SELECT COUNT(DISTINCT user_id) FROM normalized_matches) > 1)     AS multiple_accounts_share_normalized_email;
\else
  \echo 'target_email not set: skipped (use -v target_email=... to check one account).'
\endif

ROLLBACK;
