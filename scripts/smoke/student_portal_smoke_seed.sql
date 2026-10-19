-- scripts/smoke/student_portal_smoke_seed.sql
--
-- Synthetic data for the Student Portal end-to-end smoke (Task 25). Load it
-- into a scratch database AFTER __tests__/integration/setup/seed.sql:
--
--   docker exec -i "$CID" psql -U test_user -d schoolmule_smoke -v ON_ERROR_STOP=1 < __tests__/integration/setup/seed.sql
--   docker exec -i "$CID" psql -U test_user -d schoolmule_smoke -v ON_ERROR_STOP=1 < scripts/smoke/student_portal_smoke_seed.sql
--
-- Every person is fictional and every address is @example.com. Every account
-- signs in with the password Smoke-pass-1 (Student C is invited and has none).
-- Dates are relative to the day the seed runs (America/Toronto), so the seed
-- can be reloaded on any day. NEVER run this against a real database.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── School, year, terms ────────────────────────────────────────────────────
-- The schools insert trigger creates the active year; it is relabelled to
-- the year that contains today.
INSERT INTO schools (school_id, school_code, name, slug, timezone, academic_year_start_date, academic_year_end_date, email)
VALUES ('5e000000-0000-4000-8000-000000000001', 'PLAYGROUND', 'Playground School', 'playground', 'America/Toronto',
        make_date(EXTRACT(YEAR FROM (NOW() AT TIME ZONE 'America/Toronto')::date - INTERVAL '8 months')::int, 9, 1),
        make_date(EXTRACT(YEAR FROM (NOW() AT TIME ZONE 'America/Toronto')::date - INTERVAL '8 months')::int + 1, 6, 30),
        'office@example.com');

UPDATE school_years
   SET label = to_char(start_date, 'YYYY') || '-' || to_char(end_date, 'YYYY')
 WHERE school = 'PLAYGROUND';

INSERT INTO terms (term_id, school, school_id, name, start_date, end_date, academic_year, is_active, school_year_id)
SELECT '5e000000-0000-4000-8000-000000000301', 'PLAYGROUND', sy.school_id, 'Term 1',
       sy.start_date, (sy.start_date + INTERVAL '5 months' - INTERVAL '1 day')::date, sy.label, TRUE, sy.school_year_id
  FROM school_years sy WHERE sy.school = 'PLAYGROUND' AND sy.is_active;
INSERT INTO terms (term_id, school, school_id, name, start_date, end_date, academic_year, is_active, school_year_id)
SELECT '5e000000-0000-4000-8000-000000000302', 'PLAYGROUND', sy.school_id, 'Term 2',
       (sy.start_date + INTERVAL '5 months')::date, sy.end_date, sy.label, FALSE, sy.school_year_id
  FROM school_years sy WHERE sy.school = 'PLAYGROUND' AND sy.is_active;

-- ── Adults ──────────────────────────────────────────────────────────────────
INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, staff_title)
VALUES
  ('5e000000-0000-4000-8000-000000000101', 'smoke.admin@example.com',     'Nadia Karim',  crypt('Smoke-pass-1', gen_salt('bf', 10)), 'Nadia', 'Karim',  'PLAYGROUND', 'ADMIN',   TRUE, TRUE, 'Principal'),
  ('5e000000-0000-4000-8000-000000000102', 'smoke.teacher@example.com',   'Layla Saleh',  crypt('Smoke-pass-1', gen_salt('bf', 10)), 'Layla', 'Saleh',  'PLAYGROUND', 'TEACHER', TRUE, TRUE, NULL),
  ('5e000000-0000-4000-8000-000000000103', 'smoke.coteacher@example.com', 'Karim Nasser', crypt('Smoke-pass-1', gen_salt('bf', 10)), 'Karim', 'Nasser', 'PLAYGROUND', 'TEACHER', TRUE, TRUE, NULL),
  ('5e000000-0000-4000-8000-000000000104', 'smoke.skteacher@example.com', 'Mona Aziz',    crypt('Smoke-pass-1', gen_salt('bf', 10)), 'Mona',  'Aziz',   'PLAYGROUND', 'TEACHER', TRUE, TRUE, NULL),
  ('5e000000-0000-4000-8000-000000000105', 'smoke.parent@example.com',    'Amal Haddad',  crypt('Smoke-pass-1', gen_salt('bf', 10)), 'Amal',  'Haddad', 'PLAYGROUND', 'PARENT',  TRUE, TRUE, NULL);

-- ── Students (this year's rows) ─────────────────────────────────────────────
-- Grade 5 (homeroom Layla Saleh): Adam = Student A, Zaid = Student C; four
-- classmates without logins (Dina has her own address, not invited yet).
-- SK (homeroom Mona Aziz): Sara is Amal's second child. Grade 2 (homeroom
-- Karim Nasser): Bilal = Student B.
INSERT INTO students (student_id, name, school, homeroom_teacher_id, grade, mother_name, mother_email, father_name, father_email, student_email, school_year_id)
SELECT v.student_id::uuid, v.name, 'PLAYGROUND', v.homeroom::uuid, v.grade::"GRADE", v.mother_name, v.mother_email, v.father_name, v.father_email, v.student_email, sy.school_year_id
  FROM (VALUES
    ('5e000000-0000-4000-8000-000000000201', 'Adam Haddad',  '5e000000-0000-4000-8000-000000000102', '5',  'Amal Haddad',  'smoke.parent@example.com',     NULL, NULL, 'smoke.student.a@example.com'),
    ('5e000000-0000-4000-8000-000000000202', 'Zaid Mansour', '5e000000-0000-4000-8000-000000000102', '5',  'Rana Mansour', 'guardian.mansour@example.com', NULL, NULL, 'smoke.student.c@example.com'),
    ('5e000000-0000-4000-8000-000000000203', 'Rami Khoury',  '5e000000-0000-4000-8000-000000000102', '5',  'Hala Khoury',  'guardian.khoury@example.com',  NULL, NULL, NULL),
    ('5e000000-0000-4000-8000-000000000204', 'Dina Farah',   '5e000000-0000-4000-8000-000000000102', '5',  NULL, NULL, 'Samir Farah', 'guardian.farah@example.com', 'dina.farah@example.com'),
    ('5e000000-0000-4000-8000-000000000205', 'Tariq Nour',   '5e000000-0000-4000-8000-000000000102', '5',  'Maya Nour',    'guardian.nour@example.com',    NULL, NULL, NULL),
    ('5e000000-0000-4000-8000-000000000206', 'Leen Yousef',  '5e000000-0000-4000-8000-000000000102', '5',  'Noor Yousef',  'guardian.yousef@example.com',  NULL, NULL, NULL),
    ('5e000000-0000-4000-8000-000000000211', 'Sara Haddad',  '5e000000-0000-4000-8000-000000000104', 'SK', 'Amal Haddad',  'smoke.parent@example.com',     NULL, NULL, NULL),
    ('5e000000-0000-4000-8000-000000000212', 'Yara Hamdan',  '5e000000-0000-4000-8000-000000000104', 'SK', 'Lina Hamdan',  'guardian.hamdan@example.com',  NULL, NULL, NULL),
    ('5e000000-0000-4000-8000-000000000213', 'Ali Rahal',    '5e000000-0000-4000-8000-000000000104', 'SK', NULL, NULL, 'Fadi Rahal', 'guardian.rahal@example.com', NULL),
    ('5e000000-0000-4000-8000-000000000221', 'Bilal Omari',  '5e000000-0000-4000-8000-000000000103', '2',  'Reem Omari',   'guardian.omari@example.com',   NULL, NULL, 'smoke.student.b@example.com'),
    ('5e000000-0000-4000-8000-000000000222', 'Huda Qasem',   '5e000000-0000-4000-8000-000000000103', '2',  'Salma Qasem',  'guardian.qasem@example.com',   NULL, NULL, NULL)
  ) AS v(student_id, name, homeroom, grade, mother_name, mother_email, father_name, father_email, student_email)
  CROSS JOIN school_years sy WHERE sy.school = 'PLAYGROUND' AND sy.is_active;

INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school)
VALUES
  ('5e000000-0000-4000-8000-000000000201', '5e000000-0000-4000-8000-000000000105', 'Amal Haddad', 'smoke.parent@example.com', 'Mother', 'PLAYGROUND'),
  ('5e000000-0000-4000-8000-000000000211', '5e000000-0000-4000-8000-000000000105', 'Amal Haddad', 'smoke.parent@example.com', 'Mother', 'PLAYGROUND');

-- ── Classroom settings and student logins ───────────────────────────────────
INSERT INTO school_classroom_settings (school, enabled, login_from_grade, qr_until_grade, student_email_from_grade, updated_by)
VALUES ('PLAYGROUND', TRUE, '1', '3', '1', '5e000000-0000-4000-8000-000000000101');

-- Student A and B are active; Student C is invited (the '!' sentinel).
INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
VALUES
  ('5e000000-0000-4000-8000-000000000111', 'smoke.student.a@example.com', 'Adam Haddad',  crypt('Smoke-pass-1', gen_salt('bf', 10)), 'Adam',  'Haddad',  'PLAYGROUND', 'STUDENT', TRUE, TRUE),
  ('5e000000-0000-4000-8000-000000000112', 'smoke.student.b@example.com', 'Bilal Omari',  crypt('Smoke-pass-1', gen_salt('bf', 10)), 'Bilal', 'Omari',   'PLAYGROUND', 'STUDENT', TRUE, TRUE),
  ('5e000000-0000-4000-8000-000000000113', 'smoke.student.c@example.com', 'Zaid Mansour', '!',                                       'Zaid',  'Mansour', 'PLAYGROUND', 'STUDENT', TRUE, TRUE);

-- Consent is recorded by the admin with the invite (ruling R9).
INSERT INTO student_accounts (user_id, school, consent_by, consent_at, consent_notice_version, created_by, created_at)
VALUES
  ('5e000000-0000-4000-8000-000000000111', 'PLAYGROUND', '5e000000-0000-4000-8000-000000000101', NOW() - INTERVAL '10 days', '2026-10', '5e000000-0000-4000-8000-000000000101', NOW() - INTERVAL '10 days'),
  ('5e000000-0000-4000-8000-000000000112', 'PLAYGROUND', '5e000000-0000-4000-8000-000000000101', NOW() - INTERVAL '10 days', '2026-10', '5e000000-0000-4000-8000-000000000101', NOW() - INTERVAL '10 days'),
  ('5e000000-0000-4000-8000-000000000113', 'PLAYGROUND', '5e000000-0000-4000-8000-000000000101', NOW() - INTERVAL '2 days',  '2026-10', '5e000000-0000-4000-8000-000000000101', NOW() - INTERVAL '2 days');

INSERT INTO student_account_links (user_id, student_id, school_year_id, linked_by)
SELECT v.user_id::uuid, v.student_id::uuid, sy.school_year_id, '5e000000-0000-4000-8000-000000000101'
  FROM (VALUES
    ('5e000000-0000-4000-8000-000000000111', '5e000000-0000-4000-8000-000000000201'),
    ('5e000000-0000-4000-8000-000000000112', '5e000000-0000-4000-8000-000000000221'),
    ('5e000000-0000-4000-8000-000000000113', '5e000000-0000-4000-8000-000000000202')
  ) AS v(user_id, student_id)
  CROSS JOIN school_years sy WHERE sy.school = 'PLAYGROUND' AND sy.is_active;

-- ── Classes (Term 1) ────────────────────────────────────────────────────────
INSERT INTO classes (class_id, school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id)
SELECT v.class_id::uuid, 'PLAYGROUND', v.grade::"GRADE", v.subject, v.teacher_name, v.teacher_id::uuid,
       '5e000000-0000-4000-8000-000000000301', 'Term 1', sy.school_year_id
  FROM (VALUES
    ('5e000000-0000-4000-8000-000000000401', '5',  'Science',  'Layla Saleh',  '5e000000-0000-4000-8000-000000000102'),
    ('5e000000-0000-4000-8000-000000000402', '5',  'Math',     'Layla Saleh',  '5e000000-0000-4000-8000-000000000102'),
    ('5e000000-0000-4000-8000-000000000403', 'SK', 'Homeroom', 'Mona Aziz',    '5e000000-0000-4000-8000-000000000104'),
    ('5e000000-0000-4000-8000-000000000404', '2',  'English',  'Karim Nasser', '5e000000-0000-4000-8000-000000000103')
  ) AS v(class_id, grade, subject, teacher_name, teacher_id)
  CROSS JOIN school_years sy WHERE sy.school = 'PLAYGROUND' AND sy.is_active;

-- Karim Nasser co-teaches Grade 5 Science.
INSERT INTO class_teachers (class_id, teacher_id)
VALUES ('5e000000-0000-4000-8000-000000000401', '5e000000-0000-4000-8000-000000000103');

INSERT INTO class_students (class_id, student_id)
SELECT c.class_id, s.student_id
  FROM classes c JOIN students s ON s.school = c.school AND s.grade = c.grade
 WHERE c.school = 'PLAYGROUND';

-- ── Grade 5 Science gradebook ───────────────────────────────────────────────
-- Categories (100 points): Homework 20, Quizzes 30, Projects 20, Tests 30.
INSERT INTO assessments (assessment_id, class_id, name, weight_points, is_parent, sort_order)
VALUES
  ('5e000000-0000-4000-8000-000000000501', '5e000000-0000-4000-8000-000000000401', 'Homework', 20, TRUE, 1),
  ('5e000000-0000-4000-8000-000000000502', '5e000000-0000-4000-8000-000000000401', 'Quizzes',  30, TRUE, 2),
  ('5e000000-0000-4000-8000-000000000503', '5e000000-0000-4000-8000-000000000401', 'Projects', 20, TRUE, 3),
  ('5e000000-0000-4000-8000-000000000504', '5e000000-0000-4000-8000-000000000401', 'Tests',    30, TRUE, 4);

-- Columns. The insert trigger gives each one a plain-assessment classwork row.
--   Unit 1 test: published, scored, dated ten days ago.
--   Unit 2 test: plain, dated next Friday (not visible to students yet).
--   Plant cell diagram: Homework, out of 10, dated tomorrow (the assignment's due day).
--   Cells quiz: Quizzes, out of 8 (the four questions' points), dated in three days.
INSERT INTO assessments (assessment_id, class_id, name, parent_assessment_id, is_parent, sort_order, max_score, weight_points, date)
VALUES
  ('5e000000-0000-4000-8000-000000000511', '5e000000-0000-4000-8000-000000000401', 'Unit 1 test',        '5e000000-0000-4000-8000-000000000504', FALSE, 1, 50, 15,
     (NOW() AT TIME ZONE 'America/Toronto')::date - 10),
  ('5e000000-0000-4000-8000-000000000512', '5e000000-0000-4000-8000-000000000401', 'Unit 2 test',        '5e000000-0000-4000-8000-000000000504', FALSE, 2, 50, 15,
     (NOW() AT TIME ZONE 'America/Toronto')::date
       + CASE WHEN (5 - EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Toronto')::date)::int + 7) % 7 = 0 THEN 7
              ELSE (5 - EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Toronto')::date)::int + 7) % 7 END),
  ('5e000000-0000-4000-8000-000000000513', '5e000000-0000-4000-8000-000000000401', 'Plant cell diagram', '5e000000-0000-4000-8000-000000000501', FALSE, 1, 10, 20,
     (NOW() AT TIME ZONE 'America/Toronto')::date + 1),
  ('5e000000-0000-4000-8000-000000000514', '5e000000-0000-4000-8000-000000000401', 'Cells quiz',         '5e000000-0000-4000-8000-000000000502', FALSE, 1, 8, 30,
     (NOW() AT TIME ZONE 'America/Toronto')::date + 3);

-- Unit 1 test is published, every Grade 5 student scored.
INSERT INTO assessment_publication_batches (batch_id, class_id, school, action, assessment_ids, triggered_by, created_at)
VALUES ('5e000000-0000-4000-8000-000000000591', '5e000000-0000-4000-8000-000000000401', 'PLAYGROUND', 'publish',
        ARRAY['5e000000-0000-4000-8000-000000000511']::uuid[], '5e000000-0000-4000-8000-000000000102', NOW() - INTERVAL '7 days');
UPDATE assessments
   SET is_published = TRUE, published_at = NOW() - INTERVAL '7 days', published_by = '5e000000-0000-4000-8000-000000000102',
       publication_batch_id = '5e000000-0000-4000-8000-000000000591'
 WHERE assessment_id = '5e000000-0000-4000-8000-000000000511';
INSERT INTO student_assessments (student_id, assessment_id, score, status)
VALUES
  ('5e000000-0000-4000-8000-000000000201', '5e000000-0000-4000-8000-000000000511', 42, 'graded'),
  ('5e000000-0000-4000-8000-000000000202', '5e000000-0000-4000-8000-000000000511', 38, 'graded'),
  ('5e000000-0000-4000-8000-000000000203', '5e000000-0000-4000-8000-000000000511', 45, 'graded'),
  ('5e000000-0000-4000-8000-000000000204', '5e000000-0000-4000-8000-000000000511', 40, 'graded'),
  ('5e000000-0000-4000-8000-000000000205', '5e000000-0000-4000-8000-000000000511', 35, 'graded'),
  ('5e000000-0000-4000-8000-000000000206', '5e000000-0000-4000-8000-000000000511', 47, 'graded');

-- ── Grade 5 Science classwork ───────────────────────────────────────────────
INSERT INTO classwork_topics (topic_id, class_id, name, sort_order)
VALUES ('5e000000-0000-4000-8000-000000000601', '5e000000-0000-4000-8000-000000000401', 'Unit 2 · Cells', 1);

-- The assignment and the quiz take over their columns' rows (as
-- convertItemByAssessment does), with fixed ids the rows below point at.
DELETE FROM classwork_items
 WHERE assessment_id IN ('5e000000-0000-4000-8000-000000000513', '5e000000-0000-4000-8000-000000000514');

INSERT INTO classwork_items (item_id, class_id, topic_id, kind, title, instructions, due_at, submission_mode, assessment_id,
                             status, posted_at, audience, sort_order, created_by, created_at)
VALUES
  ('5e000000-0000-4000-8000-000000000701', '5e000000-0000-4000-8000-000000000401', '5e000000-0000-4000-8000-000000000601',
   'assignment', NULL,
   'Draw a plant cell and label the cell wall, membrane, nucleus, chloroplasts and vacuole. Take a clear photo of your drawing and upload it.',
   (((NOW() AT TIME ZONE 'America/Toronto')::date + 1) + TIME '15:30') AT TIME ZONE 'America/Toronto',
   'file', '5e000000-0000-4000-8000-000000000513', 'posted', NOW() - INTERVAL '2 days', 'all', 1,
   '5e000000-0000-4000-8000-000000000102', NOW() - INTERVAL '2 days'),
  ('5e000000-0000-4000-8000-000000000702', '5e000000-0000-4000-8000-000000000401', '5e000000-0000-4000-8000-000000000601',
   'quiz', NULL, 'Four questions about plant and animal cells. You can only turn it in once.',
   (((NOW() AT TIME ZONE 'America/Toronto')::date + 3) + TIME '15:30') AT TIME ZONE 'America/Toronto',
   'none', '5e000000-0000-4000-8000-000000000514', 'posted', NOW() - INTERVAL '1 day', 'all', 2,
   '5e000000-0000-4000-8000-000000000102', NOW() - INTERVAL '1 day');

-- A material with a link, in the same topic.
INSERT INTO classwork_items (item_id, class_id, topic_id, kind, title, instructions, submission_mode, status, posted_at, sort_order, created_by, created_at)
VALUES ('5e000000-0000-4000-8000-000000000703', '5e000000-0000-4000-8000-000000000401', '5e000000-0000-4000-8000-000000000601',
        'material', 'Cell structure video', 'Watch this before the quiz.', 'none', 'posted', NOW() - INTERVAL '3 days', 3,
        '5e000000-0000-4000-8000-000000000102', NOW() - INTERVAL '3 days');
INSERT INTO classwork_attachments (item_id, kind, url, title, sort_order, created_by)
VALUES ('5e000000-0000-4000-8000-000000000703', 'link', 'https://example.com/cells-video', 'Cells video', 0, '5e000000-0000-4000-8000-000000000102');

-- The quiz: one of each question kind (8 points).
INSERT INTO quiz_questions (question_id, item_id, kind, prompt, options, correct, accepted, points, partial_credit, sort_order)
VALUES
  ('5e000000-0000-4000-8000-000000000901', '5e000000-0000-4000-8000-000000000702', 'one',
   'Which part of a plant cell makes food from sunlight?',
   '[{"id":"a","text":"Nucleus"},{"id":"b","text":"Chloroplast"},{"id":"c","text":"Vacuole"},{"id":"d","text":"Cell wall"}]', '["b"]', '{}', 1, FALSE, 0),
  ('5e000000-0000-4000-8000-000000000902', '5e000000-0000-4000-8000-000000000702', 'many',
   'Which parts do BOTH plant and animal cells have?',
   '[{"id":"a","text":"Cell membrane"},{"id":"b","text":"Cell wall"},{"id":"c","text":"Nucleus"},{"id":"d","text":"Chloroplast"}]', '["a","c"]', '{}', 2, TRUE, 1),
  ('5e000000-0000-4000-8000-000000000903', '5e000000-0000-4000-8000-000000000702', 'short',
   'What is the control centre of the cell called?', '[]', '[]', ARRAY['nucleus', 'the nucleus'], 1, FALSE, 2),
  ('5e000000-0000-4000-8000-000000000904', '5e000000-0000-4000-8000-000000000702', 'long',
   'Explain in two or three sentences why plant cells need a cell wall.', '[]', '[]', '{}', 4, FALSE, 3);

-- Student A turned in a photo yesterday; Rami turned in and has a draft score
-- with feedback (Draft: only the teacher sees it until Publish).
INSERT INTO classwork_submissions (submission_id, item_id, student_id, opened_at, turned_in_at, first_turned_in_at, is_late, created_at, updated_at)
VALUES ('5e000000-0000-4000-8000-000000000801', '5e000000-0000-4000-8000-000000000701', '5e000000-0000-4000-8000-000000000201',
        NOW() - INTERVAL '1 day 2 hours', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', FALSE, NOW() - INTERVAL '1 day 2 hours', NOW() - INTERVAL '1 day');
INSERT INTO submission_files (file_id, submission_id, file_path, file_name, mime_type, size_bytes, uploaded_by, created_at)
VALUES ('5e000000-0000-4000-8000-000000000811', '5e000000-0000-4000-8000-000000000801',
        'PLAYGROUND/5e000000-0000-4000-8000-000000000701/5e000000-0000-4000-8000-000000000201/5e000000-0000-4000-8000-000000000811.png',
        'plant-cell-photo.png', 'image/png', 4096, '5e000000-0000-4000-8000-000000000111', NOW() - INTERVAL '1 day');
INSERT INTO classwork_submissions (submission_id, item_id, student_id, opened_at, turned_in_at, first_turned_in_at, is_late,
                                   text_answer, draft_score, draft_status, feedback, feedback_saved_at, graded_by, created_at, updated_at)
VALUES ('5e000000-0000-4000-8000-000000000802', '5e000000-0000-4000-8000-000000000701', '5e000000-0000-4000-8000-000000000203',
        NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day 5 hours', NOW() - INTERVAL '1 day 5 hours', FALSE,
        NULL, 8, 'graded', 'Clear labels. Add the vacuole next time.', NOW() - INTERVAL '3 hours', '5e000000-0000-4000-8000-000000000102',
        NOW() - INTERVAL '2 days', NOW() - INTERVAL '3 hours');

-- A class post that asks for a "Got it".
INSERT INTO announcements (announcement_id, school, school_year_id, scope, class_id, title, body, author_id, author_role, published_at, ack_requested, send_email)
SELECT '5e000000-0000-4000-8000-000000000a01', 'PLAYGROUND', sy.school_year_id, 'class', '5e000000-0000-4000-8000-000000000401',
       'Bring a leaf on Thursday',
       'We are looking at real plant cells under the microscope on Thursday. Please bring one fresh leaf from home in a zip bag.',
       '5e000000-0000-4000-8000-000000000102', 'TEACHER', NOW() - INTERVAL '5 hours', TRUE, FALSE
  FROM school_years sy WHERE sy.school = 'PLAYGROUND' AND sy.is_active;

-- ── Grade 5 Math: one dated column, scored but NOT published ────────────────
INSERT INTO assessments (assessment_id, class_id, name, is_parent, sort_order, max_score, weight_points, date)
VALUES ('5e000000-0000-4000-8000-000000000521', '5e000000-0000-4000-8000-000000000402', 'Fractions check-in', FALSE, 1, 20, 100,
        (NOW() AT TIME ZONE 'America/Toronto')::date - 3);
INSERT INTO student_assessments (student_id, assessment_id, score, status)
VALUES
  ('5e000000-0000-4000-8000-000000000201', '5e000000-0000-4000-8000-000000000521', 17, 'graded'),
  ('5e000000-0000-4000-8000-000000000202', '5e000000-0000-4000-8000-000000000521', 15, 'graded'),
  ('5e000000-0000-4000-8000-000000000203', '5e000000-0000-4000-8000-000000000521', 18, 'graded');

-- ── SK Homeroom: one post ───────────────────────────────────────────────────
INSERT INTO announcements (announcement_id, school, school_year_id, scope, class_id, title, body, author_id, author_role, published_at, send_email)
SELECT '5e000000-0000-4000-8000-000000000a02', 'PLAYGROUND', sy.school_year_id, 'class', '5e000000-0000-4000-8000-000000000403',
       'Pajama day on Friday',
       'Friday is pajama day in SK. Send your child in comfy pajamas and a favourite book.',
       '5e000000-0000-4000-8000-000000000104', 'TEACHER', NOW() - INTERVAL '1 day', FALSE
  FROM school_years sy WHERE sy.school = 'PLAYGROUND' AND sy.is_active;

-- ── An existing parent–teacher thread (adults only; Adam must never see it) ─
INSERT INTO conversations (conversation_id, school, student_id, class_id, teacher_id, kind, title, created_by, includes_student, last_message_at, created_at)
VALUES ('5e000000-0000-4000-8000-000000000b01', 'PLAYGROUND', '5e000000-0000-4000-8000-000000000201', '5e000000-0000-4000-8000-000000000401',
        '5e000000-0000-4000-8000-000000000102', 'general', 'Adam missed Tuesday', '5e000000-0000-4000-8000-000000000105', FALSE,
        NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days');
INSERT INTO messages (message_id, conversation_id, sender_id, sender_role, kind, body, created_at)
VALUES ('5e000000-0000-4000-8000-000000000b11', '5e000000-0000-4000-8000-000000000b01', '5e000000-0000-4000-8000-000000000105', 'PARENT', 'message',
        'Adam was at a medical appointment on Tuesday. Could you tell me what he missed in Science?', NOW() - INTERVAL '2 days');
INSERT INTO conversation_participants (conversation_id, user_id, last_read_at)
VALUES ('5e000000-0000-4000-8000-000000000b01', '5e000000-0000-4000-8000-000000000105', NOW() - INTERVAL '2 days'),
       ('5e000000-0000-4000-8000-000000000b01', '5e000000-0000-4000-8000-000000000102', NULL);

COMMIT;
