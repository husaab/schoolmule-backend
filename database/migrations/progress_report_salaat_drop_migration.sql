-- Drop the built-in Salaat box (2026-11-20)
--
-- progress_report_salaat_migration.sql (2026-11-16) added a Salaat box the
-- homeroom teacher filled in from the Progress reports page. Al Haadi asked
-- for Salaat as its own subject instead: it is now one class per grade
-- (database/alhaadi_salaat_classes_2026_11_20.sql), printed on progress
-- reports only through classes.on_report_card / report_teacher_name
-- (class_report_settings_migration.sql). The box's code is gone (backend
-- after 028d925). Nobody filled one in: the table is empty.
--
-- Run after the backend without the box is deployed. Safe to re-run.

DO $$
BEGIN
  IF to_regclass('public.progress_report_salaat') IS NOT NULL
     AND EXISTS (SELECT 1 FROM progress_report_salaat) THEN
    RAISE EXCEPTION 'progress_report_salaat has rows; keep them before dropping';
  END IF;
END $$;

DROP TABLE IF EXISTS progress_report_salaat;
ALTER TABLE schools DROP COLUMN IF EXISTS progress_salaat;
