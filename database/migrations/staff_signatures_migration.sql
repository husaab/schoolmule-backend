-- ============================================================
-- Staff signatures + the kindergarten teacher assistant as a co-teacher.
--
-- 1. users.signature_path: a staff member's own signature (Settings → My
--    signature), a transparent PNG in the private "signatures" bucket. It
--    prints on every JK/SK progress report and report card where they are
--    the teacher or the teacher assistant.
-- 2. jk_/sk_teacher_assistants: the assistant is now a co-teacher of the
--    student's Kindergarten class (class_teachers), not a typed name.
--      no row, or user id NULL and no_assistant false → the class default
--        (its only co-teacher; none when it has several or none)
--      teacher_assistant_user_id                     → that co-teacher
--      no_assistant                                  → no assistant
--    teacher_assistant_name is no longer written or read (kept, not dropped).
-- 3. Backfill: a typed name that matches exactly one staff account at the
--    student's school (case and spaces ignored) becomes that account.
--
-- Additive only. Apply BEFORE deploying the backend that reads these
-- columns. Safe to re-run.
-- ============================================================
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_path TEXT;   -- private bucket "signatures"

ALTER TABLE jk_teacher_assistants
  ADD COLUMN IF NOT EXISTS teacher_assistant_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS no_assistant BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sk_teacher_assistants
  ADD COLUMN IF NOT EXISTS teacher_assistant_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS no_assistant BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jk_teacher_assistants_one_choice') THEN
    ALTER TABLE jk_teacher_assistants ADD CONSTRAINT jk_teacher_assistants_one_choice
      CHECK (NOT (no_assistant AND teacher_assistant_user_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sk_teacher_assistants_one_choice') THEN
    ALTER TABLE sk_teacher_assistants ADD CONSTRAINT sk_teacher_assistants_one_choice
      CHECK (NOT (no_assistant AND teacher_assistant_user_id IS NOT NULL));
  END IF;
END $$;

-- Backfill typed names (only an unambiguous match at the student's school).
UPDATE jk_teacher_assistants t
   SET teacher_assistant_user_id = m.user_id
  FROM (
    SELECT t2.id, MIN(u.user_id::text)::uuid AS user_id
      FROM jk_teacher_assistants t2
      JOIN students_all s ON s.student_id = t2.student_id
      JOIN users u ON u.school::text = s.school::text
                  AND u.role::text IN ('TEACHER', 'ADMIN')
                  AND lower(btrim(u.username)) = lower(btrim(t2.teacher_assistant_name))
     WHERE NULLIF(btrim(t2.teacher_assistant_name), '') IS NOT NULL
       AND t2.teacher_assistant_user_id IS NULL
     GROUP BY t2.id
    HAVING COUNT(*) = 1
  ) m
 WHERE t.id = m.id;

UPDATE sk_teacher_assistants t
   SET teacher_assistant_user_id = m.user_id
  FROM (
    SELECT t2.id, MIN(u.user_id::text)::uuid AS user_id
      FROM sk_teacher_assistants t2
      JOIN students_all s ON s.student_id = t2.student_id
      JOIN users u ON u.school::text = s.school::text
                  AND u.role::text IN ('TEACHER', 'ADMIN')
                  AND lower(btrim(u.username)) = lower(btrim(t2.teacher_assistant_name))
     WHERE NULLIF(btrim(t2.teacher_assistant_name), '') IS NOT NULL
       AND t2.teacher_assistant_user_id IS NULL
     GROUP BY t2.id
    HAVING COUNT(*) = 1
  ) m
 WHERE t.id = m.id;

-- The private bucket (Supabase only; a plain Postgres test database has no
-- storage schema). PNG only, 1 MB at most: the server writes these itself.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('signatures', 'signatures', FALSE, 1048576, ARRAY['image/png'])
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

COMMIT;
