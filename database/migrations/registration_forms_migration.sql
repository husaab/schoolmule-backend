-- Registration Forms Feature Migration
-- Run this migration against your Supabase PostgreSQL database

-- 1. Add slug column to schools table
ALTER TABLE schools ADD COLUMN IF NOT EXISTS slug VARCHAR(100) UNIQUE;

-- Backfill existing schools with slugs derived from school_code
-- ALHAADIACADEMY -> al-haadi-academy, PLAYGROUND -> playground
UPDATE schools SET slug = 'al-haadi-academy' WHERE school_code = 'ALHAADIACADEMY' AND slug IS NULL;
UPDATE schools SET slug = 'playground' WHERE school_code = 'PLAYGROUND' AND slug IS NULL;

-- 2. Create registration_forms table
CREATE TABLE IF NOT EXISTS registration_forms (
  form_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school            public.school NOT NULL,
  title             VARCHAR(255) NOT NULL,
  slug              VARCHAR(255) NOT NULL,
  description       TEXT,
  banner_image_path TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'published', 'closed')),
  created_by        UUID NOT NULL REFERENCES users(user_id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at      TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  UNIQUE(school, slug)
);

CREATE INDEX IF NOT EXISTS idx_registration_forms_school ON registration_forms(school);
CREATE INDEX IF NOT EXISTS idx_registration_forms_school_slug ON registration_forms(school, slug);
CREATE INDEX IF NOT EXISTS idx_registration_forms_status ON registration_forms(status);

-- 3. Create registration_form_fields table
CREATE TABLE IF NOT EXISTS registration_form_fields (
  field_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id           UUID NOT NULL REFERENCES registration_forms(form_id) ON DELETE CASCADE,
  field_type        VARCHAR(20) NOT NULL
                      CHECK (field_type IN ('text', 'email', 'phone', 'date', 'select', 'radio', 'textarea')),
  label             VARCHAR(255) NOT NULL,
  placeholder       VARCHAR(255),
  is_required       BOOLEAN NOT NULL DEFAULT false,
  options           JSONB,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_registration_form_fields_form_id ON registration_form_fields(form_id);
CREATE INDEX IF NOT EXISTS idx_registration_form_fields_sort_order ON registration_form_fields(form_id, sort_order);

-- 4. Create registration_form_submissions table
CREATE TABLE IF NOT EXISTS registration_form_submissions (
  submission_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id           UUID NOT NULL REFERENCES registration_forms(form_id) ON DELETE CASCADE,
  school            public.school NOT NULL,
  answers           JSONB NOT NULL,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address        INET,
  status            VARCHAR(20) NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'reviewed', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_form_id ON registration_form_submissions(form_id);
CREATE INDEX IF NOT EXISTS idx_submissions_school ON registration_form_submissions(school);
CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON registration_form_submissions(submitted_at);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON registration_form_submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_form_status ON registration_form_submissions(form_id, status);
