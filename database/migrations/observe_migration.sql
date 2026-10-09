-- ============================================================
-- Observe console: platform-owner observability.
-- Run in the Supabase SQL editor BEFORE deploying the backend
-- that carries middleware/observeRequest.js.
--
--   request_events : one row per authenticated API request
--   error_events   : one row per server-side error log line / crash
--   client_events  : browser-side errors beaconed by the frontend
--   login_events   : every sign-in attempt, success or not
--   users          : last_seen_at (5-min heartbeat), last_login_at
--
-- No foreign keys from the event tables to users: history must survive
-- a hard user delete. Safe to re-run: all DDL uses IF NOT EXISTS.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS request_events (
  event_id        BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id      TEXT,
  user_id         UUID,
  school          TEXT,
  role            TEXT,
  impersonator_id UUID,
  method          TEXT NOT NULL,
  route           TEXT NOT NULL,
  path            TEXT NOT NULL,
  status          SMALLINT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  ip              TEXT,
  user_agent      TEXT,
  error_message   TEXT
);
CREATE INDEX IF NOT EXISTS request_events_ts_idx       ON request_events (ts DESC);
CREATE INDEX IF NOT EXISTS request_events_user_ts_idx  ON request_events (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS request_events_route_ts_idx ON request_events (route, ts DESC);
CREATE INDEX IF NOT EXISTS request_events_err_ts_idx   ON request_events (ts DESC) WHERE status >= 400;
ALTER TABLE request_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS error_events (
  event_id    BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source      TEXT NOT NULL,
  request_id  TEXT,
  user_id     UUID,
  school      TEXT,
  route       TEXT,
  message     TEXT NOT NULL,
  stack       TEXT,
  fingerprint TEXT NOT NULL,
  context     JSONB
);
CREATE INDEX IF NOT EXISTS error_events_ts_idx    ON error_events (ts DESC);
CREATE INDEX IF NOT EXISTS error_events_fp_ts_idx ON error_events (fingerprint, ts DESC);
ALTER TABLE error_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS client_events (
  event_id    BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id     UUID,
  school      TEXT,
  role        TEXT,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  stack       TEXT,
  page        TEXT,
  user_agent  TEXT,
  request_id  TEXT,
  status      SMALLINT,
  fingerprint TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS client_events_ts_idx    ON client_events (ts DESC);
CREATE INDEX IF NOT EXISTS client_events_fp_ts_idx ON client_events (fingerprint, ts DESC);
ALTER TABLE client_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS login_events (
  event_id   BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  email      TEXT NOT NULL,
  user_id    UUID,
  school     TEXT,
  outcome    TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS login_events_ts_idx ON login_events (ts DESC);
ALTER TABLE login_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_last_seen_idx ON users (last_seen_at DESC) WHERE last_seen_at IS NOT NULL;

COMMIT;
