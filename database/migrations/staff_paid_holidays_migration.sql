-- Staff paid holidays — what a school closure means for staff hours.
-- Run this migration against your Supabase PostgreSQL database BEFORE deploying
-- the backend (the staff attendance query reads staff_day). Safe to re-run.
--
-- A calendar event flagged is_school_closed used to drop the day from staff
-- hours entirely, so Thanksgiving and PA days paid nothing. staff_day says
-- what the closure means for staff:
--   'off'  — unpaid day off (the old behaviour; the default)
--   'paid' — paid holiday: counts as a full work day for everyone who works it
--   'work' — staff still come in (a PA day): an ordinary work day
-- Ontario's statutory holidays are paid regardless of this column; it covers
-- the rest (Eid, a break the school pays for, PA days).

BEGIN;

ALTER TABLE school_calendar_events
  ADD COLUMN IF NOT EXISTS staff_day VARCHAR(10) NOT NULL DEFAULT 'off';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'school_calendar_events_staff_day_check'
  ) THEN
    ALTER TABLE school_calendar_events
      ADD CONSTRAINT school_calendar_events_staff_day_check
      CHECK (staff_day IN ('off', 'paid', 'work'));
  END IF;
END $$;

-- Staff work on PA days.
UPDATE school_calendar_events
SET staff_day = 'work', updated_at = NOW()
WHERE category = 'pa-day' AND is_school_closed = true AND staff_day = 'off';

COMMIT;
