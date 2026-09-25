-- Staff pay schedules v2: the work day itself.
-- Run after staff_pay_schedules_migration.sql. Safe to re-run.
--
-- A school can now say when staff are expected in (work_day_start). It is
-- informational — shown to staff and on the PDF next to the hours a day is
-- worth — and does not change how hours are counted.
--
-- Al Haadi Academy (2026-09-25): teachers are expected by 8:30 and a day is
-- paid as 6.5 hours, so a full-time period of 14 school days is 91 hours.

BEGIN;

ALTER TABLE staff_pay_schedules
  ADD COLUMN IF NOT EXISTS work_day_start TIME;

UPDATE staff_pay_schedules
SET default_hours_per_day = 6.5,
    work_day_start = '08:30',
    updated_at = now()
WHERE school = 'ALHAADIACADEMY';

COMMIT;
