-- ============================================================
-- Student portal, phase 2: the private "classwork-submissions" storage
-- bucket (students' turned-in files, 10 MB each). Run by the controller in
-- the Supabase SQL editor after student_portal_21_submissions.sql; it is
-- not mirrored in the test seed. Files are read through signed URLs only,
-- at <SCHOOL>/<item_id>/<student_id>/<uuid><ext>.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('classwork-submissions', 'classwork-submissions', false, 10485760)
ON CONFLICT (id) DO NOTHING;
