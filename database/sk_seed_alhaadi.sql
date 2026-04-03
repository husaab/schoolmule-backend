-- ============================================================
-- SK Seed Data - Al Haadi Academy
-- Run AFTER sk_migration.sql
-- ============================================================

-- ============================================================
-- REPORT CARD SUBJECTS & STANDARDS (E/P/DV/EM/NI/NA scale)
-- ============================================================

-- Subject 1: Mathematics - Counting and Cardinality
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'Mathematics - Counting and Cardinality', 1, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Counts to 100 by ones and tens', 1),
  ((SELECT subject_id FROM s), 'Writes numbers from 0 – 100', 2),
  ((SELECT subject_id FROM s), 'Counts groups of up to 20 objects accurately', 3),
  ((SELECT subject_id FROM s), 'Compares two numbers between 1 and 10 using less than, greater than or equal to', 4),
  ((SELECT subject_id FROM s), 'Represents addition and subtraction within 10 using objects', 5),
  ((SELECT subject_id FROM s), 'Decomposes numbers through ten in more than one way', 6),
  ((SELECT subject_id FROM s), 'Finds the number that makes 10 when added to a given number from 1 – 9', 7),
  ((SELECT subject_id FROM s), 'Fluently adds within 10', 8),
  ((SELECT subject_id FROM s), 'Fluently subtracts within 10', 9),
  ((SELECT subject_id FROM s), 'Composes and decomposes numbers from 11 – 19 into tens and ones', 10)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 2: Mathematics - Measurement and Data
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'Mathematics - Measurement and Data', 2, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Describes attributes of objects, such as length or weight', 1),
  ((SELECT subject_id FROM s), 'Directly compares objects to see which is heavier/lighter, taller/shorter, etc.', 2),
  ((SELECT subject_id FROM s), 'Classifies (sorts) objects into categories and counts the objects in each category', 3)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 3: Mathematics - Geometry
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'Mathematics - Geometry', 3, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Describes objects using names of shapes', 1),
  ((SELECT subject_id FROM s), 'Describes the relative position of shapes using terms such as above, below, in front of, behind and next to', 2),
  ((SELECT subject_id FROM s), 'Identifies shapes as 2-dimensional or 3-dimensional', 3),
  ((SELECT subject_id FROM s), 'Identifies 2-dimensional shapes: rectangle, triangle, square, circle, hexagon', 4),
  ((SELECT subject_id FROM s), 'Identifies 3-dimensional shapes: cube, cone, cylinder, sphere', 5)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 4: English/Language Arts - Reading Standards
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'English/Language Arts - Reading Standards', 4, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Retells familiar stories; Asks and answers questions about key details of a text', 1),
  ((SELECT subject_id FROM s), 'Identifies characters, settings, and major events in a story', 2),
  ((SELECT subject_id FROM s), 'Identifies front/back cover and title page of a book; Defines role of author and illustrator', 3),
  ((SELECT subject_id FROM s), 'Actively engages in group reading activities with purpose and understanding', 4),
  ((SELECT subject_id FROM s), 'Compare and contrasts texts on the same topic', 5),
  ((SELECT subject_id FROM s), 'Makes connections between self, text, and the world', 6)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 5: English/Language Arts - Foundational Skills
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'English/Language Arts - Foundational Skills', 5, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Tracks print from left to right, top to bottom, and page to page', 1),
  ((SELECT subject_id FROM s), 'Points to words with one-to-one correspondence (voice-to-print match)', 2),
  ((SELECT subject_id FROM s), 'Recognizes and names uppercase and lowercase letters', 3),
  ((SELECT subject_id FROM s), 'Recognizes and produces rhyming words', 4),
  ((SELECT subject_id FROM s), 'Segments words into individual sounds and blends sounds into words', 5),
  ((SELECT subject_id FROM s), 'Produces sound for each consonant and vowel', 6),
  ((SELECT subject_id FROM s), 'Reads grade-level high-frequency words by sight', 7),
  ((SELECT subject_id FROM s), 'Reads grade-level texts with accuracy, purpose, and understanding', 8)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 6: English/Language Arts - Writing Standards
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'English/Language Arts - Writing Standards', 6, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Uses a combination of drawing, dictating, and writing to express an opinion about a book', 1),
  ((SELECT subject_id FROM s), 'Uses a combination of drawing, dictating, and writing to share information', 2),
  ((SELECT subject_id FROM s), 'Uses a combination of drawing, dictating, and writing to tell a story', 3),
  ((SELECT subject_id FROM s), 'Adds details to strengthen writing', 4)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 7: English/Language Arts - Speaking and Listening
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'English/Language Arts - Speaking and Listening', 7, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Participates in conversations about kindergarten topics and texts', 1),
  ((SELECT subject_id FROM s), 'Follows agreed-upon rules for discussions (listening to others, taking turns talking, etc.)', 2),
  ((SELECT subject_id FROM s), 'Describes familiar people, places, things, and events', 3),
  ((SELECT subject_id FROM s), 'Speaks audibly and expresses thoughts, feelings, and ideas clearly', 4)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 8: English/Language Arts - Language Standards
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'English/Language Arts - Language Standards', 8, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Prints many upper and lowercase letters', 1),
  ((SELECT subject_id FROM s), 'Uses frequently occurring nouns, verbs, and prepositions', 2),
  ((SELECT subject_id FROM s), 'Uses inflections in speaking and understanding language', 3),
  ((SELECT subject_id FROM s), 'Understands and uses question words (who, what, where, when, how, and why)', 4),
  ((SELECT subject_id FROM s), 'Capitalizes the first word in a sentence and the pronoun I', 5),
  ((SELECT subject_id FROM s), 'Recognizes and names ending punctuation', 6),
  ((SELECT subject_id FROM s), 'Writes a letter for most consonant and short vowel sounds; Spells words phonetically', 7)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 9: Science and Technology
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'Science and Technology', 9, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Demonstrates an understanding of concepts and skills', 1),
  ((SELECT subject_id FROM s), 'Uses the processes and skills of an inquiry stance (questioning, planning, predicting, observing, communicating)', 2),
  ((SELECT subject_id FROM s), 'Demonstrates an awareness of surroundings', 3),
  ((SELECT subject_id FROM s), 'Demonstrates an understanding of the natural world and the need to care for and respect the environment', 4)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 10: Social Studies
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'Social Studies', 10, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Demonstrates an understanding of concepts and skills', 1),
  ((SELECT subject_id FROM s), 'Demonstrates an understanding of the diversity among individuals and families within the school and the wider community', 2),
  ((SELECT subject_id FROM s), 'Recognizes bias in ideas and develops self-confidence to stand up for themselves and others against prejudice and discrimination', 3)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 11: Islamic Studies
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'Islamic Studies', 11, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Demonstrates an understanding of the importance of Islamic beliefs and practices', 1),
  ((SELECT subject_id FROM s), 'Follows the teachings of the Quran and the sunnah of the Ahlulbayt in daily activities', 2),
  ((SELECT subject_id FROM s), 'Demonstrates the action of Salaat (e.g., ruku, sujood, and qunut, etc.)', 3),
  ((SELECT subject_id FROM s), 'Shows interest in praying regularly', 4)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 12: Arabic and Quran
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'Arabic and Quran', 12, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Identifies all Arabic Letters with their sound and proper pronunciation', 1),
  ((SELECT subject_id FROM s), 'Writes all Arabic Letters with proper formation', 2),
  ((SELECT subject_id FROM s), 'Memorizes and Pronounces Surahs Independently', 3)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 13: French
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'French', 13, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Identifies all French Letters with their sound and proper pronunciation', 1),
  ((SELECT subject_id FROM s), 'Writes all French Letters with proper formation', 2),
  ((SELECT subject_id FROM s), 'Demonstrates a good understanding of basic French vocabulary', 3)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 14: Arts and Crafts
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'Arts and Crafts', 14, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Demonstrates an awareness as an artist through engagement in the arts', 1),
  ((SELECT subject_id FROM s), 'Demonstrates knowledge and skills gained through exposure to and engagement in drama and visual arts', 2),
  ((SELECT subject_id FROM s), 'Expresses and responds to a variety of forms of visual arts from various cultures and communities', 3),
  ((SELECT subject_id FROM s), 'Uses problem-solving strategies when experimenting with skills, materials, processes, and techniques', 4),
  ((SELECT subject_id FROM s), 'Communicates thoughts and feelings, theories, and ideas, through various art forms', 5)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 15: Health and Physical Education
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'Health and Physical Education', 15, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Demonstrates an awareness of his/her own health and well-being', 1),
  ((SELECT subject_id FROM s), 'Actively and regularly participates in a variety of activities that require the application of movement concepts', 2),
  ((SELECT subject_id FROM s), 'Demonstrates balance, coordination, and control of body movements', 3),
  ((SELECT subject_id FROM s), 'Shows independence in personal care routines', 4)
ON CONFLICT (subject_id, name) DO NOTHING;

-- Subject 16: Social Skills and Work Habits
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('report_card', 'Social Skills and Work Habits', 16, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Shows enthusiasm for learning', 1),
  ((SELECT subject_id FROM s), 'Demonstrates appropriate self-control', 2),
  ((SELECT subject_id FROM s), 'Demonstrates a sense of identity and a positive self-image', 3),
  ((SELECT subject_id FROM s), 'Completes and submits class work, homework, and assignments according to agreed-upon timelines', 4),
  ((SELECT subject_id FROM s), 'Uses class time appropriately to complete tasks independently', 5),
  ((SELECT subject_id FROM s), 'Follows instructions with minimal supervision', 6),
  ((SELECT subject_id FROM s), 'Responds positively to the ideas, opinions, values, and traditions of others', 7),
  ((SELECT subject_id FROM s), 'Displays respect and cooperation', 8),
  ((SELECT subject_id FROM s), 'Demonstrates effort and displays good citizenship', 9)
ON CONFLICT (subject_id, name) DO NOTHING;


-- ============================================================
-- PROGRESS REPORT SUBJECTS & STANDARDS (E/G/S/NI/NA scale)
-- ============================================================

-- PR Subject 1: Mathematics
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Mathematics', 1, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Counts to 100 by ones and tens', 1),
  ((SELECT subject_id FROM s), 'Correctly writes numbers from 0 to 100', 2),
  ((SELECT subject_id FROM s), 'Represents a number of objects with a written numeral', 3),
  ((SELECT subject_id FROM s), 'Demonstrates one-to-one correspondence', 4),
  ((SELECT subject_id FROM s), 'Identifies and describes shapes (squares, circles, triangles, rectangles, hexagons, cubes, cones, cylinders, and spheres)', 5),
  ((SELECT subject_id FROM s), 'Makes accurate estimates of the number of objects in a set up to 20', 6),
  ((SELECT subject_id FROM s), 'Builds and draws shapes', 7)
ON CONFLICT (subject_id, name) DO NOTHING;

-- PR Subject 2: Language
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Language', 2, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Waits and takes turns during conversations', 1),
  ((SELECT subject_id FROM s), 'Clearly communicates needs and thoughts', 2),
  ((SELECT subject_id FROM s), 'Participates in communication around a topic', 3),
  ((SELECT subject_id FROM s), 'Understands and uses question words', 4),
  ((SELECT subject_id FROM s), 'Produces and expands complete sentences in shared language activities', 5),
  ((SELECT subject_id FROM s), 'Follows multiple step instructions', 6)
ON CONFLICT (subject_id, name) DO NOTHING;

-- PR Subject 3: Literacy - Reading
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Literacy - Reading', 3, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Recognizes and names all upper and lowercase letters of the alphabet', 1),
  ((SELECT subject_id FROM s), 'Reads common high-frequency words by sight', 2),
  ((SELECT subject_id FROM s), 'Recognizes and produces rhyming words', 3),
  ((SELECT subject_id FROM s), 'Demonstrates phonological awareness', 4),
  ((SELECT subject_id FROM s), 'Produces the primary sounds for each consonant', 5),
  ((SELECT subject_id FROM s), 'Associates the long and short sounds for the five major vowels', 6),
  ((SELECT subject_id FROM s), 'Follows words from left to right, top to bottom, and page by page', 7),
  ((SELECT subject_id FROM s), 'Reads emergent-reader texts with purpose and understanding', 8)
ON CONFLICT (subject_id, name) DO NOTHING;

-- PR Subject 4: Literacy - Writing
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Literacy - Writing', 4, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Prints all upper and lowercase letters correctly', 1),
  ((SELECT subject_id FROM s), 'Capitalizes the first word in a sentence and the pronoun I', 2),
  ((SELECT subject_id FROM s), 'Recognizes and names end punctuation', 3),
  ((SELECT subject_id FROM s), 'Spells simple words phonetically', 4),
  ((SELECT subject_id FROM s), 'Writes a letter or letters for most consonant and short-vowel sounds', 5),
  ((SELECT subject_id FROM s), 'Expresses an idea using pictures', 6),
  ((SELECT subject_id FROM s), 'Independently forms sentences', 7)
ON CONFLICT (subject_id, name) DO NOTHING;

-- PR Subject 5: Science and Social Studies
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Science and Social Studies', 5, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Participates in class discussions', 1),
  ((SELECT subject_id FROM s), 'Asks and pursues questions through simple investigations', 2),
  ((SELECT subject_id FROM s), 'Makes accurate predictions of the outcome', 3),
  ((SELECT subject_id FROM s), 'Makes simple observations', 4)
ON CONFLICT (subject_id, name) DO NOTHING;

-- PR Subject 6: Approaches to Learning
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Approaches to Learning', 6, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Initiates play with peers', 1),
  ((SELECT subject_id FROM s), 'Seeks alternative approaches to problem solving', 2),
  ((SELECT subject_id FROM s), 'Demonstrates curiosity and a willingness to participate in tasks and challenges', 3),
  ((SELECT subject_id FROM s), 'Demonstrates persistence in completing tasks', 4),
  ((SELECT subject_id FROM s), 'Participates in class discussions', 5),
  ((SELECT subject_id FROM s), 'Applies prior experiences to learning', 6),
  ((SELECT subject_id FROM s), 'Demonstrates an appropriate attention span', 7),
  ((SELECT subject_id FROM s), 'Completes activities and works in a timely manner', 8),
  ((SELECT subject_id FROM s), 'Completes and submits class work, homework, and assignments according to agreed-upon timelines', 9)
ON CONFLICT (subject_id, name) DO NOTHING;

-- PR Subject 7: Islamic Studies
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Islamic Studies', 7, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Demonstrates good moral values by caring, sharing and taking turns during daily class activities and routines', 1),
  ((SELECT subject_id FROM s), 'Demonstrates an understanding and interest in Islamic stories', 2)
ON CONFLICT (subject_id, name) DO NOTHING;

-- PR Subject 8: Creativity
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Creativity', 8, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Plans, works cooperatively and creates drawings, paintings, and other art projects', 1),
  ((SELECT subject_id FROM s), 'Demonstrates care and persistence when involved in art projects', 2)
ON CONFLICT (subject_id, name) DO NOTHING;

-- PR Subject 9: Arabic and Quran
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('progress_report', 'Arabic and Quran', 9, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Recognizes and writes Arabic Letters', 1),
  ((SELECT subject_id FROM s), 'Overall participation', 2),
  ((SELECT subject_id FROM s), 'Memorizes and Pronounces Surahs Independently', 3)
ON CONFLICT (subject_id, name) DO NOTHING;

-- PR Subject 10: French
WITH s AS (
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ('progress_report', 'French', 10, 'ALHAADIACADEMY')
  ON CONFLICT (document_type, name, school) DO UPDATE SET sort_order = EXCLUDED.sort_order
  RETURNING subject_id
)
INSERT INTO sk_standards (subject_id, name, sort_order) VALUES
  ((SELECT subject_id FROM s), 'Recognizes and writes French Letters', 1),
  ((SELECT subject_id FROM s), 'Overall participation', 2),
  ((SELECT subject_id FROM s), 'Basic vocabulary', 3)
ON CONFLICT (subject_id, name) DO NOTHING;
