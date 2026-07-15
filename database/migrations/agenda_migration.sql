-- Agenda Editor Feature Migration
-- Run this migration against your Supabase PostgreSQL database
-- Requires: school_calendar_migration.sql (Days to Remember pull from school_calendar_events)
-- Also create a private storage bucket named 'agendas' in Supabase.

CREATE TABLE IF NOT EXISTS agendas (
  agenda_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school               public.school NOT NULL,
  school_id            UUID REFERENCES schools(school_id),
  academic_year        VARCHAR(9) NOT NULL,
  title                VARCHAR(255) NOT NULL DEFAULT 'Student Agenda',
  start_month          SMALLINT NOT NULL DEFAULT 9 CHECK (start_month BETWEEN 1 AND 12),
  end_month            SMALLINT NOT NULL DEFAULT 6 CHECK (end_month BETWEEN 1 AND 12),
  footer_text          TEXT,
  include_notes_page   BOOLEAN NOT NULL DEFAULT true,
  evaluation_subjects  JSONB NOT NULL DEFAULT '[]'::jsonb,
  status               VARCHAR(20) NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'generating', 'generated', 'failed')),
  generated_file_path  TEXT,
  generated_page_count INTEGER,
  generated_at         TIMESTAMPTZ,
  generation_error     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, academic_year)
);

CREATE INDEX IF NOT EXISTS idx_agendas_school ON agendas(school);

CREATE TABLE IF NOT EXISTS agenda_months (
  agenda_month_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agenda_id       UUID NOT NULL REFERENCES agendas(agenda_id) ON DELETE CASCADE,
  month           SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  quotes          JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agenda_id, month)
);

CREATE TABLE IF NOT EXISTS agenda_custom_pages (
  page_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agenda_id    UUID NOT NULL REFERENCES agendas(agenda_id) ON DELETE CASCADE,
  anchor       VARCHAR(10) NOT NULL CHECK (anchor IN ('intro', 'month', 'closing')),
  anchor_month SMALLINT CHECK (anchor_month BETWEEN 1 AND 12),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  title        VARCHAR(255),
  file_path    TEXT NOT NULL,
  file_type    VARCHAR(10) NOT NULL CHECK (file_type IN ('pdf', 'image')),
  mime_type    VARCHAR(100),
  page_count   INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT anchor_month_required CHECK (anchor <> 'month' OR anchor_month IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_agenda_custom_pages_agenda
  ON agenda_custom_pages(agenda_id, anchor, anchor_month, sort_order);

-- Image placement on the Letter page: 'contain' fits the whole image
-- (white margins if aspect differs), 'cover' fills the page edge-to-edge
-- (crops overflow). Ignored for PDFs, which are copied at their own size.
ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS fit_mode VARCHAR(10) NOT NULL DEFAULT 'contain'
  CHECK (fit_mode IN ('contain', 'cover'));

-- Manual image placement, composed on top of the fit_mode baseline:
-- zoom multiplies the base scale (1 = exact fit); offsets shift the image
-- from center as fractions of the page size (+x right, +y down).
ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS zoom NUMERIC(5,3) NOT NULL DEFAULT 1
  CHECK (zoom >= 0.2 AND zoom <= 4);
ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS offset_x NUMERIC(6,4) NOT NULL DEFAULT 0
  CHECK (offset_x >= -1 AND offset_x <= 1);
ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS offset_y NUMERIC(6,4) NOT NULL DEFAULT 0
  CHECK (offset_y >= -1 AND offset_y <= 1);

-- Independent vertical scale for stretch-resizing (side handles).
-- NULL = uniform (follows zoom), preserving aspect ratio.
ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS zoom_y NUMERIC(5,3)
  CHECK (zoom_y IS NULL OR (zoom_y >= 0.2 AND zoom_y <= 4));

-- Per-agenda template theme, e.g. {"background": "#f5ecd9"}.
-- Shading tones on generated pages are derived from the background.
ALTER TABLE agendas
  ADD COLUMN IF NOT EXISTS theme JSONB NOT NULL DEFAULT '{}'::jsonb;
