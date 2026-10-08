-- approvals_decline_migration.sql
--
-- "Declining" a signup now archives the account (so it stops showing up as
-- pending and can't sign in) and stamps declined_at so the Approvals page can
-- tell a declined signup apart from staff who were approved and later archived
-- from the Users page. Restoring a declined signup clears the stamp and puts
-- them back in the pending queue without granting access.
--
-- Entirely additive and safe to re-run.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;

COMMIT;
