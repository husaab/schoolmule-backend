-- ============================================================
-- Report cards and progress reports generated in the background.
--
-- Pressing Generate saves a batch and answers at once: a
-- report_generation_runs row (who, which school and year, report type, term,
-- report date) and one report_generation_items row per student. The worker
-- inside the API server (services/reportGeneration/worker.js, only where
-- REPORT_GENERATION_WORKER=true) prints the items one at a time with the
-- existing generators, and the page follows the run through
-- GET /api/report-generation/runs. Closing the page stops nothing.
--
-- An item is claimed with a lease (claimed_until). A server that dies
-- mid-print lets the lease run out and the item is printed again, which is
-- safe because the PDF upload and the report row are both upserts.
-- attempts counts the claims.
--
-- Additive only: two new tables that nothing on main reads. Requires
-- students_all (student_soft_delete_migration.sql). Apply BEFORE the backend
-- that writes them. Safe to re-run.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS report_generation_runs (
  run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school          school NOT NULL,
  school_year_id  UUID REFERENCES school_years(school_year_id) ON DELETE CASCADE,
  report_type     TEXT NOT NULL CHECK (report_type IN ('progress_report', 'report_card')),
  term            TEXT NOT NULL,
  -- The date printed on a progress report; null for a report card.
  report_date     DATE,
  student_count   INT NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When it was last queued (created, or Try again): a stalled run is one
  -- with nothing finished since the later of this and its last finished item.
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The worker serves the least recently served run next.
  last_served_at  TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_report_generation_runs_school
  ON report_generation_runs (school, report_type, term, created_at DESC);
ALTER TABLE report_generation_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS report_generation_items (
  run_id         UUID NOT NULL REFERENCES report_generation_runs(run_id) ON DELETE CASCADE,
  student_id     UUID NOT NULL REFERENCES students_all(student_id) ON DELETE CASCADE,
  position       INT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generated', 'failed', 'cancelled')),
  error          TEXT,
  attempts       INT NOT NULL DEFAULT 0,
  claimed_until  TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  PRIMARY KEY (run_id, student_id)
);
-- What the worker claims next.
CREATE INDEX IF NOT EXISTS idx_report_generation_items_pending
  ON report_generation_items (run_id, position) WHERE status = 'pending';
-- Who is waiting already (a second Generate, a report email send).
CREATE INDEX IF NOT EXISTS idx_report_generation_items_pending_student
  ON report_generation_items (student_id) WHERE status = 'pending';
ALTER TABLE report_generation_items ENABLE ROW LEVEL SECURITY;

COMMIT;
