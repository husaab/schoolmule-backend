-- payments_stripe_events_migration.sql
--
-- Payments, slice 2: what Stripe tells us, kept until it has been acted on.
--
--   stripe_events   one row per Stripe event we act on: the inbox the webhook
--                   endpoint writes to and the queue the payments worker drains
--
-- Stripe delivers an event more than once and in no fixed order. The event id
-- is the primary key, so a repeat is dropped at the door; the worker then
-- reads the current state from Stripe rather than trusting the event's copy.
-- That is also why no payload is stored: nothing here holds a payer's details.
--
-- `livemode` keeps live and test apart, as in payment_accounts: a process
-- with a test key only ever claims test events.
--
-- This is the platform's own table (events are about a Stripe account, found
-- through payment_accounts), so it has no `school` column. Entirely additive
-- and safe to re-run. RLS on (the backend role bypasses it; this closes the
-- Data API path).

BEGIN;

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id          TEXT PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9_]+$'),
  livemode          BOOLEAN NOT NULL,
  type              TEXT NOT NULL,
  -- The connected account the event is about; NULL for the platform's own.
  stripe_account_id TEXT,
  -- The id of the object the event carries (an account, later a checkout session, a charge…).
  object_id         TEXT,
  stripe_created_at TIMESTAMPTZ,
  state             VARCHAR(20) NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','running','done','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at        TIMESTAMPTZ,
  last_error        TEXT,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_ready
  ON stripe_events (livemode, next_attempt_at) WHERE state IN ('queued','running');

ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;

COMMIT;
