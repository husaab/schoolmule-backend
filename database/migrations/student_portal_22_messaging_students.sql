-- ============================================================
-- Student portal, phase 2 (Task 17): students in conversations.
-- Run after student_portal_21_submissions.sql. Safe to re-run.
-- ============================================================
-- Student portal, phase 2: students in conversations. Only threads that
-- explicitly include the student show it to them, so every existing
-- parent–teacher thread stays between the adults. A thread can be anchored
-- to one piece of classwork ("private comments" on that work).
--
-- Additive only: two new columns (one defaulted, one nullable) and a partial
-- unique index. Every existing row gets includes_student = FALSE and no
-- anchor, which is exactly today's behaviour; the code on main never reads
-- either column. Student messages are stored with sender_role 'STUDENT'
-- (messages.sender_role is VARCHAR(10) with no CHECK) and item threads use
-- the existing kind 'general', so no constraint needs widening.
-- ============================================================

BEGIN;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS includes_student BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS classwork_item_id UUID REFERENCES classwork_items(item_id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_classwork_anchor
  ON conversations (student_id, classwork_item_id) WHERE classwork_item_id IS NOT NULL;
COMMIT;
