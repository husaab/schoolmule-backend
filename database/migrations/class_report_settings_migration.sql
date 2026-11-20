-- Class report settings (2026-11-20)
--
-- Two per-class settings, saved from Settings → Class options:
--   on_report_card       false = the class prints on progress reports only:
--                        report cards (and their comment counts) leave it out.
--                        A class with no marks, like Salaat, would otherwise
--                        print "I" on every report card.
--   report_teacher_name  the name printed after the subject on progress
--                        reports instead of the teacher's, e.g. "Supervisor"
--                        ("Salaat – Supervisor"). NULL = the class's teacher.
--
-- Safe to re-run.

ALTER TABLE classes ADD COLUMN IF NOT EXISTS on_report_card BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS report_teacher_name TEXT;
