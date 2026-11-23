-- Al Haadi Academy: Salaat as goals and comment, and subject headings (2026-11-22)
--
-- The school sent its Salaat text: one Expectations/Goals paragraph for every
-- student, and a comment per rating (Excellent / Good / Satisfactory / Needs
-- Improvement) for grades 1-3 and another set for grades 4-8. It also asked
-- for its subjects under headings. Needs progress_report_layout_migration.sql.
--
-- 1. The 16 Salaat classes (2026-2027, Term 1 + Term 2, grades 1-8) print
--    goals and comment only, with the goals paragraph.
-- 2. Their standard comments: the school's comment for each rating (the
--    Work Habits sentences; a goals-and-comment class uses those alone). The
--    Core Standards sentences and cut-offs are SchoolMule's starter set
--    (unused by these classes, but the bank needs them).
-- 3. Grades 1-3 Salaat comments still in SchoolMule's generic wording (untouched
--    by teachers) become the school's grades 1-3 comment for the same rating.
--    Edited comments are left alone.
-- 4. The school's subject headings. Quran classes keep their own names
--    (some students take two); Report templates → Subject headings changes it.

DO $$
DECLARE
  yr CONSTANT uuid := 'cd765ec9-1d2c-4ae1-9cf2-2ca867fc3d82';  -- 2026-2027
  goals CONSTANT text := 'Salah is a special gift and an opportunity to connect with Allah. It deserves our time, attention, and respect. We are all learning to make our prayers better, and every sincere effort brings us one step closer to Allah.';
  junior CONSTANT jsonb := jsonb_build_object(
    'E', 'Demonstrates excellent respect and attentiveness during Salah. Performs the actions carefully and with sincerity. Keep up the beautiful effort!',
    'G', 'Is making very good progress in learning Salah. Shows respect and participates willingly. Keep working towards greater focus and consistency!',
    'S', 'Is learning the steps of Salah and making progress. Needs to pay closer attention and take each movement more seriously.',
    'N', 'Needs to understand that Salah is a special conversation with Allah and requires respect, attention, and proper behaviour.'
  );
  senior CONSTANT jsonb := jsonb_build_object(
    'E', 'Consistently arrives on time and demonstrates excellent respect, discipline, and attentiveness during Salaat. Follows the Imam, participates in Tasbeeh and Ziyarah, and sets a wonderful example for others. Keep up these beautiful habits and continue strengthening your connection with Allah!',
    'G', 'Usually arrives on time and participates well in Salaat. Shows respect, follows the Imam, and participates in Tasbeeh and Ziyarah, with occasional reminders to maintain focus. You are doing well! Keep working towards greater consistency and attentiveness.',
    'S', 'Participates in Salaat but needs occasional reminders to be punctual, follow the Imam, and remain attentive. Should work on avoiding distractions and showing greater respect during prayer. With more practice and effort, you can develop stronger habits. Keep trying!',
    'N', 'Requires frequent reminders to arrive on time, follow the Imam, remain quiet, and participate appropriately. Needs to avoid running, playing, talking, and disturbing others in the Salaat Hall. You are still learning! We encourage you to take Salah more seriously, show greater respect, and make a sincere effort to improve. We believe in you!'
  );
  starter_core CONSTANT jsonb := jsonb_build_object(
    'exceeding', '{First} is exceeding grade-level expectations in {subject}. {He} shows a thorough understanding of this term''s concepts and applies {his} skills with confidence.',
    'meeting', '{First} is meeting grade-level expectations in {subject}. {He} has a good understanding of this term''s concepts and applies them well in most of {his} work.',
    'workingTowards', '{First} is working towards grade-level expectations in {subject}. {He} understands some of this term''s concepts, and regular practice will help {him} strengthen the rest.',
    'notMeeting', '{First} is not yet meeting grade-level expectations in {subject}. With extra practice and support at school and at home, {he} can build a stronger foundation.'
  );
  starter_cutoffs CONSTANT jsonb := '{"exceeding": 85, "meeting": 70, "workingTowards": 60}';
  -- SchoolMule's generic Salaat comment, untouched: the level sentence, then a work habits sentence.
  generic CONSTANT text := '^\S+ is (exceeding|meeting|working towards|not yet meeting) grade-level expectations in Salaat\. .*(takes pride in (his|her|their) assignments\.|stays focused during lessons\.|more consistently and on time\.|reflect what \S+ knows\.)$';
  n_classes int;
  n_banks int;
  n_swapped int;
BEGIN
  UPDATE classes
     SET progress_comments_only = true, progress_goals = goals, last_modified_at = NOW()
   WHERE school::text = 'ALHAADIACADEMY' AND school_year_id = yr AND subject = 'Salaat';
  GET DIAGNOSTICS n_classes = ROW_COUNT;
  IF n_classes <> 16 THEN RAISE EXCEPTION 'Expected 16 Salaat classes, found %', n_classes; END IF;

  INSERT INTO class_comment_banks (class_id, core_standards, work_habits, cutoffs, updated_at)
  SELECT c.class_id, starter_core, CASE WHEN c.grade::text IN ('1', '2', '3') THEN junior ELSE senior END, starter_cutoffs, NOW()
    FROM classes c
   WHERE c.school::text = 'ALHAADIACADEMY' AND c.school_year_id = yr AND c.subject = 'Salaat'
  ON CONFLICT (class_id) DO UPDATE SET work_habits = EXCLUDED.work_habits, updated_at = NOW();
  GET DIAGNOSTICS n_banks = ROW_COUNT;

  UPDATE progress_report_feedback f
     SET comment = junior ->> f.work_habit
    FROM classes c
   WHERE c.class_id = f.class_id
     AND c.school::text = 'ALHAADIACADEMY' AND c.school_year_id = yr AND c.subject = 'Salaat'
     AND c.grade::text IN ('1', '2', '3')
     AND f.work_habit IN ('E', 'G', 'S', 'N')
     AND f.comment ~ generic;
  GET DIAGNOSTICS n_swapped = ROW_COUNT;

  INSERT INTO report_subject_layouts (school, sections, updated_at)
  VALUES ('ALHAADIACADEMY', '[
    {"heading": "Language & Literacy", "subjects": [{"name": "English Language Arts", "classes": ["English"]}]},
    {"heading": "Mathematics", "subjects": [{"name": "Mathematics", "classes": ["Math"]}]},
    {"heading": "Science & Technology", "subjects": [{"name": "Science", "classes": []}, {"name": "Computer Studies", "classes": []}]},
    {"heading": "Social Studies", "subjects": [{"name": "Social Studies", "classes": []}]},
    {"heading": "Languages", "subjects": [{"name": "Arabic", "classes": []}, {"name": "French", "classes": []}]},
    {"heading": "Religious Studies", "subjects": [
      {"name": "Quran", "classes": []},
      {"name": "Quran Teaching", "classes": []},
      {"name": "Quran Teaching and Memorization", "classes": []},
      {"name": "Islamic Studies", "classes": []},
      {"name": "Salaat", "classes": []}
    ]},
    {"heading": "The Arts", "subjects": [{"name": "Visual Arts", "classes": ["Art", "Arts"]}]},
    {"heading": "Physical Education", "subjects": [{"name": "Physical Education", "classes": ["Physical Education", "Physical Activities"]}]}
  ]'::jsonb, NOW())
  ON CONFLICT (school) DO UPDATE SET sections = EXCLUDED.sections, updated_at = NOW();

  RAISE NOTICE 'Salaat classes: %, comment banks: %, comments swapped: %', n_classes, n_banks, n_swapped;
END $$;

-- UNDO (the school's text stays in this file):
--   UPDATE classes SET progress_comments_only = false WHERE school::text = 'ALHAADIACADEMY' AND subject = 'Salaat';
--   DELETE FROM report_subject_layouts WHERE school::text = 'ALHAADIACADEMY';
-- The swapped comments are the school's own wording; teachers can rebuild or edit them.

-- Ran on prod 2026-11-22: 16 Salaat classes, 16 comment banks, 55 grades 1-3 comments swapped, 8 headings.
