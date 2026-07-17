-- Applied to production 2026-07-17 (after school_years_migration.sql).
-- 1) Safety net for pre-scoping deployed code: rows inserted without
--    school_year_id get the school's active year via BEFORE INSERT trigger.
-- 2) Planner uniqueness becomes per-year so rollover can copy config.
BEGIN;

CREATE OR REPLACE FUNCTION set_default_school_year_id()
RETURNS trigger AS $$
BEGIN
  IF NEW.school_year_id IS NULL THEN
    SELECT sy.school_year_id INTO NEW.school_year_id
    FROM school_years sy
    WHERE sy.school = NEW.school AND sy.is_active = TRUE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'students','classes','terms','school_calendar_events',
    'planner_settings','planner_teachers','planner_rooms','planner_class_groups',
    'planner_courses','planner_day_templates','planner_fixed_blocks',
    'planner_schedules','planner_schedule_sessions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_default_school_year ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_default_school_year BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION set_default_school_year_id()', t);
  END LOOP;
END $$;

-- One published schedule per (school, year) instead of per school.
DROP INDEX IF EXISTS uniq_planner_published_per_school;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_planner_published_per_school_year
  ON planner_schedules(school, school_year_id) WHERE status = 'published';

-- Planner config uniqueness becomes per-year so a new year can carry
-- same-named copies of rooms/groups/teachers/day templates.
ALTER TABLE planner_rooms DROP CONSTRAINT IF EXISTS planner_rooms_school_name_key;
ALTER TABLE planner_rooms ADD CONSTRAINT planner_rooms_school_year_name_key UNIQUE (school, school_year_id, name);

ALTER TABLE planner_class_groups DROP CONSTRAINT IF EXISTS planner_class_groups_school_name_key;
ALTER TABLE planner_class_groups ADD CONSTRAINT planner_class_groups_school_year_name_key UNIQUE (school, school_year_id, name);

ALTER TABLE planner_teachers DROP CONSTRAINT IF EXISTS planner_teachers_school_display_name_key;
ALTER TABLE planner_teachers ADD CONSTRAINT planner_teachers_school_year_display_name_key UNIQUE (school, school_year_id, display_name);

ALTER TABLE planner_day_templates DROP CONSTRAINT IF EXISTS planner_day_templates_school_day_of_week_key;
ALTER TABLE planner_day_templates ADD CONSTRAINT planner_day_templates_school_year_day_of_week_key UNIQUE (school, school_year_id, day_of_week);

COMMIT;
