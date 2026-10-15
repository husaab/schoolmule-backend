-- finance_manual_credits_migration.sql
--
-- Manual prepaid credits for the Finance → Tuition page.
--
-- Why: QuickBooks' "automatically apply credits" is one company-wide switch.
-- For subsidy families it can land a prepayment on the Al-Ma'arif grant
-- invoice, so the bookkeeper applies those credits by hand, later. Until they
-- do, the money sits in QBO as an unapplied deposit and the grid would show
-- the month as unpaid. A manual credit records "this family prepaid $X for
-- month M" in SchoolMule only.
--
-- Rules (enforced in services/finance/ledger.js):
--   • Only ever reduces the PARENT stream; grant/school-subsidy invoices are untouched.
--   • Capped at the month's open parent balance, so it can never double-count a
--     credit that has since been applied in QBO (that shows a
--     MANUAL_CREDIT_SUPERSEDED warning so the admin can delete the entry).
--   • A month without an invoice yet keeps the credit as "prepaid, waiting".
--
-- No money is written to QBO. Additive and safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS finance_manual_credits (
  credit_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school          school NOT NULL,
  school_year_id  UUID NOT NULL REFERENCES school_years(school_year_id) ON DELETE CASCADE,
  family_id       UUID NOT NULL,
  month_key       CHAR(7) NOT NULL CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  note            TEXT,
  qbo_deposit_id  TEXT CHECK (qbo_deposit_id IS NULL OR qbo_deposit_id ~ '^[0-9]+$'),
  created_by      UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_id, month_key),
  FOREIGN KEY (school, family_id) REFERENCES families(school, family_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_finance_manual_credits_year ON finance_manual_credits (school, school_year_id);

ALTER TABLE finance_manual_credits ENABLE ROW LEVEL SECURITY;

-- Audit the two new actions.
ALTER TABLE family_link_audit DROP CONSTRAINT IF EXISTS family_link_audit_action_check;
ALTER TABLE family_link_audit ADD CONSTRAINT family_link_audit_action_check CHECK (action IN (
  'family_create','family_update','family_delete',
  'customer_link','customer_unlink',
  'student_add','student_remove',
  'contact_add','contact_update','contact_remove',
  'invoice_kind_override','seed',
  'manual_credit_set','manual_credit_remove'));

COMMIT;
