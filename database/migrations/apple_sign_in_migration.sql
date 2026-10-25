-- apple_sign_in_migration.sql
--
-- "Sign in with Apple" in the iOS app. apple_sub is the stable Apple ID for
-- our team (the identity token's `sub` claim). It is stamped the first time
-- someone signs in with Apple, or when a signed-in account connects its Apple
-- ID after Apple hid the email, and from then on that Apple ID always opens
-- this SchoolMule account.
--
-- Partial unique index: one SchoolMule account per Apple ID, and any number
-- of accounts that have never used Apple.
--
-- Entirely additive and safe to re-run. Apply BEFORE the backend that reads it.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS apple_sub TEXT;

-- Apple's refresh token for the account, encrypted (APPLE_TOKEN_ENC_KEY).
-- Deleting the account revokes it at Apple, as App Review requires.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS apple_refresh_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_apple_sub_key
  ON users (apple_sub)
  WHERE apple_sub IS NOT NULL;

COMMIT;
