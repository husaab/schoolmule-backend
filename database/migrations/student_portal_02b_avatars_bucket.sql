-- ============================================================
-- Student portal, phase 1: the private "avatars" storage bucket (profile
-- photos). Run by the controller in the Supabase SQL editor; it is not
-- mirrored in the test seed. Photos are read through signed URLs only.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', false, 2097152, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;
