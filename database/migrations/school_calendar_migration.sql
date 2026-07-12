-- School Calendar Feature Migration
-- Run this migration against your Supabase PostgreSQL database

CREATE TABLE IF NOT EXISTS school_calendar_events (
  event_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school           public.school NOT NULL,
  school_id        UUID REFERENCES schools(school_id),
  title            VARCHAR(255) NOT NULL,
  category         VARCHAR(20) NOT NULL DEFAULT 'event'
                     CHECK (category IN ('event', 'holiday', 'pa-day', 'exam', 'other')),
  start_date       DATE NOT NULL,
  end_date         DATE,
  is_school_closed BOOLEAN NOT NULL DEFAULT false,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT end_date_after_start CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_school_date
  ON school_calendar_events(school, start_date);
