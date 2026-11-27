-- payments_tax_migration.sql
--
-- Payments: tax on forms and payment requests, and a response the office
-- entered for a family that never filled the form in.
--
--   tax_rates          the school's rates ("HST", 13%). A rate is stored in
--                      thousandths of a percent (13% is 13000). A removed rate
--                      is archived, never deleted: forms and requests that
--                      still name it keep working.
--   payment_settings   one row per school: the tax number shown on receipts
--   charge_lines.tax_* each line keeps its own copy of the tax name, rate and
--                      amount, so editing or removing a rate never rewrites a
--                      past payment. amount_cents stays the price as typed;
--                      tax_included says whether the tax is inside it.
--   charges.tax_cents  all the tax on the charge (added and included)
--   payment_requests.tax_rate_id, tax_mode
--                      the request's rate (or none) and whether it is added
--                      on top of the amount or already inside it
--   registration_form_submissions.entered_by
--                      the staff member who entered a response for a family
--
-- Entirely additive and safe to re-run. Existing rows have no tax. RLS on
-- (the backend role bypasses it; this closes the Data API path).

BEGIN;

CREATE TABLE IF NOT EXISTS tax_rates (
  tax_rate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school      school NOT NULL,
  name        TEXT NOT NULL,
  rate_milli  INTEGER NOT NULL CHECK (rate_milli > 0 AND rate_milli <= 100000),
  archived_at TIMESTAMPTZ,
  created_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One live rate per name per school.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_rates_name ON tax_rates (school, lower(name)) WHERE archived_at IS NULL;
ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS payment_settings (
  school     school PRIMARY KEY,
  -- Shown on receipts, e.g. a GST/HST number.
  tax_number TEXT,
  updated_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE payment_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE charge_lines
  ADD COLUMN IF NOT EXISTS tax_cents      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_name       TEXT,
  ADD COLUMN IF NOT EXISTS tax_rate_milli INTEGER,
  ADD COLUMN IF NOT EXISTS tax_included   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE charges ADD COLUMN IF NOT EXISTS tax_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS tax_rate_id UUID REFERENCES tax_rates(tax_rate_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tax_mode VARCHAR(10) NOT NULL DEFAULT 'added' CHECK (tax_mode IN ('added','included'));

-- A response the office entered for a family.
ALTER TABLE registration_form_submissions
  ADD COLUMN IF NOT EXISTS entered_by UUID REFERENCES users(user_id) ON DELETE SET NULL;

COMMIT;
