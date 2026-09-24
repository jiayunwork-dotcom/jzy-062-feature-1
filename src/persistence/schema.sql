-- Schema for the room-acoustics service (PostgreSQL 16).
-- Applied by the service at startup (idempotent).

CREATE TABLE IF NOT EXISTS rooms (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    volume      DOUBLE PRECISION NOT NULL CHECK (volume > 0),
    surfaces    JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calculations (
    id          UUID PRIMARY KEY,
    room_id     UUID NOT NULL REFERENCES rooms (id),
    request     JSONB NOT NULL,
    result      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calculations_created_at_idx
    ON calculations (created_at DESC);

CREATE INDEX IF NOT EXISTS calculations_room_id_idx
    ON calculations (room_id);
