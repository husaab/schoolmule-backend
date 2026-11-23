-- Progress reports, grades 1-8 (2026-11-22, Al Haadi Academy's request):
--
-- 1. A class can print as a goals paragraph plus the teacher's comment, with no
--    ratings (Salaat). The teacher still picks Excellent / Good / Satisfactory /
--    Needs Improvement (saved in progress_report_feedback.work_habit) to fill
--    the comment from the class's standard comments; it doesn't print.
-- 2. A school can print its subjects under headings, in its own order and
--    under its own names ("English" → "English Language Arts" under
--    "Language & Literacy"). One layout per school, matched by class subject.

ALTER TABLE classes ADD COLUMN IF NOT EXISTS progress_comments_only BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS progress_goals TEXT;

-- sections: [{ heading, subjects: [{ name, classes: [class subject, ...] }] }]
CREATE TABLE IF NOT EXISTS report_subject_layouts (
  school     school PRIMARY KEY,
  sections   JSONB NOT NULL,
  updated_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Only the API reads it (as report_templates and report_field_values).
ALTER TABLE report_subject_layouts ENABLE ROW LEVEL SECURITY;
