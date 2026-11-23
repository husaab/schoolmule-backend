-- ============================================================
-- Parent–teacher meetings: in person or a phone call (2026-11-22).
--
-- A family chooses, per meeting, to come in or to have the teacher phone
-- them at a number they give. The office can turn phone calls off for an
-- event (allow_phone); on by default, existing events included.
--
-- Additive only: existing bookings stay in person. Apply BEFORE the backend
-- that reads ptm_bookings.mode. Safe to re-run.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE ptm_events ADD COLUMN IF NOT EXISTS allow_phone BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE ptm_bookings ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'in_person';
-- The number the teacher calls (mode 'phone'), as the family typed it.
ALTER TABLE ptm_bookings ADD COLUMN IF NOT EXISTS phone TEXT;

DO $$
BEGIN
  ALTER TABLE ptm_bookings ADD CONSTRAINT ptm_bookings_mode_ck CHECK (mode IN ('in_person', 'phone'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE ptm_bookings ADD CONSTRAINT ptm_bookings_phone_ck
    CHECK (mode <> 'phone' OR (phone IS NOT NULL AND length(phone) BETWEEN 7 AND 40));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
