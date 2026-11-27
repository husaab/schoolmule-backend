-- ============================================================
-- Muley: the images people attach in the panel (2026-11-27)
-- ============================================================
-- assistant_attachments  one row per image a person attached (a new school
--                        stamp, logo or signature). The file itself is in
--                        the private school-assets-history bucket at
--                        storage_path (<school>/muley-uploads/<user>/<id>).
--                        Saving a change copies the image into the school's
--                        assets, so the attachment is only needed until the
--                        preview is saved or expires (24 hours): the
--                        retention worker removes the file and the row after
--                        two days (services/assistant/attachments.js).
--
-- Additive and reversible:
--   DROP TABLE IF EXISTS assistant_attachments;
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS assistant_attachments (
  attachment_id  TEXT PRIMARY KEY,                 -- <uuid>.<ext>: also the file's name in storage
  school         public.school NOT NULL,
  user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  storage_path   TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL CHECK (byte_size > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS assistant_attachments_created ON assistant_attachments (created_at);
CREATE INDEX IF NOT EXISTS assistant_attachments_owner ON assistant_attachments (user_id, created_at DESC);

-- Read and written only by the backend's own connection, like the other assistant tables.
ALTER TABLE assistant_attachments ENABLE ROW LEVEL SECURITY;

COMMIT;
