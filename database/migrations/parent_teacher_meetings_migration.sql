-- ============================================================
-- Parent–teacher meetings (2026-11-22). Spec:
-- docs/superpowers/specs/2026-11-22-parent-teacher-meetings-design.md
--
-- The office sets up an event (days, school hours, breaks, meeting length,
-- when booking opens); every teacher may have their own days, hours, breaks,
-- meeting length and room. Parents book first come, first served. A
-- teacher's times are computed from their window, length and breaks
-- (services/meetings/slots.js), so only bookings are stored, never slots.
--
-- Times are a DATE plus minutes from midnight, Toronto (as the planner).
-- Emails go through email_outbox (kinds ptm_*), so there is no job table.
--
-- Additive only: new tables nothing else reads. Apply BEFORE the backend
-- that serves /api/meetings. Safe to re-run.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ptm_events (
  event_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school               school NOT NULL,
  school_year_id       UUID NOT NULL REFERENCES school_years(school_year_id) ON DELETE CASCADE,
  title                TEXT NOT NULL DEFAULT 'Parent–teacher meetings',
  -- draft: only the office sees it; scheduled: opens by itself at opens_at;
  -- open: families can book (until each day's cutoff).
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'open')),
  slot_minutes         SMALLINT NOT NULL DEFAULT 10 CHECK (slot_minutes BETWEEN 5 AND 60),
  opens_at             TIMESTAMPTZ,
  opened_at            TIMESTAMPTZ,
  -- Families can book, change and cancel until this time (minutes after
  -- midnight) the evening before each day; NULL = until the meeting starts.
  cutoff_min           SMALLINT DEFAULT 1200 CHECK (cutoff_min IS NULL OR cutoff_min BETWEEN 0 AND 1439),
  use_grade_room       BOOLEAN NOT NULL DEFAULT TRUE,
  siblings_share       BOOLEAN NOT NULL DEFAULT TRUE,
  teachers_edit_hours  BOOLEAN NOT NULL DEFAULT TRUE,
  email_invite         BOOLEAN NOT NULL DEFAULT TRUE,
  email_last_call      BOOLEAN NOT NULL DEFAULT TRUE,
  last_call_at         TIMESTAMPTZ,
  last_call_sent_at    TIMESTAMPTZ,
  email_reminder       BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_min         SMALLINT NOT NULL DEFAULT 1080 CHECK (reminder_min BETWEEN 0 AND 1439),
  email_teacher_list   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by           UUID REFERENCES users(user_id) ON DELETE SET NULL,
  updated_by           UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ptm_events_school_year ON ptm_events (school, school_year_id);
CREATE INDEX IF NOT EXISTS idx_ptm_events_due ON ptm_events (opens_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_ptm_events_created_by ON ptm_events (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ptm_events_updated_by ON ptm_events (updated_by) WHERE updated_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS ptm_days (
  day_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              UUID NOT NULL REFERENCES ptm_events(event_id) ON DELETE CASCADE,
  day_date              DATE NOT NULL,
  -- The school hours: every teacher's unless they have their own.
  start_min             SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min               SMALLINT NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  -- FALSE: a day only for the teachers given hours on it (a make-up day).
  everyone              BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_sent_at      TIMESTAMPTZ,
  teacher_list_sent_at  TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ptm_days_window_ck CHECK (end_min > start_min),
  CONSTRAINT ptm_days_unique UNIQUE (event_id, day_date)
);

-- A teacher's own settings for one event (created on first edit).
CREATE TABLE IF NOT EXISTS ptm_teachers (
  event_id      UUID NOT NULL REFERENCES ptm_events(event_id) ON DELETE CASCADE,
  teacher_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  taking_part   BOOLEAN NOT NULL DEFAULT TRUE,
  slot_minutes  SMALLINT CHECK (slot_minutes IS NULL OR slot_minutes BETWEEN 5 AND 60),
  room          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, teacher_id)
);
CREATE INDEX IF NOT EXISTS idx_ptm_teachers_teacher ON ptm_teachers (teacher_id);

-- A teacher's own hours on one day. No row = the day's default (school
-- hours on an everyone day, not working on a day just for some teachers).
CREATE TABLE IF NOT EXISTS ptm_teacher_days (
  day_id      UUID NOT NULL REFERENCES ptm_days(day_id) ON DELETE CASCADE,
  teacher_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  works       BOOLEAN NOT NULL,
  start_min   SMALLINT CHECK (start_min IS NULL OR start_min BETWEEN 0 AND 1439),
  end_min     SMALLINT CHECK (end_min IS NULL OR end_min BETWEEN 1 AND 1440),
  PRIMARY KEY (day_id, teacher_id),
  CONSTRAINT ptm_teacher_days_window_ck CHECK (
    (start_min IS NULL AND end_min IS NULL) OR (start_min IS NOT NULL AND end_min IS NOT NULL AND end_min > start_min))
);
CREATE INDEX IF NOT EXISTS idx_ptm_teacher_days_teacher ON ptm_teacher_days (teacher_id);

-- Breaks: teacher_id NULL is everyone's (Maghrib); a teacher's own break;
-- kind 'closed' is a time the teacher closed from My Meetings.
CREATE TABLE IF NOT EXISTS ptm_breaks (
  break_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id      UUID NOT NULL REFERENCES ptm_days(day_id) ON DELETE CASCADE,
  teacher_id  UUID REFERENCES users(user_id) ON DELETE CASCADE,
  start_min   SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min     SMALLINT NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  label       TEXT,
  kind        TEXT NOT NULL DEFAULT 'break' CHECK (kind IN ('break', 'closed')),
  created_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ptm_breaks_window_ck CHECK (end_min > start_min)
);
CREATE INDEX IF NOT EXISTS idx_ptm_breaks_day ON ptm_breaks (day_id);
CREATE INDEX IF NOT EXISTS idx_ptm_breaks_teacher ON ptm_breaks (teacher_id) WHERE teacher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ptm_breaks_created_by ON ptm_breaks (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS ptm_bookings (
  booking_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL REFERENCES ptm_events(event_id) ON DELETE CASCADE,
  day_id       UUID NOT NULL REFERENCES ptm_days(day_id) ON DELETE CASCADE,
  teacher_id   UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  start_min    SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min      SMALLINT NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  booked_by    UUID REFERENCES users(user_id) ON DELETE SET NULL,
  by_office    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Bumped on every move, for calendar updates (ICS SEQUENCE).
  sequence     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ptm_bookings_window_ck CHECK (end_min > start_min),
  -- One family per teacher time (overlaps are checked in the transaction).
  CONSTRAINT ptm_bookings_teacher_time UNIQUE (teacher_id, day_id, start_min)
);
CREATE INDEX IF NOT EXISTS idx_ptm_bookings_event ON ptm_bookings (event_id, day_id);
CREATE INDEX IF NOT EXISTS idx_ptm_bookings_day ON ptm_bookings (day_id);
CREATE INDEX IF NOT EXISTS idx_ptm_bookings_booked_by ON ptm_bookings (booked_by) WHERE booked_by IS NOT NULL;

-- The children a meeting is about: one meeting per child per teacher.
CREATE TABLE IF NOT EXISTS ptm_booking_students (
  booking_id  UUID NOT NULL REFERENCES ptm_bookings(booking_id) ON DELETE CASCADE,
  event_id    UUID NOT NULL REFERENCES ptm_events(event_id) ON DELETE CASCADE,
  teacher_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES students_all(student_id) ON DELETE CASCADE,
  PRIMARY KEY (booking_id, student_id),
  CONSTRAINT ptm_booking_students_once UNIQUE (event_id, teacher_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_ptm_booking_students_student ON ptm_booking_students (student_id);
CREATE INDEX IF NOT EXISTS idx_ptm_booking_students_teacher ON ptm_booking_students (teacher_id);

ALTER TABLE ptm_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ptm_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE ptm_teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ptm_teacher_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE ptm_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ptm_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ptm_booking_students ENABLE ROW LEVEL SECURITY;

COMMIT;
