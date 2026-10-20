-- ============================================================
-- Staff roles (RBAC): a school names a set of permission keys and gives it to
-- ADMIN or TEACHER accounts through users.staff_role_id. The key catalog
-- lives in config/permissions.js, not here, so a mistyped key is refused by
-- the API and dropped when a role is read. A NULL staff_role_id means the
-- built-in role for the account's base role (ADMIN = everything, TEACHER =
-- the teacher default); built-ins have no rows.
--
-- ON DELETE RESTRICT on purpose: deleting a role must never quietly change the
-- access of the people who hold it (SET NULL would turn a restricted admin
-- back into a full admin). The API refuses with a count first; the FK is the
-- race-safe backstop.
--
-- DEPLOY ORDER: 1) this migration  2) backend  3) frontend. The backend reads
-- staff_roles on every signed-in staff request, so a backend deployed before
-- this migration fails them all.
--
-- Additive only and safe to re-run.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS staff_roles (
  role_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school       school NOT NULL,
  name         VARCHAR(60) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description  TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  permissions  TEXT[] NOT NULL DEFAULT '{}',
  created_by   UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_roles_school_name_key
  ON staff_roles (school, lower(name));

ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_role_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_staff_role_id_fkey') THEN
    ALTER TABLE users
      ADD CONSTRAINT users_staff_role_id_fkey
      FOREIGN KEY (staff_role_id) REFERENCES staff_roles(role_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_staff_role_idx
  ON users (staff_role_id) WHERE staff_role_id IS NOT NULL;

-- Backend-only table, same posture as the other app tables.
ALTER TABLE staff_roles ENABLE ROW LEVEL SECURITY;

COMMIT;
