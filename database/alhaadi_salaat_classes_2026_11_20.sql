-- Al Haadi Academy: Salaat as one class per grade (2026-11-20)
--
-- The school asked for Salaat as its own subject, graded like the others and
-- easy to find, printed on progress reports as "Salaat – Supervisor", and
-- open to every teacher. This replaces the built-in Salaat box
-- (schools.progress_salaat, switched off here; nobody had filled one in).
--
-- For Term 1 and Term 2 of 2026-2027, grades 1-8 (16 classes):
--   subject Salaat, lead = the grade's homeroom teacher (the class form needs
--   one), every other active Al Haadi teacher a co-teacher (so all teachers
--   see it in their classes and gradebook), every current student of the
--   grade enrolled, on_report_card = false (progress reports only: no marks,
--   so a report card would print "I"), report_teacher_name = 'Supervisor'.
--
-- Nahid Rezaei's second account (133aafe3…, never signed in) is left out.
-- Students who join a grade later are added to its Salaat class like any
-- other class (Settings → Students).
--
-- Safe to re-run: a grade/term that already has a Salaat class is skipped.

DO $$
DECLARE
  yr CONSTANT uuid := 'cd765ec9-1d2c-4ae1-9cf2-2ca867fc3d82';  -- 2026-2027
  duplicate_account CONSTANT uuid := '133aafe3-66e0-48b7-9f65-d41b63dba21b';
  t record;
  g text;
  lead_id uuid;
  new_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM progress_report_salaat ps JOIN students_all s ON s.student_id = ps.student_id WHERE s.school::text = 'ALHAADIACADEMY') THEN
    RAISE EXCEPTION 'Built-in Salaat entries exist; move them before switching the box off';
  END IF;

  FOR t IN
    SELECT term_id, name FROM terms
     WHERE school::text = 'ALHAADIACADEMY' AND school_year_id = yr AND name IN ('Term 1', 'Term 2')
  LOOP
    FOREACH g IN ARRAY ARRAY['1', '2', '3', '4', '5', '6', '7', '8'] LOOP
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM classes
         WHERE school::text = 'ALHAADIACADEMY' AND term_id = t.term_id AND grade::text = g AND subject = 'Salaat'
      );

      SELECT s.homeroom_teacher_id INTO lead_id
        FROM students s
        JOIN users u ON u.user_id = s.homeroom_teacher_id AND u.is_archived = false
       WHERE s.school::text = 'ALHAADIACADEMY' AND s.school_year_id = yr
         AND s.is_archived = false AND s.grade::text = g
       GROUP BY s.homeroom_teacher_id
       ORDER BY count(*) DESC
       LIMIT 1;
      IF lead_id IS NULL THEN
        RAISE EXCEPTION 'Grade % has no homeroom teacher', g;
      END IF;

      INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name,
                           school_year_id, on_report_card, report_teacher_name)
      SELECT 'ALHAADIACADEMY'::school, g::"GRADE", 'Salaat',
             btrim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')),
             u.user_id, t.term_id, t.name, yr, false, 'Supervisor'
        FROM users u WHERE u.user_id = lead_id
      RETURNING class_id INTO new_id;

      INSERT INTO class_students (class_id, student_id)
      SELECT new_id, s.student_id
        FROM students s
       WHERE s.school::text = 'ALHAADIACADEMY' AND s.school_year_id = yr
         AND s.is_archived = false AND s.grade::text = g
      ON CONFLICT DO NOTHING;

      INSERT INTO class_teachers (class_id, teacher_id)
      SELECT new_id, u.user_id
        FROM users u
       WHERE u.school::text = 'ALHAADIACADEMY' AND u.role::text = 'TEACHER'
         AND u.is_archived = false AND u.is_verified_school
         AND u.user_id <> lead_id AND u.user_id <> duplicate_account
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  UPDATE schools SET progress_salaat = false WHERE school_code::text = 'ALHAADIACADEMY';
END $$;

-- Ran on prod 2026-11-20: 16 classes, 262 enrolments, 288 co-teacher links.
-- The built-in box was then removed (progress_report_salaat_drop_migration.sql),
-- so this script won't run again as written.
--
-- UNDO (only while no Salaat feedback has been entered; deleting a class
-- deletes its progress comments):
--   DELETE FROM classes
--    WHERE school::text = 'ALHAADIACADEMY' AND subject = 'Salaat'
--      AND school_year_id = 'cd765ec9-1d2c-4ae1-9cf2-2ca867fc3d82';
