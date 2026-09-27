-- finance_qbo_migration.sql
--
-- Finance → Tuition: a read-only mirror of a school's QuickBooks Online books
-- plus the SchoolMule-side link from students to the family (household) that
-- pays for them and the QBO customer that family is billed under.
--
--   finance_qbo_connections  one QBO company (realm) per school, encrypted
--                            rotating refresh token, sync cursor
--   families / family_students / family_contacts / family_customer_links
--                            the household model, per school year
--   family_link_audit        who linked/unlinked what, append-only
--   qbo_customers / qbo_invoices / qbo_invoice_lines / qbo_payments /
--   qbo_payment_applications cached QBO entities (latest raw payload kept)
--   finance_sync_jobs / finance_sync_runs
--                            the outbox the worker drains, and its run log
--
-- Money is NEVER entered here; QBO stays the source of truth. Entirely
-- additive and safe to re-run. Every table is school-scoped and has RLS on
-- (the backend role bypasses it; this closes the Data API path).

BEGIN;

-- ─── Connection: one QBO company (realm) per school, one school per realm ───
CREATE TABLE IF NOT EXISTS finance_qbo_connections (
  connection_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                  school NOT NULL UNIQUE,
  realm_id                TEXT NOT NULL UNIQUE CHECK (realm_id ~ '^[0-9]+$'),
  company_name            TEXT,
  -- AES-256-GCM under QBO_TOKEN_ENC_KEY. Never logged, never returned by the API.
  refresh_token           TEXT,
  refresh_token_version   INTEGER NOT NULL DEFAULT 0,
  access_token            TEXT,
  access_token_expires_at TIMESTAMPTZ,
  status                  VARCHAR(20) NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','needs_reconnect','disconnected')),
  -- Per-school knobs: QBO item ids, backfill start, subsidy note prefixes, grant label.
  settings                JSONB NOT NULL DEFAULT '{}'::jsonb,
  cdc_cursor              TIMESTAMPTZ,
  backfill_completed_at   TIMESTAMPTZ,
  last_success_at         TIMESTAMPTZ,
  last_error              TEXT,
  consecutive_failures    INTEGER NOT NULL DEFAULT 0,
  alerted_at              TIMESTAMPTZ,
  connected_by            UUID REFERENCES users(user_id) ON DELETE SET NULL,
  connected_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school, realm_id)
);

-- ─── Families (SchoolMule side, per school year) ───
CREATE TABLE IF NOT EXISTS families (
  family_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                   school NOT NULL,
  school_year_id           UUID NOT NULL REFERENCES school_years(school_year_id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  is_subsidy               BOOLEAN NOT NULL DEFAULT false,
  is_teacher               BOOLEAN NOT NULL DEFAULT false,
  expected_monthly_parent  NUMERIC(12,2),
  expected_monthly_subsidy NUMERIC(12,2),
  notes                    TEXT,
  roster_family_no         INTEGER,
  created_by               UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school, family_id)                          -- target of the school-carrying FK below
);
CREATE INDEX IF NOT EXISTS idx_families_year ON families (school, school_year_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_families_roster_no
  ON families (school, school_year_id, roster_family_no) WHERE roster_family_no IS NOT NULL;

-- Which QBO customer bills the family, with date ranges so a mid-year switch
-- keeps old invoices attached and a re-used customer is never double counted.
CREATE TABLE IF NOT EXISTS family_customer_links (
  link_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school           school NOT NULL,
  family_id        UUID NOT NULL,
  -- Denormalized from the family: families are per year, so "one open link per
  -- customer" must be per year too, or last year's links block this year's.
  school_year_id   UUID NOT NULL REFERENCES school_years(school_year_id) ON DELETE CASCADE,
  qbo_customer_id  TEXT NOT NULL CHECK (qbo_customer_id ~ '^[0-9]+$'),
  effective_from   DATE NOT NULL,
  effective_to     DATE,
  created_by       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A link can only point at a family of the same school.
  FOREIGN KEY (school, family_id) REFERENCES families(school, family_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fcl_open_per_family
  ON family_customer_links (family_id) WHERE effective_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fcl_open_per_customer
  ON family_customer_links (school, school_year_id, qbo_customer_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_fcl_customer ON family_customer_links (school, qbo_customer_id);

-- Students are per-year rows, so UNIQUE(student_id) = one family per student per year.
CREATE TABLE IF NOT EXISTS family_students (
  family_id   UUID NOT NULL REFERENCES families(family_id) ON DELETE CASCADE,
  student_id  UUID NOT NULL UNIQUE REFERENCES students(student_id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, student_id)
);

-- A student can only join a family of its own school and school year. The
-- insert SQL enforces this too; the trigger is defense in depth for the
-- seeder and rollover paths that write SQL directly.
CREATE OR REPLACE FUNCTION trg_family_students_same_year_fn() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM students s JOIN families f ON f.family_id = NEW.family_id
    WHERE s.student_id = NEW.student_id
      AND s.school = f.school AND s.school_year_id = f.school_year_id
  ) THEN
    RAISE EXCEPTION 'student % is not in the same school and school year as family %', NEW.student_id, NEW.family_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_family_students_same_year ON family_students;
CREATE TRIGGER trg_family_students_same_year
  BEFORE INSERT OR UPDATE ON family_students
  FOR EACH ROW EXECUTE FUNCTION trg_family_students_same_year_fn();

CREATE TABLE IF NOT EXISTS family_contacts (
  contact_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   UUID NOT NULL REFERENCES families(family_id) ON DELETE CASCADE,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  relation    VARCHAR(20) CHECK (relation IS NULL OR relation IN ('mother','father','guardian','other')),
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  user_id     UUID REFERENCES users(user_id) ON DELETE SET NULL,
  source      VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('roster','student_record','manual')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (name IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_contacts_email   ON family_contacts (family_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_contacts_primary ON family_contacts (family_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_family_contacts_email ON family_contacts (lower(email));
CREATE INDEX IF NOT EXISTS idx_family_contacts_user  ON family_contacts (user_id) WHERE user_id IS NOT NULL;

-- Append-only history of link/contact changes. No FK on family_id so it survives deletion.
CREATE TABLE IF NOT EXISTS family_link_audit (
  audit_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school              school NOT NULL,
  school_year_id      UUID REFERENCES school_years(school_year_id) ON DELETE SET NULL,
  family_id           UUID,
  family_name         TEXT NOT NULL,
  action              VARCHAR(30) NOT NULL CHECK (action IN (
                        'family_create','family_update','family_delete',
                        'customer_link','customer_unlink',
                        'student_add','student_remove',
                        'contact_add','contact_update','contact_remove',
                        'invoice_kind_override','seed')),
  old_qbo_customer_id TEXT,
  new_qbo_customer_id TEXT,
  student_id          UUID,
  invoice_qbo_id      TEXT,
  details             JSONB,
  actor_user_id       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_link_audit_family ON family_link_audit (school, family_id, created_at DESC);

-- ─── QBO cache (read-only mirror; latest raw payload kept on each row) ───
CREATE TABLE IF NOT EXISTS qbo_customers (
  school               school NOT NULL,
  realm_id             TEXT NOT NULL,
  qbo_id               TEXT NOT NULL CHECK (qbo_id ~ '^[0-9]+$'),
  display_name         TEXT NOT NULL,
  fully_qualified_name TEXT,
  parent_qbo_id        TEXT,
  is_sub_customer      BOOLEAN NOT NULL DEFAULT false,
  active               BOOLEAN NOT NULL DEFAULT true,
  balance              NUMERIC(12,2),               -- display only; NEVER used in math
  emails               TEXT[] NOT NULL DEFAULT '{}',
  phone                TEXT,
  sync_token           INTEGER,
  last_updated_time    TIMESTAMPTZ NOT NULL,
  deleted_at           TIMESTAMPTZ,
  raw                  JSONB NOT NULL,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school, qbo_id),
  FOREIGN KEY (school, realm_id) REFERENCES finance_qbo_connections(school, realm_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qbo_customers_name   ON qbo_customers (school, lower(display_name));
CREATE INDEX IF NOT EXISTS idx_qbo_customers_emails ON qbo_customers USING GIN (emails);

CREATE TABLE IF NOT EXISTS qbo_invoices (
  school             school NOT NULL,
  realm_id           TEXT NOT NULL,
  qbo_id             TEXT NOT NULL CHECK (qbo_id ~ '^[0-9]+$'),
  doc_number         TEXT,
  customer_qbo_id    TEXT NOT NULL,
  txn_date           DATE NOT NULL,
  due_date           DATE,
  month_key          DATE GENERATED ALWAYS AS (make_date(extract(year from txn_date)::int, extract(month from txn_date)::int, 1)) STORED,
  total_amt          NUMERIC(12,2) NOT NULL,
  balance            NUMERIC(12,2) NOT NULL,
  email_status       VARCHAR(20),
  private_note       TEXT,
  customer_memo      TEXT,
  recurring_ref      TEXT,
  sync_token         INTEGER,
  last_updated_time  TIMESTAMPTZ NOT NULL,
  is_voided          BOOLEAN NOT NULL DEFAULT false,
  deleted_at         TIMESTAMPTZ,
  -- Classification: derived on every upsert; a manual override wins.
  kind_auto          VARCHAR(20) NOT NULL CHECK (kind_auto IN ('parent','subsidy_grant','subsidy_school','other')),
  kind_override      VARCHAR(20) CHECK (kind_override IN ('parent','subsidy_grant','subsidy_school','other')),
  kind               VARCHAR(20) GENERATED ALWAYS AS (COALESCE(kind_override, kind_auto)) STORED,
  override_by        UUID REFERENCES users(user_id) ON DELETE SET NULL,
  override_at        TIMESTAMPTZ,
  raw                JSONB NOT NULL,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school, qbo_id),
  FOREIGN KEY (school, realm_id) REFERENCES finance_qbo_connections(school, realm_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qbo_invoices_customer_month ON qbo_invoices (school, customer_qbo_id, month_key);
CREATE INDEX IF NOT EXISTS idx_qbo_invoices_month ON qbo_invoices (school, month_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_qbo_invoices_open  ON qbo_invoices (school, due_date) WHERE balance > 0 AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS qbo_invoice_lines (
  school          school NOT NULL,
  invoice_qbo_id  TEXT NOT NULL,
  line_num        INTEGER NOT NULL,
  line_id         TEXT,
  detail_type     TEXT,
  description     TEXT,
  amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  item_ref        TEXT,
  item_name       TEXT,
  qty             NUMERIC(12,4),
  unit_price      NUMERIC(12,2),
  student_hint    TEXT,
  PRIMARY KEY (school, invoice_qbo_id, line_num),
  FOREIGN KEY (school, invoice_qbo_id) REFERENCES qbo_invoices(school, qbo_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS qbo_payments (
  school             school NOT NULL,
  realm_id           TEXT NOT NULL,
  qbo_id             TEXT NOT NULL CHECK (qbo_id ~ '^[0-9]+$'),
  customer_qbo_id    TEXT NOT NULL,
  txn_date           DATE NOT NULL,
  total_amt          NUMERIC(12,2) NOT NULL,
  unapplied_amt      NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method     TEXT,
  payment_ref_num    TEXT,
  private_note       TEXT,
  deposit_account    TEXT,
  sync_token         INTEGER,
  last_updated_time  TIMESTAMPTZ NOT NULL,
  deleted_at         TIMESTAMPTZ,
  raw                JSONB NOT NULL,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school, qbo_id),
  FOREIGN KEY (school, realm_id) REFERENCES finance_qbo_connections(school, realm_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qbo_payments_customer ON qbo_payments (school, customer_qbo_id, txn_date);

-- Payment.Line[].LinkedTxn where TxnType = 'Invoice'. Rebuilt per payment on
-- every upsert. No FK to qbo_invoices: the invoice may be outside the window.
CREATE TABLE IF NOT EXISTS qbo_payment_applications (
  school          school NOT NULL,
  payment_qbo_id  TEXT NOT NULL,
  invoice_qbo_id  TEXT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  PRIMARY KEY (school, payment_qbo_id, invoice_qbo_id),
  FOREIGN KEY (school, payment_qbo_id) REFERENCES qbo_payments(school, qbo_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qpa_invoice ON qbo_payment_applications (school, invoice_qbo_id);

-- ─── Sync outbox + run log ───
CREATE TABLE IF NOT EXISTS finance_sync_jobs (
  job_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school          school NOT NULL,
  kind            VARCHAR(20) NOT NULL CHECK (kind IN ('backfill','cdc','manual')),
  state           VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  claimed_at      TIMESTAMPTZ,                    -- lease: a stale 'running' claim is reclaimed
  failed_at       TIMESTAMPTZ,                    -- when the job gave up; drives the retry cooldown
  requested_by    UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One live job per school regardless of kind, so a Sync-now during the
-- scheduled tick coalesces and a running backfill suppresses cdc enqueues.
CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_sync_jobs_live  ON finance_sync_jobs (school) WHERE state IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_finance_sync_jobs_ready ON finance_sync_jobs (next_attempt_at) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS finance_sync_runs (
  run_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school             school NOT NULL,
  job_id             UUID,
  kind               VARCHAR(20) NOT NULL CHECK (kind IN ('backfill','cdc','manual')),
  mode               VARCHAR(20) NOT NULL CHECK (mode IN ('full','cdc')),
  status             VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','failed')),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,
  cursor_from        TIMESTAMPTZ,
  cursor_to          TIMESTAMPTZ,
  customers_upserted INTEGER NOT NULL DEFAULT 0,
  invoices_upserted  INTEGER NOT NULL DEFAULT 0,
  payments_upserted  INTEGER NOT NULL DEFAULT 0,
  deleted_flagged    INTEGER NOT NULL DEFAULT 0,
  api_calls          INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  triggered_by       UUID REFERENCES users(user_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_finance_sync_runs_school ON finance_sync_runs (school, started_at DESC);

ALTER TABLE finance_qbo_connections  ENABLE ROW LEVEL SECURITY;
ALTER TABLE families                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_customer_links    ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_students          ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_contacts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_link_audit        ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_customers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_invoices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_invoice_lines        ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_payments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_payment_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_sync_jobs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_sync_runs        ENABLE ROW LEVEL SECURITY;

COMMIT;
