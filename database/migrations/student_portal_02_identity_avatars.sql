-- ============================================================
-- Student portal, phase 1: class banner/icon/color (NULL = the subject
-- default), class options, class archive, avatars for everyone and optional
-- photos. Additive only: new nullable or defaulted columns, no drops.
-- Apply AFTER student_portal_01_accounts.sql and BEFORE deploying the code
-- that selects these columns. Safe to re-run.
-- ============================================================
BEGIN;

ALTER TABLE classes  ADD COLUMN IF NOT EXISTS banner_key         TEXT;      -- library family key
ALTER TABLE classes  ADD COLUMN IF NOT EXISTS banner_path        TEXT;      -- upload in the school-assets bucket
ALTER TABLE classes  ADD COLUMN IF NOT EXISTS icon_key           TEXT;
ALTER TABLE classes  ADD COLUMN IF NOT EXISTS color              TEXT;
ALTER TABLE classes  ADD COLUMN IF NOT EXISTS accept_late        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE classes  ADD COLUMN IF NOT EXISTS email_new_posts    BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE classes  ADD COLUMN IF NOT EXISTS show_class_average BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE classes  ADD COLUMN IF NOT EXISTS archived_at        TIMESTAMPTZ;
ALTER TABLE classes  ADD COLUMN IF NOT EXISTS archived_by        UUID REFERENCES users(user_id) ON DELETE SET NULL;

ALTER TABLE users    ADD COLUMN IF NOT EXISTS avatar     JSONB;            -- {style, skin, bg}; NULL = neutral avatar
ALTER TABLE users    ADD COLUMN IF NOT EXISTS photo_path TEXT;             -- private bucket "avatars"
ALTER TABLE students ADD COLUMN IF NOT EXISTS avatar     JSONB;            -- set by a teacher for students without a login (JK/SK)

COMMIT;
