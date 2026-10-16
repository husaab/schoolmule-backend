-- ============================================================
-- Student portal, phase 2: classwork. Every gradebook leaf assessment has
-- exactly one classwork_items row (kind 'assessment' unless a teacher made
-- it an assignment/quiz), kept in step by triggers so code on main that
-- inserts or deletes assessments needs no change. Categories (is_parent)
-- are never classwork. Additive; safe to re-run.
--
-- Controller applies after review. The triggers fire for code on main as
-- soon as this commits, so the trigger function never raises on any row
-- main writes: a NULL class_id, a class_id with no class row, a NULL
-- is_parent, a category, a duplicate (ON CONFLICT) all fall through quietly.
-- The backfill runs after the triggers are created, inside the same
-- transaction (CREATE TRIGGER holds a lock on assessments until COMMIT), so
-- no assessment can be inserted between the two without its row.
-- lock_timeout: if a long-running query holds assessments, fail fast (and
-- retry) rather than queue every gradebook request behind this migration.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS classwork_topics (
  topic_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_classwork_topics_class ON classwork_topics(class_id, sort_order);
ALTER TABLE classwork_topics ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS classwork_items (
  item_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id         UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  topic_id         UUID REFERENCES classwork_topics(topic_id) ON DELETE SET NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('assessment', 'assignment', 'quiz', 'material')),
  title            TEXT,            -- unlinked items only; a linked item's name is assessments.name
  instructions     TEXT,
  due_at           TIMESTAMPTZ,
  submission_mode  TEXT NOT NULL DEFAULT 'none' CHECK (submission_mode IN ('file', 'text', 'done', 'none')),
  assessment_id    UUID REFERENCES assessments(assessment_id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'scheduled', 'posted')),
  publish_at       TIMESTAMPTZ,
  posted_at        TIMESTAMPTZ,
  show_early       BOOLEAN NOT NULL DEFAULT FALSE,   -- plain assessments: visible before their date
  email_students   BOOLEAN NOT NULL DEFAULT TRUE,
  remind_students  BOOLEAN NOT NULL DEFAULT TRUE,
  audience         TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'some')),
  sort_order       INT NOT NULL DEFAULT 0,
  created_by       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at        TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT chk_classwork_scheduled CHECK (status <> 'scheduled' OR publish_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_classwork_items_assessment ON classwork_items(assessment_id) WHERE assessment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_classwork_items_class ON classwork_items(class_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classwork_items_due ON classwork_items(due_at) WHERE deleted_at IS NULL AND due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_classwork_items_publish ON classwork_items(publish_at) WHERE status = 'scheduled';
ALTER TABLE classwork_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS classwork_item_students (
  item_id     UUID NOT NULL REFERENCES classwork_items(item_id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_classwork_item_students_student ON classwork_item_students(student_id);
ALTER TABLE classwork_item_students ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS classwork_attachments (
  attachment_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        UUID NOT NULL REFERENCES classwork_items(item_id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('file', 'link')),
  file_path      TEXT,          -- bucket message-attachments, <SCHOOL>/classwork/<item_id>/<uuid><ext>
  file_name      TEXT,
  mime_type      TEXT,
  size_bytes     INT,
  url            TEXT,
  title          TEXT,
  sort_order     INT NOT NULL DEFAULT 0,
  created_by     UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_classwork_attachment_kind CHECK ((kind = 'file' AND file_path IS NOT NULL) OR (kind = 'link' AND url IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_classwork_attachments_item ON classwork_attachments(item_id, sort_order);
ALTER TABLE classwork_attachments ENABLE ROW LEVEL SECURITY;

-- One function for the three triggers. Each branch is at most two indexed
-- writes on classwork_items (by the partial unique index on assessment_id);
-- nothing in it can raise on a row main writes.
CREATE OR REPLACE FUNCTION classwork_sync_assessment_item() RETURNS trigger
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A turn-in item keeps its row: it takes the column's name (a linked
    -- item stores no title of its own), then the foreign key drops the link
    -- (assessment_id ON DELETE SET NULL). A plain assessment's row goes.
    UPDATE classwork_items SET title = COALESCE(NULLIF(OLD.name, ''), 'Untitled')
     WHERE assessment_id = OLD.assessment_id AND kind <> 'assessment' AND title IS NULL;
    DELETE FROM classwork_items WHERE assessment_id = OLD.assessment_id AND kind = 'assessment';
    RETURN OLD;
  END IF;
  IF COALESCE(NEW.is_parent, FALSE) THEN
    -- A brand-new category has no row to remove.
    IF TG_OP = 'UPDATE' THEN
      DELETE FROM classwork_items WHERE assessment_id = NEW.assessment_id AND kind = 'assessment';
      -- A turn-in item whose column became a category is no longer graded;
      -- it keeps the column's name.
      UPDATE classwork_items
         SET assessment_id = NULL, title = COALESCE(title, NULLIF(NEW.name, ''), 'Untitled'), edited_at = NOW()
       WHERE assessment_id = NEW.assessment_id;
    END IF;
  ELSIF NEW.class_id IS NOT NULL AND EXISTS (SELECT 1 FROM classes c WHERE c.class_id = NEW.class_id) THEN
    INSERT INTO classwork_items (class_id, kind, assessment_id, status, posted_at, submission_mode)
    VALUES (NEW.class_id, 'assessment', NEW.assessment_id, 'posted', NOW(), 'none')
    ON CONFLICT (assessment_id) WHERE assessment_id IS NOT NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_classwork_item_insert ON assessments;
CREATE TRIGGER trg_classwork_item_insert AFTER INSERT ON assessments
  FOR EACH ROW EXECUTE FUNCTION classwork_sync_assessment_item();
DROP TRIGGER IF EXISTS trg_classwork_item_is_parent ON assessments;
CREATE TRIGGER trg_classwork_item_is_parent AFTER UPDATE OF is_parent ON assessments
  FOR EACH ROW WHEN (OLD.is_parent IS DISTINCT FROM NEW.is_parent) EXECUTE FUNCTION classwork_sync_assessment_item();
DROP TRIGGER IF EXISTS trg_classwork_item_delete ON assessments;
CREATE TRIGGER trg_classwork_item_delete BEFORE DELETE ON assessments
  FOR EACH ROW EXECUTE FUNCTION classwork_sync_assessment_item();

-- Backfill: one posted, topic-less row per existing leaf assessment.
INSERT INTO classwork_items (class_id, kind, assessment_id, status, posted_at, submission_mode, created_by, created_at)
SELECT a.class_id, 'assessment', a.assessment_id, 'posted', COALESCE(a.created_at, NOW()), 'none', c.teacher_id, COALESCE(a.created_at, NOW())
FROM assessments a JOIN classes c ON c.class_id = a.class_id
WHERE COALESCE(a.is_parent, FALSE) = FALSE
ON CONFLICT (assessment_id) WHERE assessment_id IS NOT NULL DO NOTHING;

COMMIT;
