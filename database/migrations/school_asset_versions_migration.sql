-- ============================================================
-- School asset history (2026-11-26).
--
-- A school's logo, principal signature and stamp each live at one storage
-- path, and replacing one overwrote the file in place: the old image was
-- gone, and so was any way back. Now the current file is copied aside before
-- it is replaced or deleted, and a row here says what it was, who replaced
-- it and when, so School Assets can list the earlier versions and restore
-- one. The newest ten per school and asset are kept.
--
-- The copies go to a private bucket (school-assets is public: its files
-- print on reports). Earlier versions are only read through short-lived
-- signed URLs, by holders of School setup.
--
-- Additive only; safe to re-run. Apply BEFORE the backend that reads it: an
-- upload now keeps a copy first, and refuses to overwrite when it can't.
-- Rollback: DROP TABLE school_asset_versions;
--           (the bucket can stay; to remove it, empty it first, then
--            DELETE FROM storage.buckets WHERE id = 'school-assets-history';)
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS school_asset_versions (
  version_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         UUID NOT NULL REFERENCES schools(school_id) ON DELETE CASCADE,
  school            public.school NOT NULL,
  asset_type        TEXT NOT NULL CHECK (asset_type IN ('logo', 'principal_signature', 'school_stamp')),
  storage_path      TEXT NOT NULL,   -- in the school-assets-history bucket
  live_ext          TEXT NOT NULL,   -- the extension it had when live, e.g. '.png'
  content_type      TEXT,
  byte_size         INTEGER,
  replaced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replaced_by       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  reason            TEXT NOT NULL CHECK (reason IN ('replaced', 'deleted', 'restored_over')),
  source_action_id  UUID             -- the assistant action that did it, when one did
);

CREATE INDEX IF NOT EXISTS school_asset_versions_lookup
  ON school_asset_versions (school_id, asset_type, replaced_at DESC);

-- Like every table here: RLS on with no policies, so only the backend's own
-- role reads it and Supabase's public API can't.
ALTER TABLE school_asset_versions ENABLE ROW LEVEL SECURITY;

-- The private bucket the copies live in. Same size and types as an upload.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('school-assets-history', 'school-assets-history', false, 5242880,
        ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif'])
ON CONFLICT (id) DO NOTHING;

COMMIT;
