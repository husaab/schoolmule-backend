-- payments_form_charges_migration.sql
--
-- Payments, slice 3: a form can ask for payment, and what is owed and paid is
-- kept in a small ledger that any future source (an assigned fee, a shop
-- order, a tuition instalment) can share.
--
--   registration_form_fields.payment_config
--                      the price list on a 'payment' field: items (id, label,
--                      price in cents, required or optional), whether paying at
--                      the office is allowed, an optional accounting code
--   charges            what is owed: by whom, for which form response, how
--                      much, and where it stands (unpaid … paid, refunded)
--   charge_lines       a copy of the items chosen, so editing the form later
--                      never rewrites what a family was charged
--   charge_payments    what happened: card, cash, cheque, a waiver or a refund,
--                      with Stripe's ids where Stripe was involved
--
-- Money is integer cents with a currency, never a float. Stripe ids are
-- unique so a repeated webhook or a second click records a payment once.
-- `livemode` keeps live and test apart, as in payment_accounts.
--
-- Entirely additive and safe to re-run. RLS on (the backend role bypasses it;
-- this closes the Data API path).

BEGIN;

-- ─── The payment field ───
ALTER TABLE registration_form_fields DROP CONSTRAINT IF EXISTS registration_form_fields_field_type_check;
ALTER TABLE registration_form_fields ADD CONSTRAINT registration_form_fields_field_type_check
  CHECK (field_type IN ('text','email','phone','date','select','radio','textarea','payment'));
ALTER TABLE registration_form_fields ADD COLUMN IF NOT EXISTS payment_config JSONB;

-- ─── What is owed ───
CREATE TABLE IF NOT EXISTS charges (
  charge_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                school NOT NULL,
  livemode              BOOLEAN NOT NULL,
  source_type           VARCHAR(30) NOT NULL DEFAULT 'form_submission'
                        CHECK (source_type IN ('form_submission')),
  submission_id         UUID UNIQUE REFERENCES registration_form_submissions(submission_id) ON DELETE RESTRICT,
  form_id               UUID REFERENCES registration_forms(form_id) ON DELETE RESTRICT,
  -- The form's payment field when the charge was made (the field may be deleted later).
  field_id              UUID,
  student_id            UUID REFERENCES students_all(student_id) ON DELETE SET NULL,
  payer_email           TEXT,
  -- What the family sees on Stripe's page and its receipt (the form's title).
  description           TEXT NOT NULL,
  currency              CHAR(3) NOT NULL DEFAULT 'cad',
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  amount_paid_cents     INTEGER NOT NULL DEFAULT 0,
  amount_refunded_cents INTEGER NOT NULL DEFAULT 0,
  status                VARCHAR(20) NOT NULL DEFAULT 'unpaid'
                        CHECK (status IN ('unpaid','partially_paid','paid','partially_refunded','refunded','waived')),
  -- 'card' when the family chose to pay online, 'offline' when they chose the office.
  chosen_method         VARCHAR(10) NOT NULL DEFAULT 'card' CHECK (chosen_method IN ('card','offline')),
  paid_at               TIMESTAMPTZ,
  accounting_code       TEXT,
  -- The secret in the family's link to this charge (/pay/<token>).
  public_token          UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  payment_account_id    UUID REFERENCES payment_accounts(payment_account_id) ON DELETE SET NULL,
  -- The latest Stripe Checkout page opened for it.
  checkout_session_id   TEXT,
  checkout_url          TEXT,
  checkout_expires_at   TIMESTAMPTZ,
  checkout_attempts     INTEGER NOT NULL DEFAULT 0,
  -- The one automatic "finish paying" email, and the last one the office sent.
  reminder_sent_at      TIMESTAMPTZ,
  link_sent_at          TIMESTAMPTZ,
  dispute_status        VARCHAR(30),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_charges_school ON charges (school, livemode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_charges_form ON charges (form_id);
CREATE INDEX IF NOT EXISTS idx_charges_checkout ON charges (checkout_session_id) WHERE checkout_session_id IS NOT NULL;
ALTER TABLE charges ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS charge_lines (
  line_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id    UUID NOT NULL REFERENCES charges(charge_id) ON DELETE CASCADE,
  item_id      TEXT,
  label        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_charge_lines_charge ON charge_lines (charge_id);
ALTER TABLE charge_lines ENABLE ROW LEVEL SECURITY;

-- ─── What happened ───
CREATE TABLE IF NOT EXISTS charge_payments (
  payment_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id                  UUID NOT NULL REFERENCES charges(charge_id) ON DELETE CASCADE,
  school                     school NOT NULL,
  kind                       VARCHAR(10) NOT NULL CHECK (kind IN ('card','cash','cheque','other','waiver','refund')),
  amount_cents               INTEGER NOT NULL CHECK (amount_cents >= 0),
  status                     VARCHAR(10) NOT NULL DEFAULT 'succeeded'
                             CHECK (status IN ('pending','succeeded','failed','voided')),
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id   TEXT,
  stripe_charge_id           TEXT,
  stripe_refund_id           TEXT UNIQUE,
  card_brand                 TEXT,
  card_last4                 TEXT,
  wallet                     TEXT,
  stripe_fee_cents           INTEGER,
  -- The office's note (a cheque number, why a fee was waived). Never sent to Stripe.
  note                       TEXT,
  recorded_by                UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at                  TIMESTAMPTZ,
  voided_by                  UUID REFERENCES users(user_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_charge_payments_charge ON charge_payments (charge_id, created_at);
CREATE INDEX IF NOT EXISTS idx_charge_payments_intent ON charge_payments (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
ALTER TABLE charge_payments ENABLE ROW LEVEL SECURITY;

COMMIT;
