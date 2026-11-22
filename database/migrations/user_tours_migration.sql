-- ============================================================
-- Guided tours: per-person progress through in-app walkthroughs.
--
-- Tours themselves live in code (schoolmule/src/lib/tours/catalog, copied to
-- the app), so the server only keeps what each person did with each tour id.
-- The client sends events (POST /api/tours/:tourId/event); the server works
-- out the progress row from them (services/tours/tourProgress.js), so the web
-- and the app always agree on who has finished what.
--
--   user_tour_progress  one row per person per tour: where they are (step_id
--                       too: the web and the app show different steps, so
--                       resuming on the other one goes by the step's id).
--   user_tour_events    append-only log, so a tour's drop-off by step can be
--                       counted (the progress row only keeps the latest step).
--
-- patch_notes.tour_id lets a What's New entry carry a "Take the tour" button.
-- Additive only. Safe to re-run: all DDL uses IF NOT EXISTS.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_tour_progress (
  user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  tour_id          TEXT NOT NULL,
  version          INT  NOT NULL DEFAULT 1,
  status           TEXT NOT NULL CHECK (status IN ('offered','in_progress','completed','dismissed')),
  step_index       INT  NOT NULL DEFAULT 0,
  step_id          TEXT,
  snoozed_until    TIMESTAMPTZ,
  first_offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, tour_id)
);
ALTER TABLE user_tour_progress ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS user_tour_events (
  event_id    BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  tour_id     TEXT NOT NULL,
  version     INT  NOT NULL DEFAULT 1,
  event       TEXT NOT NULL CHECK (event IN ('offered','started','step','paused','resumed','completed','dismissed','snoozed')),
  step_id     TEXT,
  step_index  INT,
  role        TEXT,
  platform    TEXT CHECK (platform IN ('web','app')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_tour_events_tour ON user_tour_events(tour_id, event, step_index);
CREATE INDEX IF NOT EXISTS idx_user_tour_events_user ON user_tour_events(user_id);
ALTER TABLE user_tour_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE patch_notes ADD COLUMN IF NOT EXISTS tour_id TEXT;

COMMIT;
