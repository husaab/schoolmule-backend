-- ============================================================
-- JK/SK Seed Data - Al Haadi Academy
-- Run AFTER jksk_migration.sql
-- ============================================================

-- ============================================================
-- PROGRESS REPORT DOMAINS & SKILLS (D/B/I/N scale)
-- ============================================================

-- Domain 1: Language and Communication Skills
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Language and Communication Skills', 1, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Speaks clearly and fluently.', 1),
  ((SELECT domain_id FROM d), 'Responds to direct questions', 2),
  ((SELECT domain_id FROM d), 'Follows Routines.', 3),
  ((SELECT domain_id FROM d), 'Engage in conversations.', 4),
  ((SELECT domain_id FROM d), 'Expands vocabulary.', 5),
  ((SELECT domain_id FROM d), 'Expresses thoughts and ideas.', 6)
ON CONFLICT (domain_id, name) DO NOTHING;

-- Domain 2: Social Skills
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Social Skills', 2, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Knows first, last name and age.', 1),
  ((SELECT domain_id FROM d), 'Interacts well with peers.', 2),
  ((SELECT domain_id FROM d), 'Demonstrates good manners', 3),
  ((SELECT domain_id FROM d), 'Follow classroom rules.', 4),
  ((SELECT domain_id FROM d), 'Shares well with others and takes turns.', 5),
  ((SELECT domain_id FROM d), 'Listens and responds to others.', 6)
ON CONFLICT (domain_id, name) DO NOTHING;

-- Domain 3: Emotional Development
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Emotional Development', 3, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Expresses emotions appropriately.', 1),
  ((SELECT domain_id FROM d), 'Demonstrates independence.', 2),
  ((SELECT domain_id FROM d), 'Shows empathy towards others.', 3),
  ((SELECT domain_id FROM d), 'Copes with frustration and disappointment.', 4)
ON CONFLICT (domain_id, name) DO NOTHING;

-- Domain 4: Reading and Writing Skills
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Reading and Writing Skills', 4, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Knows how to say ABCs.', 1),
  ((SELECT domain_id FROM d), 'Recognizes ABCs.', 2),
  ((SELECT domain_id FROM d), 'Can Print first name.', 3),
  ((SELECT domain_id FROM d), 'Can print the last name.', 4)
ON CONFLICT (domain_id, name) DO NOTHING;

-- Domain 5: Colours and Shapes
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Colours and Shapes', 5, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Knows primary colours.', 1),
  ((SELECT domain_id FROM d), 'Knows shapes.', 2),
  ((SELECT domain_id FROM d), 'Understand sizes(big/small).', 3)
ON CONFLICT (domain_id, name) DO NOTHING;

-- Domain 6: Numbers
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Numbers', 6, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Recognizes numbers one to ten.', 1),
  ((SELECT domain_id FROM d), 'Understands empty and full.', 2),
  ((SELECT domain_id FROM d), 'Understands more or less.', 3)
ON CONFLICT (domain_id, name) DO NOTHING;

-- Domain 7: Fine Motor Skills
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Fine Motor Skills', 7, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Can hold and use a pencil or a crayon', 1),
  ((SELECT domain_id FROM d), 'Can hold and use scissors', 2),
  ((SELECT domain_id FROM d), 'Cuts and pastes with coordination', 3),
  ((SELECT domain_id FROM d), 'Can hold and use a glue stick/paintbrush', 4),
  ((SELECT domain_id FROM d), 'Manipulates small objects.', 5),
  ((SELECT domain_id FROM d), 'Shows increasing independence in self-help tasks (e.g., dressing, feeding).', 6),
  ((SELECT domain_id FROM d), 'Demonstrates hand-eye coordination.', 7)
ON CONFLICT (domain_id, name) DO NOTHING;


-- ============================================================
-- REPORT CARD DOMAINS & SKILLS (BG/DV/NI scale)
-- ============================================================

-- Domain 1: Approaches to Learning
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('report_card', 'Approaches to Learning', 1, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, description, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Play/Curiosity', 'Initiates Play with peers', 1),
  ((SELECT domain_id FROM d), 'Persistence', 'Shows interest in learning by participating', 2),
  ((SELECT domain_id FROM d), 'Self-Organization', 'Invests time in an activity despite distraction', 3),
  ((SELECT domain_id FROM d), 'Reasoning', 'Attempts to resolve conflicts', 4),
  ((SELECT domain_id FROM d), 'Application', 'Makes real-world connections in the classroom', 5)
ON CONFLICT (domain_id, name) DO NOTHING;

-- Domain 2: Social/Emotional Development
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('report_card', 'Social/Emotional Development', 2, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, description, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Self-Concept', 'Participates in individual and group play', 1),
  ((SELECT domain_id FROM d), 'Self-Control', 'Demonstrates confidence in their abilities and expresses pride in accomplishments', 2),
  ((SELECT domain_id FROM d), 'Interactions with Others', 'Takes turn during Activities', 3),
  ((SELECT domain_id FROM d), 'Sense of Community', 'Understands rules and routines', 4),
  ((SELECT domain_id FROM d), 'Self-Expression', 'Can clearly express feelings, needs, and opinions', 5),
  ((SELECT domain_id FROM d), 'Empathy', 'Demonstrates empathy and caring for others', 6)
ON CONFLICT (domain_id, name) DO NOTHING;

-- Domain 3: Language Development & Communication
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('report_card', 'Language Development & Communication', 3, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, description, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Listening & Understanding', 'Follows directions that involve multiple steps', 1),
  ((SELECT domain_id FROM d), 'Verbal Interaction', 'Waits and takes turns during conversations', 2),
  ((SELECT domain_id FROM d), 'Speaking & Communicating', 'Communicates clearly', 3),
  ((SELECT domain_id FROM d), 'Initiating Communication', 'Initiates conversations with adults and children', 4)
ON CONFLICT (domain_id, name) DO NOTHING;

-- Domain 4: Literacy
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('report_card', 'Literacy', 4, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, description, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Writing', 'Writes own name', 1),
  ((SELECT domain_id FROM d), 'Reading', 'Can identify letter sounds', 2),
  ((SELECT domain_id FROM d), 'Phonemic & Phonological Awareness (Uppercase)', 'Can identify Uppercase and Lowercase letter names', 3),
  ((SELECT domain_id FROM d), 'Phonemic & Phonological Awareness (Writing)', 'Can write Uppercase and Lowercase letters', 4),
  ((SELECT domain_id FROM d), 'Book Knowledge & Comprehension (Listening)', 'Able to sit and listen to a story', 5),
  ((SELECT domain_id FROM d), 'Book Knowledge & Comprehension (Retelling)', 'Retells parts of a story', 6),
  ((SELECT domain_id FROM d), 'Print Awareness & Concepts (Name Recognition)', 'Recognizes own name', 7),
  ((SELECT domain_id FROM d), 'Print Awareness & Concepts (Sight Words)', 'Recognizes and reads sight words', 8)
ON CONFLICT (domain_id, name) DO NOTHING;

-- Domain 5: Science
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('report_card', 'Science', 5, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, description, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Scientific Knowledge', 'Makes observations and predictions', 1),
  ((SELECT domain_id FROM d), 'Scientific Skills and Methods', 'Investigates cause-and-effect relationships', 2)
ON CONFLICT (domain_id, name) DO NOTHING;

-- Domain 6: Mathematics
WITH d AS (
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ('report_card', 'Mathematics', 6, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING domain_id
)
INSERT INTO jksk_skills (domain_id, name, description, sort_order)
VALUES
  ((SELECT domain_id FROM d), 'Number Sense', 'Recognizes and counts numbers', 1),
  ((SELECT domain_id FROM d), 'Measurement', 'Understands concepts of size and comparison', 2),
  ((SELECT domain_id FROM d), 'Geometry & Spatial Sense', 'Identifies and describes shapes', 3),
  ((SELECT domain_id FROM d), 'Patterning', 'Recognizes and creates simple patterns', 4)
ON CONFLICT (domain_id, name) DO NOTHING;
