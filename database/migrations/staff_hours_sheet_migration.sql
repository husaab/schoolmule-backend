-- staff_hours_sheet_migration.sql
--
-- Staff hours → Google Sheet. Run AFTER google_sheets_sync_migration.sql.
--
-- Two changes:
--   staff_hours_sheet_links  one spreadsheet per school. Tabs (an Overview
--                            plus one per pay day) are resolved by title at
--                            sync time, so there are no per-tab rows.
--   sheet_sync_jobs          generalized from "one form" to "one target":
--                            kind = 'form' (form_id) or 'staff_hours' (school).
--                            One worker drains both.
--
-- Entirely additive and safe to re-run. Existing jobs become kind = 'form'
-- through the column default, so a backend deployed before this migration
-- keeps queueing form syncs exactly as before.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_hours_sheet_links (
  link_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school           school NOT NULL UNIQUE,
  spreadsheet_id   TEXT NOT NULL,
  spreadsheet_name TEXT,
  -- Widest owned block ever written per tab, keyed by tab title. A sync reads
  -- max(stored, computed) columns so a period that shrank after a pay-schedule
  -- change still gets its stale trailing cells blanked, and column growth on
  -- the Overview tab inserts columns instead of overwriting the school's own.
  tab_widths       JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at   TIMESTAMPTZ,
  last_error       TEXT,
  created_by       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Defense in depth, matching staff_pay_schedules: the backend connects as a
-- role that bypasses RLS, so this only closes the Data API path.
ALTER TABLE staff_hours_sheet_links ENABLE ROW LEVEL SECURITY;

-- Generalize the outbox.
ALTER TABLE sheet_sync_jobs
  ADD COLUMN IF NOT EXISTS kind   VARCHAR(20) NOT NULL DEFAULT 'form',
  ADD COLUMN IF NOT EXISTS school school;
ALTER TABLE sheet_sync_jobs ALTER COLUMN form_id DROP NOT NULL;

ALTER TABLE sheet_sync_jobs DROP CONSTRAINT IF EXISTS sheet_sync_jobs_kind_check;
ALTER TABLE sheet_sync_jobs ADD CONSTRAINT sheet_sync_jobs_kind_check CHECK (
  (kind = 'form'        AND form_id IS NOT NULL AND school IS NULL) OR
  (kind = 'staff_hours' AND school  IS NOT NULL AND form_id IS NULL)
);

-- Coalescing, still enforced by the schema: at most one live job per target.
-- Both enqueue statements rely on ON CONFLICT DO NOTHING, which (with no
-- conflict target) catches a violation of either partial index.
DROP INDEX IF EXISTS idx_sheet_sync_jobs_live;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sheet_sync_jobs_live_form
  ON sheet_sync_jobs (form_id) WHERE kind = 'form' AND state IN ('pending', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_sheet_sync_jobs_live_staff_hours
  ON sheet_sync_jobs (school) WHERE kind = 'staff_hours' AND state IN ('pending', 'running');

COMMIT;
