-- Al Haadi Academy: drop "very" from the grades 1-3 Salaat comment for Good (2026-11-23)
--
-- The school asked to remove "very" from the standard grades 1-3 Salaat
-- comment for students rated Good, in the standard comments themselves
-- rather than per student. Follows alhaadi_salaat_goals_2026_11_22.sql.
--
-- 1. The Good comment in the 6 grades 1-3 Salaat classes' standard comments.
-- 2. Students rated Good whose comment is still the standard one (teachers
--    hadn't edited any: 35 of 35). Edited comments would be left alone.

DO $$
DECLARE
  yr CONSTANT uuid := 'cd765ec9-1d2c-4ae1-9cf2-2ca867fc3d82';  -- 2026-2027
  old_good CONSTANT text := 'Is making very good progress in learning Salah. Shows respect and participates willingly. Keep working towards greater focus and consistency!';
  new_good CONSTANT text := 'Is making good progress in learning Salah. Shows respect and participates willingly. Keep working towards greater focus and consistency!';
  n_banks int;
  n_comments int;
BEGIN
  UPDATE class_comment_banks b
     SET work_habits = jsonb_set(b.work_habits, '{G}', to_jsonb(new_good)), updated_at = NOW()
    FROM classes c
   WHERE c.class_id = b.class_id
     AND c.school::text = 'ALHAADIACADEMY' AND c.school_year_id = yr AND c.subject = 'Salaat'
     AND c.grade::text IN ('1', '2', '3')
     AND b.work_habits ->> 'G' = old_good;
  GET DIAGNOSTICS n_banks = ROW_COUNT;
  IF n_banks <> 6 THEN RAISE EXCEPTION 'Expected 6 comment banks, found %', n_banks; END IF;

  UPDATE progress_report_feedback f
     SET comment = new_good
    FROM classes c
   WHERE c.class_id = f.class_id
     AND c.school::text = 'ALHAADIACADEMY' AND c.school_year_id = yr AND c.subject = 'Salaat'
     AND c.grade::text IN ('1', '2', '3')
     AND f.comment = old_good;
  GET DIAGNOSTICS n_comments = ROW_COUNT;

  RAISE NOTICE 'Comment banks: %, student comments: %', n_banks, n_comments;
END $$;

-- UNDO: run the same with old_good and new_good swapped.

-- Ran on prod 2026-11-23: 6 comment banks, 35 student comments (no edited ones). 16 of those students
-- already had a Term 1 progress report generated with the old wording (none sent): generate them again.
