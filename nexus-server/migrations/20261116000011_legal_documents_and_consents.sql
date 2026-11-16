-- NEXUS Database Migration: Phase 7C.1 Legal Documents, Consents, Age Declaration & Email Verification Prep
-- Exclusively additive migration. Preserves all existing users, credentials, OAuth accounts, sessions, and data.

-- 1. Versioned legal documents (Terms of Use, Privacy Policy)
CREATE TABLE IF NOT EXISTS legal_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_type VARCHAR(64) NOT NULL CHECK (doc_type IN ('terms_of_use', 'privacy_policy')),
    version VARCHAR(32) NOT NULL,
    content_markdown TEXT,
    official_url TEXT,
    content_hash VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
    published_at TIMESTAMPTZ,
    effective_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_legal_documents_type_version UNIQUE (doc_type, version),
    CONSTRAINT chk_legal_documents_published_content CHECK (
        status = 'draft' OR (
            content_hash ~ '^[0-9a-f]{64}$'
            AND (NULLIF(BTRIM(content_markdown), '') IS NOT NULL OR NULLIF(BTRIM(official_url), '') IS NOT NULL)
            AND published_at IS NOT NULL
            AND effective_at IS NOT NULL
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_legal_documents_active
    ON legal_documents (doc_type, status, effective_at DESC, published_at DESC);

-- Prevent mutating published/retired legal documents (only status transition published -> retired is allowed)
CREATE OR REPLACE FUNCTION enforce_legal_document_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('published', 'retired') THEN
        IF NEW.doc_type IS DISTINCT FROM OLD.doc_type
           OR NEW.version IS DISTINCT FROM OLD.version
           OR NEW.content_markdown IS DISTINCT FROM OLD.content_markdown
           OR NEW.official_url IS DISTINCT FROM OLD.official_url
           OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
           OR NEW.published_at IS DISTINCT FROM OLD.published_at
           OR NEW.effective_at IS DISTINCT FROM OLD.effective_at THEN
            RAISE EXCEPTION 'Published or retired legal documents are immutable';
        END IF;

        IF OLD.status = 'retired' AND NEW.status IS DISTINCT FROM 'retired' THEN
            RAISE EXCEPTION 'Retired legal documents cannot change status';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_legal_documents_immutable ON legal_documents;
CREATE TRIGGER trg_legal_documents_immutable
    BEFORE UPDATE ON legal_documents
    FOR EACH ROW
    EXECUTE FUNCTION enforce_legal_document_immutability();

-- 2. Append-only user legal acceptances / acknowledgements
CREATE TABLE IF NOT EXISTS user_legal_acceptances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_type VARCHAR(64) NOT NULL,
    doc_version VARCHAR(32) NOT NULL,
    doc_hash VARCHAR(64) NOT NULL,
    record_type VARCHAR(32) NOT NULL CHECK (record_type IN ('acceptance', 'acknowledgement')),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    flow_origin VARCHAR(32) NOT NULL,
    app_version VARCHAR(32),
    CONSTRAINT fk_user_legal_acceptances_document
        FOREIGN KEY (doc_type, doc_version) REFERENCES legal_documents(doc_type, version),
    CONSTRAINT uq_user_legal_acceptances_user_doc_ver UNIQUE (user_id, doc_type, doc_version)
);

CREATE INDEX IF NOT EXISTS idx_user_legal_acceptances_user
    ON user_legal_acceptances (user_id, doc_type, recorded_at DESC);

CREATE OR REPLACE FUNCTION prevent_user_legal_acceptance_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'user_legal_acceptances is append-only and cannot be updated';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_legal_acceptances_no_update ON user_legal_acceptances;
CREATE TRIGGER trg_user_legal_acceptances_no_update
    BEFORE UPDATE ON user_legal_acceptances
    FOR EACH ROW
    EXECUTE FUNCTION prevent_user_legal_acceptance_update();

-- 3. Explicit minimum age (16+) declaration log
CREATE TABLE IF NOT EXISTS user_age_declarations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    minimum_age SMALLINT NOT NULL CHECK (minimum_age = 16),
    confirmed BOOLEAN NOT NULL,
    declared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    flow_origin VARCHAR(32) NOT NULL,
    app_version VARCHAR(32)
);

CREATE INDEX IF NOT EXISTS idx_user_age_declarations_user
    ON user_age_declarations (user_id, declared_at DESC);

-- 4. Preparation for future email verification (nullable, no retroactive fill)
ALTER TABLE user_credentials
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
