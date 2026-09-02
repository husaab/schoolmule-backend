-- registration_statuses_migration.sql
--
-- Replaces the hardcoded submission status CHECK constraint with a per-school
-- status vocabulary, so schools can add their own workflow states (Waitlist,
-- Accepted, Declined, ...) alongside the built-in ones.
--
-- Design notes:
--
--   * `registration_form_submissions.status` keeps holding the status *key*
--     as text rather than becoming a UUID foreign key. That means no data
--     backfill, and every existing query that reads or writes 'new' /
--     'reviewed' / 'archived' keeps working untouched.
--
--   * Referential integrity is still enforced, via a composite FK on
--     (school, status) → registration_statuses (school, key). ON UPDATE CASCADE
--     means renaming a custom status's key propagates to its submissions
--     instead of orphaning them.
--
--   * Built-in keys are immutable (the app enforces this), so the queries that
--     count 'new' submissions for the sidebar badge stay correct forever.

BEGIN;

CREATE TABLE IF NOT EXISTS registration_statuses (
  status_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school      school NOT NULL,
  -- Stored on submissions; immutable for built-ins.
  key         VARCHAR(40) NOT NULL,
  label       VARCHAR(60) NOT NULL,
  -- Palette token (e.g. 'cyan'), resolved to classes in the UI rather than
  -- storing raw CSS, so the design can change without a data migration.
  color       VARCHAR(20) NOT NULL DEFAULT 'slate',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  -- Built-ins ship with the product: undeletable key, editable label/colour.
  is_builtin  BOOLEAN NOT NULL DEFAULT false,
  -- Exactly one per school: what a freshly received submission gets.
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (school, key)
);

CREATE INDEX IF NOT EXISTS idx_registration_statuses_school
  ON registration_statuses (school, sort_order);

-- At most one default status per school.
CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_statuses_one_default
  ON registration_statuses (school) WHERE is_default;

-- ─── Seed the built-ins for every existing school ─────────────────────
-- Every status value already present on submissions must exist here before
-- the foreign key below can be added.
INSERT INTO registration_statuses (school, key, label, color, sort_order, is_builtin, is_default)
SELECT s.value, v.key, v.label, v.color, v.sort_order, true, v.is_default
FROM (SELECT unnest(enum_range(NULL::school)) AS value) s
CROSS JOIN (VALUES
  ('new',      'New',      'cyan',    0, true),
  ('reviewed', 'Reviewed', 'emerald', 1, false),
  ('waitlist', 'Waitlist', 'amber',   2, false),
  ('archived', 'Archived', 'slate',   3, false)
) AS v(key, label, color, sort_order, is_default)
ON CONFLICT (school, key) DO NOTHING;

-- ─── Swap the CHECK for a real foreign key ────────────────────────────
ALTER TABLE registration_form_submissions
  DROP CONSTRAINT IF EXISTS registration_form_submissions_status_check;

ALTER TABLE registration_form_submissions
  ADD CONSTRAINT registration_form_submissions_status_fkey
    FOREIGN KEY (school, status)
    REFERENCES registration_statuses (school, key)
    ON UPDATE CASCADE;

COMMIT;
