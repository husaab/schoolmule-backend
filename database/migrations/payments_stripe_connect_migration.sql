-- payments_stripe_connect_migration.sql
--
-- Payments, slice 1: a school connects its own Stripe account.
--
--   payment_accounts   one Stripe connected account per school and per Stripe
--                      mode (live or test), with the last status Stripe gave us
--
-- The school is the merchant: Stripe bills it directly, pays out to its bank
-- and carries the risk. SchoolMule holds no money and stores no Stripe secret
-- per school; the account id plus the platform key is all a call needs.
--
-- `livemode` is part of the key on purpose. A backend running with a test key
-- (any local backend: its database is the production one) reads and writes
-- only test rows, so it can never touch a school's real Stripe account.
--
-- Entirely additive and safe to re-run. RLS on (the backend role bypasses it;
-- this closes the Data API path).

BEGIN;

CREATE TABLE IF NOT EXISTS payment_accounts (
  payment_account_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                school NOT NULL,
  livemode              BOOLEAN NOT NULL,
  stripe_account_id     TEXT NOT NULL UNIQUE CHECK (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  -- onboarding   Stripe still needs information from the school
  -- pending      everything is in; Stripe is checking it
  -- active       the school can take card payments
  -- restricted   it could before and now cannot (Stripe needs more, or paused it)
  -- disconnected the school turned payments off in SchoolMule; the Stripe
  --              account still exists and reconnecting picks it up again
  status                VARCHAR(20) NOT NULL DEFAULT 'onboarding'
                        CHECK (status IN ('onboarding','pending','active','restricted','disconnected')),
  -- Stripe's own capability statuses: active | pending | restricted | unsupported.
  card_payments_status  VARCHAR(20),
  payouts_status        VARCHAR(20),
  -- How many items Stripe is waiting on the school for right now.
  requirements_due      INTEGER NOT NULL DEFAULT 0,
  requirements_past_due BOOLEAN NOT NULL DEFAULT false,
  display_name          TEXT,
  country               CHAR(2) NOT NULL DEFAULT 'ca',
  default_currency      CHAR(3) NOT NULL DEFAULT 'cad',
  -- First time card payments became active; tells "still setting up" from
  -- "was working, now is not".
  activated_at          TIMESTAMPTZ,
  last_synced_at        TIMESTAMPTZ,
  last_error            TEXT,
  connected_by          UUID REFERENCES users(user_id) ON DELETE SET NULL,
  connected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at       TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school, livemode)
);

ALTER TABLE payment_accounts ENABLE ROW LEVEL SECURITY;

COMMIT;
