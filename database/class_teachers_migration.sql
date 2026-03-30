-- ============================================================
-- Multi-Teacher Class Assignment - Database Migration
-- Adds class_teachers join table for additional teacher assignments.
-- The primary teacher remains on classes.teacher_id.
-- Run this in Supabase SQL Editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.class_teachers (
  class_id   UUID NOT NULL REFERENCES public.classes(class_id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (class_id, teacher_id)
);

-- Reverse lookup: "which classes does this teacher co-teach?"
CREATE INDEX IF NOT EXISTS idx_class_teachers_teacher_id
  ON public.class_teachers (teacher_id);

-- Forward lookup: "which additional teachers does this class have?"
CREATE INDEX IF NOT EXISTS idx_class_teachers_class_id
  ON public.class_teachers (class_id);
