-- ============================================================
-- Al Haadi Academy — JK progress report skills, 2026-10
-- Brings the JK progress-report skill list in line with the school's
-- 2025-2026 paper template ("JK PROGRESS REPORT CARD 2025-2026"):
--   * 7 skills reworded (ratings stay attached: same skill_id)
--   * 4 sections added: Gross Motor Skills, Cognitive Development, Arabic,
--     Islamic Studies (16 skills)
-- Additive and idempotent: re-running changes nothing. Applied to prod
-- 2026-10-31.
-- ============================================================

BEGIN;

-- 1. Rewordings (only where the old wording is still there)
WITH renames(domain_name, old_name, new_name) AS (
  VALUES
    ('Language and Communication Skills', 'Engage in conversations.', 'Engages in conversations.'),
    ('Social Skills', 'Follow classroom rules.', 'Follows classroom rules.'),
    ('Reading and Writing Skills', 'Recognizes ABCs.', 'Recognizes the ABCs.'),
    ('Reading and Writing Skills', 'Can Print first name.', 'Can Print his/her first name.'),
    ('Reading and Writing Skills', 'Can print the last name.', 'Can print his/her last name.'),
    ('Colours and Shapes', 'Understand sizes(big/small).', 'Understands sizes(big/small).'),
    ('Fine Motor Skills', 'Can hold and use a glue stick/paintbrush', 'Can hold and use a glue stick or a paintbrush')
)
UPDATE jk_skills s
SET name = r.new_name
FROM renames r, jk_skill_domains d
WHERE d.domain_id = s.domain_id
  AND d.school = 'ALHAADIACADEMY'
  AND d.document_type = 'progress_report'
  AND d.name = r.domain_name
  AND s.name = r.old_name
  AND NOT EXISTS (SELECT 1 FROM jk_skills x WHERE x.domain_id = s.domain_id AND x.name = r.new_name);

-- 2. New sections, after the existing seven
INSERT INTO jk_skill_domains (document_type, name, sort_order, school)
VALUES
  ('progress_report', 'Gross Motor Skills', 8, 'ALHAADIACADEMY'),
  ('progress_report', 'Cognitive Development', 9, 'ALHAADIACADEMY'),
  ('progress_report', 'Arabic', 10, 'ALHAADIACADEMY'),
  ('progress_report', 'Islamic Studies', 11, 'ALHAADIACADEMY')
ON CONFLICT (document_type, name, school) DO NOTHING;

-- 3. Their skills
WITH new_skills(domain_name, name, sort_order) AS (
  VALUES
    ('Gross Motor Skills', 'Can bounce & kick a ball', 1),
    ('Gross Motor Skills', 'Demonstrates balance and coordination.', 2),
    ('Gross Motor Skills', 'Can run, jump, and climb with control.', 3),
    ('Gross Motor Skills', 'Participates in physical activities and games.', 4),
    ('Gross Motor Skills', 'Can swing, skip without help.', 5),
    ('Gross Motor Skills', 'Can button shirt and tie shoes.', 6),
    ('Gross Motor Skills', 'Follows simple movement instructions.', 7),
    ('Cognitive Development', 'Participates in classroom activities.', 1),
    ('Cognitive Development', 'Demonstrates curiosity and problem-solving skills', 2),
    ('Cognitive Development', 'Shows interest in books and reading.', 3),
    ('Cognitive Development', 'Engages in creative play and imaginative activities.', 4),
    ('Arabic', 'Knows how to say the Arabic alphabet.', 1),
    ('Arabic', 'Recognizes some letters of the Arabic alphabet.', 2),
    ('Arabic', 'Can Print first & last name in Arabic.', 3),
    ('Islamic Studies', 'Memorizes assigned surahs.', 1),
    ('Islamic Studies', 'Listens and engages in lessons.', 2)
)
INSERT INTO jk_skills (domain_id, name, sort_order)
SELECT d.domain_id, n.name, n.sort_order
FROM new_skills n
JOIN jk_skill_domains d
  ON d.name = n.domain_name AND d.school = 'ALHAADIACADEMY' AND d.document_type = 'progress_report'
ON CONFLICT (domain_id, name) DO NOTHING;

COMMIT;
