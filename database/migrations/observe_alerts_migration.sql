-- Observe alerts: incidents, what was sent about them, per-rule settings and
-- the boot log behind the crash-loop rule. The rules themselves live in code
-- (services/observe/alerts/rules.js); this only stores the owner's overrides.
--
-- Run BEFORE deploying the backend that starts the alert worker. Idempotent.
-- RLS on with no policies, like the other Observe tables: only the API's own
-- connection reads them.

BEGIN;

-- One row per incident. At most one is open at a time (alert_incidents_one_open),
-- which is also how two replicas agree on a single incident.
CREATE TABLE IF NOT EXISTS alert_incidents (
  incident_id           UUID PRIMARY KEY,   -- generated in the worker, so an incident opened while the database was down keeps its id
  status                TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  tier                  TEXT NOT NULL CHECK (tier IN ('critical', 'warning', 'info')),
  title                 TEXT NOT NULL,
  subject               TEXT,               -- fixed by the first email; every later email threads on it
  opened_at             TIMESTAMPTZ NOT NULL,
  last_trip_at          TIMESTAMPTZ NOT NULL,
  resolved_at           TIMESTAMPTZ,
  reopen_count          INTEGER NOT NULL DEFAULT 0,
  -- What has been sent. Each is claimed with a conditional UPDATE before the
  -- send, so only one replica sends it.
  notified_at           TIMESTAMPTZ,
  notified_tier         TEXT CHECK (notified_tier IN ('critical', 'warning', 'info')),
  last_reminder_at      TIMESTAMPTZ,
  reopen_pending        BOOLEAN NOT NULL DEFAULT FALSE,
  recovered_notified_at TIMESTAMPTZ,
  summarized_at         TIMESTAMPTZ,
  rules                 JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { ruleId: { name, tier, firstAt, lastAt, peak, summary } }
  stats                 JSONB NOT NULL DEFAULT '{}'::jsonb,  -- totals while open: failed requests, people, top errors
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS alert_incidents_one_open ON alert_incidents ((TRUE)) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS alert_incidents_opened_idx ON alert_incidents (opened_at DESC);
ALTER TABLE alert_incidents ENABLE ROW LEVEL SECURITY;

-- Every email and push attempt. Also the ledger behind the hourly email cap.
CREATE TABLE IF NOT EXISTS alert_notifications (
  notification_id BIGSERIAL PRIMARY KEY,
  incident_id     UUID REFERENCES alert_incidents(incident_id) ON DELETE CASCADE,  -- NULL for tests and summaries
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel         TEXT NOT NULL CHECK (channel IN ('email', 'push')),
  kind            TEXT NOT NULL CHECK (kind IN ('opened', 'escalated', 'reminder', 'reopened', 'recovered', 'summary', 'test')),
  ok              BOOLEAN NOT NULL,
  recipients      INTEGER NOT NULL DEFAULT 0,
  subject         TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS alert_notifications_ts_idx ON alert_notifications (ts DESC);
CREATE INDEX IF NOT EXISTS alert_notifications_incident_idx ON alert_notifications (incident_id, ts);
ALTER TABLE alert_notifications ENABLE ROW LEVEL SECURITY;

-- The owner's changes to a built-in rule. NULL means "the rule's default".
CREATE TABLE IF NOT EXISTS alert_rule_overrides (
  rule_id     TEXT PRIMARY KEY,
  enabled     BOOLEAN,
  mode        TEXT CHECK (mode IN ('live', 'watch')),
  params      JSONB,                -- only the numbers that differ from the default
  muted_until TIMESTAMPTZ,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE alert_rule_overrides ENABLE ROW LEVEL SECURITY;

-- When each rule tripped (at most every 15 minutes per rule), live or not:
-- "last tripped" in the console and the record a watch-only week is judged on.
CREATE TABLE IF NOT EXISTS alert_rule_trips (
  trip_id BIGSERIAL PRIMARY KEY,
  rule_id TEXT NOT NULL,
  ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mode    TEXT NOT NULL CHECK (mode IN ('live', 'watch', 'muted')),
  value   DOUBLE PRECISION,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS alert_rule_trips_rule_ts_idx ON alert_rule_trips (rule_id, ts DESC);
ALTER TABLE alert_rule_trips ENABLE ROW LEVEL SECURITY;

-- One row per server start, for the crash-loop rule.
CREATE TABLE IF NOT EXISTS alert_boots (
  boot_id   BIGSERIAL PRIMARY KEY,
  booted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS alert_boots_at_idx ON alert_boots (booted_at DESC);
ALTER TABLE alert_boots ENABLE ROW LEVEL SECURITY;

COMMIT;
