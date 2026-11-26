-- Report comment rules (2026-11-26): word limits and a review lock for the
-- comments teachers write on report cards and progress reports.
--
-- 1. report_comment_limits: one row per school and document. A comment over
--    max_words is refused when it is saved; a comment under min_words saves
--    but counts as not finished. NULL means no limit. Grades 1-8 only: JK and
--    SK comments have many short boxes and are not limited.
-- 2. report_comment_term_locks: a row means the term's comments for that
--    document are locked for the whole school (JK and SK included). Teachers
--    can no longer change them; holders of school_setup still can.
-- 3. report_comment_class_locks: one class's exception to its term. locked =
--    TRUE locks the class while the term is open; FALSE reopens it while the
--    term is locked. Locking or reopening the whole term clears the term's
--    exceptions.
--
-- Run BEFORE deploying the backend that serves /api/report-comments. Idempotent.

CREATE TABLE IF NOT EXISTS report_comment_limits (
  school     school NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('report_card', 'progress_report')),
  min_words  INTEGER CHECK (min_words IS NULL OR min_words BETWEEN 1 AND 2000),
  max_words  INTEGER CHECK (max_words IS NULL OR max_words BETWEEN 1 AND 2000),
  updated_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (school, kind),
  CHECK (min_words IS NULL OR max_words IS NULL OR min_words <= max_words)
);

CREATE TABLE IF NOT EXISTS report_comment_term_locks (
  term_id   UUID NOT NULL REFERENCES terms(term_id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('report_card', 'progress_report')),
  locked_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (term_id, kind)
);

CREATE TABLE IF NOT EXISTS report_comment_class_locks (
  class_id UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('report_card', 'progress_report')),
  locked   BOOLEAN NOT NULL,
  set_by   UUID REFERENCES users(user_id) ON DELETE SET NULL,
  set_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (class_id, kind)
);

-- Only the API reads them (as report_templates and report_subject_layouts).
ALTER TABLE report_comment_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_comment_term_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_comment_class_locks ENABLE ROW LEVEL SECURITY;
