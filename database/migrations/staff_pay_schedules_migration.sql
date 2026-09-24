-- Staff pay schedules + hours worked.
-- Run this migration against your Supabase PostgreSQL database. Safe to re-run.
--
-- A school configures when staff are paid (monthly on the 25th, every second
-- Friday, …). A pay period ENDS on the pay day, inclusive, and starts the day
-- after the previous pay day. Staff attendance reports then show, per person,
-- the hours worked in the period ending on each pay day.
--
-- Hours are derived from attendance: every PRESENT day counts the person's
-- hours per day (staff_work_schedules.hours_per_day, falling back to the
-- school's default_hours_per_day), unless an admin overrode that day's hours
-- on the record itself (teacher_attendance.hours — e.g. a half day).

BEGIN;

-- ─── One pay schedule per school ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_pay_schedules (
  school                   public.school PRIMARY KEY,
  frequency                TEXT NOT NULL CHECK (frequency IN ('MONTHLY', 'SEMI_MONTHLY', 'BIWEEKLY', 'WEEKLY')),
  -- MONTHLY / SEMI_MONTHLY: day(s) of the month staff are paid. A day past the
  -- end of a short month (e.g. 31 in February) lands on that month's last day.
  pay_day_of_month         SMALLINT CHECK (pay_day_of_month BETWEEN 1 AND 31),
  second_pay_day_of_month  SMALLINT CHECK (second_pay_day_of_month BETWEEN 1 AND 31),
  -- BIWEEKLY / WEEKLY: any real pay date; every pay day is a whole number of
  -- weeks (or fortnights) away from it.
  anchor_pay_date          DATE,
  default_hours_per_day    NUMERIC(4,2) NOT NULL DEFAULT 7.5 CHECK (default_hours_per_day > 0 AND default_hours_per_day <= 24),
  updated_by               UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_pay_schedules_shape CHECK (
    (frequency = 'MONTHLY'      AND pay_day_of_month IS NOT NULL) OR
    (frequency = 'SEMI_MONTHLY' AND pay_day_of_month IS NOT NULL AND second_pay_day_of_month IS NOT NULL
                                AND second_pay_day_of_month <> pay_day_of_month) OR
    (frequency IN ('BIWEEKLY', 'WEEKLY') AND anchor_pay_date IS NOT NULL)
  )
);

-- ─── Per-staff hours per day ─────────────────────────────────────────────
-- staff_work_schedules becomes the person's full work profile: which days
-- they work (nullable now — "no override, use the planner") and how many
-- hours a work day is worth.
ALTER TABLE staff_work_schedules
  ADD COLUMN IF NOT EXISTS hours_per_day NUMERIC(4,2) CHECK (hours_per_day > 0 AND hours_per_day <= 24);

ALTER TABLE staff_work_schedules ALTER COLUMN work_days DROP NOT NULL;

ALTER TABLE staff_work_schedules DROP CONSTRAINT IF EXISTS staff_work_schedules_work_days_check;
ALTER TABLE staff_work_schedules ADD CONSTRAINT staff_work_schedules_work_days_check CHECK (
  work_days IS NULL OR (cardinality(work_days) > 0 AND work_days <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[])
);

-- A row must say something.
ALTER TABLE staff_work_schedules DROP CONSTRAINT IF EXISTS staff_work_schedules_not_empty;
ALTER TABLE staff_work_schedules ADD CONSTRAINT staff_work_schedules_not_empty CHECK (
  work_days IS NOT NULL OR hours_per_day IS NOT NULL
);

-- ─── Per-day hours override on the attendance record ─────────────────────
ALTER TABLE teacher_attendance
  ADD COLUMN IF NOT EXISTS hours NUMERIC(4,2) CHECK (hours >= 0 AND hours <= 24);

-- ─── Al Haadi Academy: paid monthly on the 25th ──────────────────────────
INSERT INTO staff_pay_schedules (school, frequency, pay_day_of_month, default_hours_per_day)
VALUES ('ALHAADIACADEMY', 'MONTHLY', 25, 7.0)
ON CONFLICT (school) DO NOTHING;

-- ─── Al Haadi Academy: drop check-ins recorded outside any school year ───
-- Summer and pre-opening check-ins (July 2026, Sept 3–7 2026) predate the
-- 2026-2027 year's first open day (Sept 8) and are not real attendance.
DELETE FROM teacher_attendance ta
WHERE ta.school = 'ALHAADIACADEMY'
  AND NOT EXISTS (
    SELECT 1 FROM school_years sy
    WHERE sy.school = ta.school
      AND ta.attendance_date BETWEEN sy.start_date AND sy.end_date
  );

COMMIT;
