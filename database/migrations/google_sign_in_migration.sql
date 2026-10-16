-- google_sign_in_migration.sql
--
-- "Sign in with Google". google_sub is the stable Google account id (the ID
-- token's `sub` claim). It is stamped the first time someone signs in with
-- Google, and from then on that Google account always opens this SchoolMule
-- account, even if the address on either side changes.
--
-- Partial unique index: one SchoolMule account per Google account, and any
-- number of accounts that have never used Google.
--
-- Entirely additive and safe to re-run.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_sub TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_key
  ON users (google_sub)
  WHERE google_sub IS NOT NULL;

COMMIT;
