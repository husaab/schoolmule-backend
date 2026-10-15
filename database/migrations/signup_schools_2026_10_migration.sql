-- Signup directory tenants (applied to prod via Supabase MCP on 2026-10-15).
-- Adds Al-Zahra Institute, Peterborough Montessori and Bliss Carman Public
-- School, and registers JCC (which had an enum label but no schools row).
-- ALRASOOLACADEMY stays in the enum (Postgres cannot drop enum labels; it has
-- no users, students or classes) but is no longer offered on /signup.
--
-- Step 1 must commit before step 2: a new enum label cannot be used inside
-- the transaction that adds it.
ALTER TYPE public.school ADD VALUE IF NOT EXISTS 'ALZAHRAINSTITUTE';
ALTER TYPE public.school ADD VALUE IF NOT EXISTS 'PETERBOROUGHMONTESSORI';
ALTER TYPE public.school ADD VALUE IF NOT EXISTS 'BLISSCARMANPS';

-- Step 2: school rows + an active 2026-2027 year for each.
BEGIN;

INSERT INTO schools (school_code, name, slug, timezone, academic_year_start_date, academic_year_end_date, last_updated_at)
VALUES
  ('ALZAHRAINSTITUTE',       'Al-Zahra Institute',          'al-zahra-institute',        'EST', DATE '2026-09-08', DATE '2027-06-25', NOW()),
  ('PETERBOROUGHMONTESSORI', 'Peterborough Montessori',     'peterborough-montessori',   'EST', DATE '2026-09-08', DATE '2027-06-25', NOW()),
  ('BLISSCARMANPS',          'Bliss Carman Public School',  'bliss-carman-public-school','EST', DATE '2026-09-08', DATE '2027-06-25', NOW()),
  ('JCC',                    'Jaffari Community Centre',    'jaffari-community-centre',  'EST', DATE '2026-09-08', DATE '2027-06-25', NOW())
ON CONFLICT (school_code) DO NOTHING;

INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
SELECT s.school_code, s.school_id, '2026-2027', s.academic_year_start_date, s.academic_year_end_date, TRUE
FROM schools s
WHERE s.school_code IN ('ALZAHRAINSTITUTE', 'PETERBOROUGHMONTESSORI', 'BLISSCARMANPS', 'JCC')
  AND NOT EXISTS (SELECT 1 FROM school_years y WHERE y.school_id = s.school_id)
ON CONFLICT (school_id, label) DO NOTHING;

COMMIT;
