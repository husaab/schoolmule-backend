-- payments_requests_migration.sql
--
-- Payments, slice 4: the school asks families to pay (a payment request), and
-- a payment knows which child it is for.
--
--   payment_requests   something the office asks families to pay (a trip, a
--                      book fee): title, amount, due date, whether paying at
--                      the office is allowed. One charge per student it was
--                      sent to; the guardians get an email with their link.
--   charges.request_id the request a charge belongs to ('request' charges)
--   registration_form_submissions.student_id
--                      the child a signed-in parent picked on a public form
--                      (or the office linked later)
--   registration_form_submissions.submitted_by
--                      the signed-in parent who sent it
--
-- Entirely additive and safe to re-run. RLS on (the backend role bypasses it;
-- this closes the Data API path).

BEGIN;

CREATE TABLE IF NOT EXISTS payment_requests (
  request_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school          school NOT NULL,
  livemode        BOOLEAN NOT NULL,
  school_year_id  UUID REFERENCES school_years(school_year_id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  -- Shown to families in the email and on their payment page.
  description     TEXT,
  currency        CHAR(3) NOT NULL DEFAULT 'cad',
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  due_date        DATE,
  allow_offline   BOOLEAN NOT NULL DEFAULT true,
  accounting_code TEXT,
  created_by      UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_requests_school ON payment_requests (school, livemode, created_at DESC);
ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_source_type_check;
ALTER TABLE charges ADD CONSTRAINT charges_source_type_check
  CHECK (source_type IN ('form_submission','request'));
ALTER TABLE charges ADD COLUMN IF NOT EXISTS request_id UUID REFERENCES payment_requests(request_id) ON DELETE RESTRICT;
-- A student is asked once per request.
CREATE UNIQUE INDEX IF NOT EXISTS uq_charges_request_student ON charges (request_id, student_id)
  WHERE request_id IS NOT NULL AND student_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_charges_student ON charges (student_id) WHERE student_id IS NOT NULL;

ALTER TABLE registration_form_submissions
  ADD COLUMN IF NOT EXISTS student_id UUID REFERENCES students_all(student_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES users(user_id) ON DELETE SET NULL;

COMMIT;
