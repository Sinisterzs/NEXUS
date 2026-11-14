-- Optional diagnostics, isolated from operational media and messages.
CREATE TABLE diagnostics_consent (
    auth_session UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revision UUID NOT NULL,
    p2p BOOLEAN NOT NULL DEFAULT FALSE,
    color BOOLEAN NOT NULL DEFAULT FALSE,
    synthetic BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE diagnostics_consent_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revision UUID NOT NULL,
    permissions JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX diagnostics_audit_expiry ON diagnostics_consent_audit(created_at);
CREATE TABLE diagnostics_participants (
    session_id UUID NOT NULL,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alias UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(session_id, owner_id), UNIQUE(session_id, alias)
);
CREATE TABLE diagnostics_events (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id UUID NOT NULL,
    consent_revision UUID NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('p2p','color','synthetic')),
    version VARCHAR(40) NOT NULL,
    payload JSONB NOT NULL CHECK(octet_length(payload::text) <= 16384),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX diagnostics_expiry ON diagnostics_events(received_at);
CREATE INDEX diagnostics_session ON diagnostics_events(session_id, received_at);
CREATE INDEX diagnostics_filters ON diagnostics_events(kind,version,received_at);
CREATE INDEX diagnostics_owner ON diagnostics_events(owner_id,received_at);
CREATE TABLE diagnostics_budgets (
    owner_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    requests INTEGER NOT NULL DEFAULT 0
);
