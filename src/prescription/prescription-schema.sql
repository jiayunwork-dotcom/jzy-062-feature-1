-- Schema for goal-driven absorption prescriptions (PostgreSQL 16).
-- Applied by the service at startup (idempotent), independently of the
-- calculations schema.

CREATE TABLE IF NOT EXISTS prescriptions (
    id          UUID PRIMARY KEY,
    request     JSONB NOT NULL,
    result      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prescriptions_created_at_idx
    ON prescriptions (created_at DESC);
