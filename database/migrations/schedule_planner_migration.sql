-- Schedule Planner Feature Migration
-- Run this migration against your Supabase PostgreSQL database

-- Per-school planner defaults (one row per school)
CREATE TABLE IF NOT EXISTS planner_settings (
  planner_settings_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                   public.school NOT NULL UNIQUE,
  school_id                UUID REFERENCES schools(school_id),
  default_duration_minutes SMALLINT NOT NULL DEFAULT 40 CHECK (default_duration_minutes BETWEEN 5 AND 480),
  snap_minutes             SMALLINT NOT NULL DEFAULT 5 CHECK (snap_minutes IN (1, 5, 10, 15)),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Teacher profiles for the planner (user/staff links optional)
CREATE TABLE IF NOT EXISTS planner_teachers (
  planner_teacher_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school             public.school NOT NULL,
  school_id          UUID REFERENCES schools(school_id),
  user_id            UUID REFERENCES users(user_id) ON DELETE SET NULL,
  staff_id           UUID REFERENCES staff(staff_id) ON DELETE SET NULL,
  display_name       VARCHAR(255) NOT NULL,
  is_full_time       BOOLEAN NOT NULL DEFAULT true,
  max_weekly_minutes INTEGER CHECK (max_weekly_minutes IS NULL OR max_weekly_minutes > 0),
  allowed_days       JSONB NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
  excluded_windows   JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, display_name)
);
CREATE INDEX IF NOT EXISTS idx_planner_teachers_school ON planner_teachers(school);
CREATE INDEX IF NOT EXISTS idx_planner_teachers_user ON planner_teachers(user_id);

-- Shared rooms (gym, lab, prayer hall)
CREATE TABLE IF NOT EXISTS planner_rooms (
  room_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school        public.school NOT NULL,
  school_id     UUID REFERENCES schools(school_id),
  name          VARCHAR(255) NOT NULL,
  capacity_note VARCHAR(255),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, name)
);
CREATE INDEX IF NOT EXISTS idx_planner_rooms_school ON planner_rooms(school);

-- Homeroom cohorts being scheduled (planner-owned, not the classes table)
CREATE TABLE IF NOT EXISTS planner_class_groups (
  class_group_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school         public.school NOT NULL,
  school_id      UUID REFERENCES schools(school_id),
  name           VARCHAR(255) NOT NULL,
  grade          VARCHAR(20),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, name)
);
CREATE INDEX IF NOT EXISTS idx_planner_class_groups_school ON planner_class_groups(school);

-- Course requirements per class group
CREATE TABLE IF NOT EXISTS planner_courses (
  course_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                public.school NOT NULL,
  school_id             UUID REFERENCES schools(school_id),
  class_group_id        UUID NOT NULL REFERENCES planner_class_groups(class_group_id) ON DELETE CASCADE,
  name                  VARCHAR(255) NOT NULL,
  sessions_per_week     SMALLINT NOT NULL CHECK (sessions_per_week BETWEEN 1 AND 20),
  duration_minutes      SMALLINT CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 480),
  max_per_day           SMALLINT NOT NULL DEFAULT 1 CHECK (max_per_day BETWEEN 1 AND 20),
  assigned_teacher_id   UUID REFERENCES planner_teachers(planner_teacher_id) ON DELETE SET NULL,
  candidate_teacher_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_room_id      UUID REFERENCES planner_rooms(room_id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_courses_group ON planner_courses(class_group_id);
CREATE INDEX IF NOT EXISTS idx_planner_courses_school ON planner_courses(school);

-- Per-day fillable time ranges (minutes from midnight, ISO weekday 1=Mon)
CREATE TABLE IF NOT EXISTS planner_day_templates (
  day_template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school          public.school NOT NULL,
  school_id       UUID REFERENCES schools(school_id),
  day_of_week     SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  fillable_ranges JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, day_of_week)
);

-- Fixed blocks (lunch, prayer, recess); NULL class_group_id = school-wide
CREATE TABLE IF NOT EXISTS planner_fixed_blocks (
  fixed_block_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school         public.school NOT NULL,
  school_id      UUID REFERENCES schools(school_id),
  class_group_id UUID REFERENCES planner_class_groups(class_group_id) ON DELETE CASCADE,
  label          VARCHAR(255) NOT NULL,
  day_of_week    SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_min      SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min        SMALLINT NOT NULL CHECK (end_min > start_min AND end_min <= 1440),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_fixed_blocks_school ON planner_fixed_blocks(school, day_of_week);

-- Named schedule drafts + the one published schedule per school.
-- sessions: [{courseId, courseName, classGroupId, teacherId, roomId,
--             day, startMin, endMin, pinned}]
CREATE TABLE IF NOT EXISTS planner_schedules (
  schedule_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school          public.school NOT NULL,
  school_id       UUID REFERENCES schools(school_id),
  name            VARCHAR(255) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  sessions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  diagnostics     JSONB,
  config_snapshot JSONB,
  share_token     UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_schedules_school ON planner_schedules(school);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_planner_published_per_school
  ON planner_schedules(school) WHERE status = 'published';

-- Materialized on publish so the teacher widget and public page hit
-- indexed rows instead of scanning JSONB
CREATE TABLE IF NOT EXISTS planner_schedule_sessions (
  session_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id        UUID NOT NULL REFERENCES planner_schedules(schedule_id) ON DELETE CASCADE,
  school             public.school NOT NULL,
  school_id          UUID REFERENCES schools(school_id),
  class_group_id     UUID REFERENCES planner_class_groups(class_group_id) ON DELETE SET NULL,
  class_group_name   VARCHAR(255) NOT NULL,
  course_name        VARCHAR(255) NOT NULL,
  planner_teacher_id UUID REFERENCES planner_teachers(planner_teacher_id) ON DELETE SET NULL,
  teacher_user_id    UUID REFERENCES users(user_id) ON DELETE SET NULL,
  teacher_name       VARCHAR(255) NOT NULL,
  room_name          VARCHAR(255),
  day_of_week        SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_min          SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min            SMALLINT NOT NULL CHECK (end_min > start_min AND end_min <= 1440)
);
CREATE INDEX IF NOT EXISTS idx_pss_schedule ON planner_schedule_sessions(schedule_id);
CREATE INDEX IF NOT EXISTS idx_pss_teacher ON planner_schedule_sessions(teacher_user_id, day_of_week);
