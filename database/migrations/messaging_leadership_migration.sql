-- Messaging: let parents write to school leadership.
--
-- Admin accounts carry an optional staff title ("Principal", "Vice Principal").
-- Parents may start a General thread with any admin in their school who has
-- one; admins without a title stay invisible to parents, so office or system
-- accounts are never offered as recipients. Edited from Admin Panel → Users.

ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_title TEXT;
COMMENT ON COLUMN users.staff_title IS 'Shown to parents as the role of a messageable admin (e.g. Principal). NULL = not messageable by parents.';
