-- ============================================================
-- Muley, the in-product assistant: settings, conversations, messages and
-- proposed actions (2026-11-26).
--
-- ai_assistant_settings   one row per school; no row means Muley is off.
--                         A school is switched on by the platform owner,
--                         then per role.
-- assistant_conversations one per chat, owned by one person in one view
--                         (a teacher who is also a parent has separate
--                         staff and parent conversations). `refs` maps the
--                         short names the model is given (s1, c2) to the
--                         real ids, which the model never sees.
-- assistant_messages      the transcript, in a provider-neutral shape.
--                         Scrubbed before it is stored: no education number
--                         and no contact details.
-- assistant_actions       a change Muley proposed. Nothing is written to
--                         school data until the person applies it; the row
--                         keeps the exact arguments, what the person was
--                         shown, and the values before and after, so it can
--                         be undone. (Unused until writes ship.)
--
-- No foreign keys to students: student ids live inside JSON, so this is
-- untouched by the student enrolments redesign.
-- Additive only; safe to re-run. Apply before the backend that reads it.
-- Rollback: DROP TABLE assistant_actions, assistant_messages,
--           assistant_conversations, ai_assistant_settings;
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_assistant_settings (
  school                    public.school PRIMARY KEY,
  enabled                   BOOLEAN NOT NULL DEFAULT FALSE,
  role_teacher              BOOLEAN NOT NULL DEFAULT FALSE,
  role_admin                BOOLEAN NOT NULL DEFAULT FALSE,
  role_parent               BOOLEAN NOT NULL DEFAULT FALSE,
  allow_writes              BOOLEAN NOT NULL DEFAULT FALSE,  -- proposals at all
  allow_outward             BOOLEAN NOT NULL DEFAULT FALSE,  -- publish, announce, message
  self_serve                BOOLEAN NOT NULL DEFAULT FALSE,  -- the school's full admin may change the role switches
  transcript_retention_days SMALLINT NOT NULL DEFAULT 90 CHECK (transcript_retention_days BETWEEN 7 AND 365),
  updated_by                UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assistant_conversations (
  conversation_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                 public.school NOT NULL,
  user_id                UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  view                   TEXT NOT NULL CHECK (view IN ('ADMIN', 'TEACHER', 'PARENT')),
  school_year_id         UUID REFERENCES school_years(school_year_id) ON DELETE SET NULL,
  title                  TEXT,
  refs                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  active_turn_id         UUID,
  active_turn_started_at TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS assistant_conversations_owner
  ON assistant_conversations (user_id, view, last_message_at DESC);
CREATE INDEX IF NOT EXISTS assistant_conversations_retention
  ON assistant_conversations (school, last_message_at);

CREATE TABLE IF NOT EXISTS assistant_messages (
  message_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL REFERENCES assistant_conversations(conversation_id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,
  turn_id             UUID,
  role                TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'event')),
  content             TEXT,
  tool_calls          JSONB,   -- assistant: [{ id, name, args }]
  tool_call_id        TEXT,    -- tool: the call this answers
  tool_name           TEXT,
  display             JSONB,   -- what the person saw beside the text: { traces, cards, choices }
  model               TEXT,
  input_tokens        INTEGER,
  cached_input_tokens INTEGER,
  output_tokens       INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS assistant_actions (
  action_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES assistant_conversations(conversation_id) ON DELETE SET NULL,
  school          public.school NOT NULL,
  school_year_id  UUID REFERENCES school_years(school_year_id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(user_id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  tier            TEXT NOT NULL CHECK (tier IN ('reversible', 'outward')),
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applying', 'applied', 'undoing', 'undone', 'rejected', 'expired', 'failed')),
  title           TEXT NOT NULL,
  args            JSONB NOT NULL,
  preview         JSONB NOT NULL,
  before_state    JSONB NOT NULL,
  before_applied  JSONB,
  after_state     JSONB,
  args_hash       TEXT NOT NULL,
  tool_call_id    TEXT,
  apply_key       TEXT,
  undo_key        TEXT,
  result          JSONB,
  error_code      TEXT,
  error_message   TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at      TIMESTAMPTZ,
  applied_by      UUID REFERENCES users(user_id) ON DELETE SET NULL,
  undone_at       TIMESTAMPTZ,
  undone_by       UUID REFERENCES users(user_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_actions_toolcall
  ON assistant_actions (conversation_id, tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS assistant_actions_school ON assistant_actions (school, created_at DESC);
CREATE INDEX IF NOT EXISTS assistant_actions_user ON assistant_actions (user_id, created_at DESC);

-- Like every table here: RLS on with no policies, so only the backend's own
-- role reads them and Supabase's public API can't.
ALTER TABLE ai_assistant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_actions ENABLE ROW LEVEL SECURITY;

COMMIT;
