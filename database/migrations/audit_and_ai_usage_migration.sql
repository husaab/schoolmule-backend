-- ============================================================
-- Audit log and AI usage counters (2026-11-26).
--
-- audit_log: who changed what, and what it was before. Append-only. One row
-- per change a person can be asked about later ("who replaced the stamp?").
-- The first writers are the school asset replace, delete and restore; the
-- Muley assistant will write here for everything it applies, and the
-- gradebook and attendance saves can join later by calling one helper
-- (services/audit/auditLog.js). `changes` holds ids, labels and values only:
-- never an education number or a contact detail.
--
-- ai_usage_daily: one row per person, day (America/Toronto) and AI feature,
-- counting requests and tokens. It backs a daily limit per person and a
-- monthly limit per school, so one account can't spend the shared OpenAI key
-- without end. No foreign key to users on purpose: deleting an account keeps
-- the usage it ran up.
--
-- Additive only; safe to re-run. Apply before the backend that writes them
-- (both writers fail open, so an older database only loses the records).
-- Rollback: DROP TABLE audit_log; DROP TABLE ai_usage_daily;
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  school              public.school NOT NULL,
  school_year_id      UUID REFERENCES school_years(school_year_id) ON DELETE SET NULL,
  actor_user_id       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  actor_view          TEXT,
  source              TEXT NOT NULL CHECK (source IN ('ui', 'assistant', 'system')),
  action              TEXT NOT NULL,   -- 'school_asset.replace', later 'scores.upsert'
  entity_type         TEXT NOT NULL,   -- 'school_asset', later 'class'
  entity_id           UUID,
  summary             TEXT NOT NULL,
  changes             JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ key, label, before, after }]
  request_id          TEXT,
  assistant_action_id UUID
);

CREATE INDEX IF NOT EXISTS audit_log_school_ts ON audit_log (school, ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity ON audit_log (school, entity_type, entity_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_assistant_action
  ON audit_log (assistant_action_id) WHERE assistant_action_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  user_id             UUID NOT NULL,
  day                 DATE NOT NULL,
  feature             TEXT NOT NULL,
  school              public.school NOT NULL,
  requests            INTEGER NOT NULL DEFAULT 0,
  input_tokens        BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, feature)
);

CREATE INDEX IF NOT EXISTS ai_usage_daily_school_day ON ai_usage_daily (school, day);

-- Like every table here: RLS on with no policies, so only the backend's own
-- role reads them and Supabase's public API can't.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;

COMMIT;
