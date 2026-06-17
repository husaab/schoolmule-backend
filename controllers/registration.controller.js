const db = require('../config/database');
const registrationQueries = require('../queries/registration.queries');
const logger = require('../logger');
const supabase = require('../config/supabaseClient');
const multer = require('multer');
const path = require('path');
const ExcelJS = require('exceljs');

// ─── Helpers ──────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function toCamelForm(row) {
  return {
    formId: row.form_id,
    school: row.school,
    title: row.title,
    slug: row.slug,
    description: row.description,
    bannerImagePath: row.banner_image_path,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    closedAt: row.closed_at,
    newSubmissionsCount: parseInt(row.new_submissions_count || '0', 10),
    fields: row.fields || [],
  };
}

function toCamelSubmission(row) {
  return {
    submissionId: row.submission_id,
    formId: row.form_id,
    school: row.school,
    answers: row.answers,
    submittedAt: row.submitted_at,
    ipAddress: row.ip_address,
    status: row.status,
  };
}

// ─── Sorting Helpers ──────────────────────────────────────────────────
// Submissions store answers as JSONB keyed by field UUIDs. Sorting must
// happen at the DB level because the data is paginated. For radio fields
// (e.g. Grade) we want natural order using the field's own options array,
// not alphabetical (which would put "Grade 10" before "Grade 2").

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Builds a single ORDER BY fragment for one field.
// Mutates `params` to append any new bind values; returns the SQL fragment.
function buildFieldSortClause(field, dir, params) {
  if (!UUID_REGEX.test(field.field_id)) {
    throw new Error('Invalid field_id format'); // should never happen — defensive
  }
  const direction = dir === 'desc' ? 'DESC' : 'ASC';

  if ((field.field_type === 'radio' || field.field_type === 'select') && Array.isArray(field.options) && field.options.length > 0) {
    // Natural sort using the form's option order
    params.push(field.options);
    return `array_position($${params.length}::text[], answers->>'${field.field_id}') ${direction} NULLS LAST`;
  }

  // Plain text comparison (works for text/email/phone/textarea/date)
  return `LOWER(answers->>'${field.field_id}') ${direction} NULLS LAST`;
}

// Heuristic: identify the "Grade" and "Name" fields for default CSV sort
function findGradeField(fields) {
  return fields.find(f =>
    (f.field_type === 'radio' || f.field_type === 'select') &&
    /grade|kindergarten/i.test(f.label || '')
  ) || null;
}

function findStudentNameField(fields) {
  return fields.find(f => /name of student/i.test(f.label || '')) || null;
}

// Builds the ORDER BY clause for submissions queries from an ordered list of
// sort specs (priority order). Each spec is { fieldId, dir } where fieldId is a
// field UUID or the special string 'submittedAt'.
// - useExportDefault: if true and no sorts given, sort by Grade ASC, Name ASC
// Returns { clause: string, params: array }
function buildSubmissionsSort(fields, sorts, useExportDefault) {
  const params = [];
  const list = Array.isArray(sorts) ? sorts : [];
  const fragments = [];
  let hasSubmittedAt = false;

  for (const s of list) {
    if (s.fieldId === 'submittedAt') {
      fragments.push(`submitted_at ${s.dir === 'asc' ? 'ASC' : 'DESC'}`);
      hasSubmittedAt = true;
      continue;
    }
    const field = fields.find(f => f.field_id === s.fieldId);
    if (field) {
      fragments.push(buildFieldSortClause(field, s.dir, params));
    }
  }

  if (fragments.length > 0) {
    // Append a stable secondary sort unless the user already sorts by date.
    const clause = hasSubmittedAt ? fragments.join(', ') : `${fragments.join(', ')}, submitted_at DESC`;
    return { clause, params };
  }

  if (useExportDefault) {
    const defFragments = [];
    const grade = findGradeField(fields);
    const name = findStudentNameField(fields);
    if (grade) defFragments.push(buildFieldSortClause(grade, 'asc', params));
    if (name) defFragments.push(buildFieldSortClause(name, 'asc', params));
    if (defFragments.length > 0) {
      return { clause: `${defFragments.join(', ')}, submitted_at DESC`, params };
    }
  }

  return { clause: 'submitted_at DESC', params };
}

// ─── Filter Helpers ─────────────────────────────────────────────────────
// Submissions are filtered by status, submission date range, and arbitrary
// per-field answer values. Field-value filters match against the JSONB answers
// keyed by field UUID. Choice fields match exactly (any of the selected values);
// text-ish fields match by case-insensitive "contains".

// Parse the multi-sort `sort` query param ("fieldId:dir,fieldId:dir"), falling
// back to the legacy single `sortFieldId`/`sortDir` params.
function parseSorts(query) {
  if (query.sort) {
    return String(query.sort)
      .split(',')
      .map(pair => {
        const [fieldId, dir] = pair.split(':');
        return { fieldId: (fieldId || '').trim(), dir: dir === 'desc' ? 'desc' : 'asc' };
      })
      .filter(s => s.fieldId);
  }
  if (query.sortFieldId) {
    return [{ fieldId: query.sortFieldId, dir: query.sortDir === 'desc' ? 'desc' : 'asc' }];
  }
  return [];
}

// Parse the `fieldFilters` query param (URL-encoded JSON array of
// { fieldId, values }). Returns [] on any malformed input.
function parseFieldFilters(query) {
  if (!query.fieldFilters) return [];
  try {
    const parsed = JSON.parse(query.fieldFilters);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(f => f && typeof f.fieldId === 'string' && Array.isArray(f.values))
      .map(f => ({ fieldId: f.fieldId, values: f.values.map(v => String(v)) }));
  } catch {
    return [];
  }
}

// Builds the WHERE body (excluding the leading "WHERE") for submissions queries.
// form_id is always bound to $1 by the caller; this returns the remaining bind
// values in order ($2, $3, ...). Used by the list, count, and export queries so
// they stay consistent. Invalid/unknown field filters are silently skipped.
function buildSubmissionsWhere(fields, { status, dateFrom, dateTo, fieldFilters }) {
  const params = [];
  const conds = ['form_id = $1'];
  let idx = 1; // $1 = form_id (supplied by caller)

  idx++; params.push(status || null);
  conds.push(`($${idx}::varchar IS NULL OR status = $${idx})`);

  idx++; params.push(dateFrom || null);
  conds.push(`($${idx}::timestamptz IS NULL OR submitted_at >= $${idx})`);

  idx++; params.push(dateTo || null);
  conds.push(`($${idx}::timestamptz IS NULL OR submitted_at <= $${idx})`);

  const fieldMap = new Map(fields.map(f => [f.field_id, f]));
  for (const ff of (fieldFilters || [])) {
    const field = fieldMap.get(ff.fieldId);
    if (!field || !UUID_REGEX.test(ff.fieldId)) continue; // skip unknown/malformed
    const values = (Array.isArray(ff.values) ? ff.values : [])
      .map(v => String(v))
      .filter(v => v !== '');
    if (values.length === 0) continue;

    if (field.field_type === 'select' || field.field_type === 'radio') {
      idx++; params.push(values);
      conds.push(`answers->>'${field.field_id}' = ANY($${idx}::text[])`);
    } else {
      const ors = values.map(v => {
        idx++; params.push(`%${v}%`);
        return `answers->>'${field.field_id}' ILIKE $${idx}`;
      });
      conds.push(`(${ors.join(' OR ')})`);
    }
  }

  return { clause: conds.join('\n        AND '), params };
}

// Multer config for banner upload
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
  },
});

// ─── Forms CRUD ───────────────────────────────────────────────────────

const getForms = async (req, res) => {
  try {
    const school = req.user.school;
    const { rows } = await db.query(registrationQueries.selectFormsBySchool, [school]);
    return res.status(200).json({
      status: 'success',
      data: rows.map(toCamelForm),
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching registration forms');
    return res.status(500).json({ status: 'failed', message: 'Error fetching forms' });
  }
};

const getForm = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;
    const { rows } = await db.query(registrationQueries.selectFormWithFields, [formId, school]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found' });
    }
    return res.status(200).json({ status: 'success', data: toCamelForm(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching registration form');
    return res.status(500).json({ status: 'failed', message: 'Error fetching form' });
  }
};

const createForm = async (req, res) => {
  try {
    const school = req.user.school;
    const userId = req.user.userId;
    const { title, description } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ status: 'failed', message: 'Title is required' });
    }

    // Generate slug and ensure uniqueness
    let slug = slugify(title);
    const nilUUID = '00000000-0000-0000-0000-000000000000';
    const { rows: existing } = await db.query(registrationQueries.checkSlugExists, [school, slug, nilUUID]);
    if (existing.length > 0) {
      slug = `${slug}-${Date.now()}`;
    }

    const { rows } = await db.query(registrationQueries.insertForm, [
      school, title.trim(), slug, description || null, userId,
    ]);

    return res.status(201).json({ status: 'success', data: toCamelForm(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error creating registration form');
    return res.status(500).json({ status: 'failed', message: 'Error creating form' });
  }
};

const updateForm = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;
    const { title, description, slug: customSlug } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ status: 'failed', message: 'Title is required' });
    }

    // Use custom slug if provided, otherwise generate from title
    let slug = customSlug ? slugify(customSlug) : slugify(title);
    if (!slug) {
      return res.status(400).json({ status: 'failed', message: 'Slug cannot be empty' });
    }

    // Ensure uniqueness (excluding current form)
    const { rows: existing } = await db.query(registrationQueries.checkSlugExists, [school, slug, formId]);
    if (existing.length > 0) {
      return res.status(409).json({ status: 'failed', message: `The URL slug "${slug}" is already in use by another form` });
    }

    const { rows } = await db.query(registrationQueries.updateForm, [
      title.trim(), slug, description || null, formId, school,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found' });
    }

    return res.status(200).json({ status: 'success', data: toCamelForm(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error updating registration form');
    return res.status(500).json({ status: 'failed', message: 'Error updating form' });
  }
};

const updateFormStatus = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;
    const { status: newStatus } = req.body;

    const validStatuses = ['draft', 'published', 'closed'];
    if (!validStatuses.includes(newStatus)) {
      return res.status(400).json({ status: 'failed', message: 'Invalid status' });
    }

    // Check current form exists (use a simple query to avoid subquery issues)
    const { rows: current } = await db.query(
      'SELECT form_id, status FROM registration_forms WHERE form_id = $1 AND school = $2',
      [formId, school]
    );
    if (current.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found' });
    }

    // Enforce valid transitions
    const currentStatus = current[0].status;
    const validTransitions = {
      draft: ['published'],
      published: ['closed'],
      closed: ['draft'],
    };

    if (!validTransitions[currentStatus]?.includes(newStatus)) {
      return res.status(400).json({
        status: 'failed',
        message: `Cannot change status from '${currentStatus}' to '${newStatus}'`,
      });
    }

    const { rows } = await db.query(registrationQueries.updateFormStatus, [newStatus, formId, school, newStatus, newStatus]);
    if (rows.length === 0) {
      return res.status(500).json({ status: 'failed', message: 'Status update failed unexpectedly' });
    }

    return res.status(200).json({ status: 'success', data: toCamelForm(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error updating form status');
    return res.status(500).json({ status: 'failed', message: error.message || 'Error updating form status' });
  }
};

const deleteForm = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;

    const { rows } = await db.query(registrationQueries.deleteForm, [formId, school]);
    if (rows.length === 0) {
      return res.status(400).json({
        status: 'failed',
        message: 'Form not found or cannot delete (only draft forms can be deleted)',
      });
    }

    // Clean up banner image from storage if it exists
    if (rows[0].banner_image_path) {
      await supabase.storage.from('registration-forms').remove([rows[0].banner_image_path]);
    }

    return res.status(200).json({ status: 'success', message: 'Form deleted successfully' });
  } catch (error) {
    logger.error({ err: error }, 'Error deleting registration form');
    return res.status(500).json({ status: 'failed', message: 'Error deleting form' });
  }
};

// ─── Banner Upload ──────────────────────────────────────────────────

const uploadBanner = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ status: 'failed', message: 'No file provided' });
    }

    // Verify form exists and belongs to this school
    const { rows: formRows } = await db.query(registrationQueries.selectFormById, [formId, school]);
    if (formRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found' });
    }

    // Delete old banner if exists
    if (formRows[0].banner_image_path) {
      await supabase.storage.from('registration-forms').remove([formRows[0].banner_image_path]);
    }

    const schoolFolder = school.replace(/\s+/g, '').toUpperCase();
    const ext = path.extname(file.originalname);
    const fileName = `${schoolFolder}/${formId}/banner${ext}`;

    const { error } = await supabase.storage
      .from('registration-forms')
      .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: true });

    if (error) {
      logger.error({ err: error }, 'Supabase banner upload error');
      throw new Error('Upload to storage failed');
    }

    const { rows } = await db.query(registrationQueries.updateFormBanner, [fileName, formId, school]);
    return res.status(200).json({
      status: 'success',
      message: 'Banner uploaded successfully',
      data: toCamelForm(rows[0]),
    });
  } catch (error) {
    logger.error({ err: error }, 'Error uploading banner');
    return res.status(500).json({ status: 'failed', message: 'Error uploading banner' });
  }
};

const deleteBanner = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;

    const { rows: formRows } = await db.query(registrationQueries.selectFormById, [formId, school]);
    if (formRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found' });
    }

    if (formRows[0].banner_image_path) {
      await supabase.storage.from('registration-forms').remove([formRows[0].banner_image_path]);
    }

    const { rows } = await db.query(registrationQueries.updateFormBanner, [null, formId, school]);
    return res.status(200).json({ status: 'success', data: toCamelForm(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error deleting banner');
    return res.status(500).json({ status: 'failed', message: 'Error deleting banner' });
  }
};

// ─── Fields Bulk Upsert ─────────────────────────────────────────────

const upsertFields = async (req, res) => {
  const client = await db.connect();
  try {
    const { formId } = req.params;
    const school = req.user.school;
    const { fields } = req.body;

    if (!Array.isArray(fields)) {
      return res.status(400).json({ status: 'failed', message: 'Fields must be an array' });
    }

    // Verify form exists and belongs to this school
    const { rows: formRows } = await client.query(registrationQueries.selectFormById, [formId, school]);
    if (formRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found' });
    }

    await client.query('BEGIN');

    // Fetch existing field IDs so we know which to update vs insert
    const { rows: existingFields } = await client.query(registrationQueries.selectFieldsByFormId, [formId]);
    const existingIds = new Set(existingFields.map(f => f.field_id));

    const validTypes = ['text', 'email', 'phone', 'date', 'select', 'radio', 'textarea'];
    const incomingIds = new Set();

    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f.fieldType || !validTypes.includes(f.fieldType)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'failed', message: `Invalid field type: ${f.fieldType}` });
      }
      if (!f.label || !f.label.trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'failed', message: 'Field label is required' });
      }

      if (f.fieldId && existingIds.has(f.fieldId)) {
        // Update existing field — preserves the UUID
        await client.query(registrationQueries.updateField, [
          f.fieldType,
          f.label.trim(),
          f.placeholder || null,
          f.isRequired || false,
          f.options ? JSON.stringify(f.options) : null,
          i,
          f.fieldId,
          formId,
        ]);
        incomingIds.add(f.fieldId);
      } else {
        // Insert new field — gets a new UUID
        await client.query(registrationQueries.insertField, [
          formId,
          f.fieldType,
          f.label.trim(),
          f.placeholder || null,
          f.isRequired || false,
          f.options ? JSON.stringify(f.options) : null,
          i,
        ]);
      }
    }

    // Delete fields that were removed by the admin
    const removedIds = existingFields
      .map(f => f.field_id)
      .filter(id => !incomingIds.has(id));
    if (removedIds.length > 0) {
      await client.query(registrationQueries.deleteFieldsByIds, [formId, removedIds]);
    }

    await client.query('COMMIT');

    // Return updated fields
    const { rows: updatedFields } = await client.query(registrationQueries.selectFieldsByFormId, [formId]);
    return res.status(200).json({
      status: 'success',
      data: updatedFields.map(ff => ({
        fieldId: ff.field_id,
        fieldType: ff.field_type,
        label: ff.label,
        placeholder: ff.placeholder,
        isRequired: ff.is_required,
        options: ff.options,
        sortOrder: ff.sort_order,
      })),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ err: error }, 'Error upserting fields');
    return res.status(500).json({ status: 'failed', message: 'Error saving fields' });
  } finally {
    client.release();
  }
};

// ─── Submissions ────────────────────────────────────────────────────

const getSubmissions = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;
    const {
      status: filterStatus,
      dateFrom,
      dateTo,
      page = 1,
      limit = 25,
    } = req.query;
    const sorts = parseSorts(req.query);
    const fieldFilters = parseFieldFilters(req.query);

    // Verify form belongs to school
    const { rows: formRows } = await db.query(registrationQueries.selectFormById, [formId, school]);
    if (formRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found' });
    }

    // Load the form's fields so we can validate sortFieldId and look up
    // the field type/options for natural ordering.
    const { rows: fields } = await db.query(registrationQueries.selectFieldsByFormId, [formId]);

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    // Build dynamic WHERE (form_id = $1, then filter params) and ORDER BY.
    const { clause: whereClause, params: whereParams } = buildSubmissionsWhere(fields, {
      status: filterStatus,
      dateFrom,
      dateTo,
      fieldFilters,
    });
    const { clause: orderClause, params: orderParams } = buildSubmissionsSort(fields, sorts, false);

    // Final param order: [formId, ...whereParams, ...orderParams, limit, offset].
    // buildSubmissionsSort placed its params at $1, $2, ... — shift them past
    // form_id ($1) plus the where params.
    const shift = 1 + whereParams.length;
    const shiftedOrderClause = orderClause.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n, 10) + shift}`);

    const limitIdx = shift + orderParams.length + 1;
    const offsetIdx = limitIdx + 1;

    const sql = `
      SELECT * FROM registration_form_submissions
      WHERE ${whereClause}
      ORDER BY ${shiftedOrderClause}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const { rows } = await db.query(sql, [
      formId,
      ...whereParams,
      ...orderParams,
      parseInt(limit, 10),
      offset,
    ]);

    // Count uses the same WHERE so pagination.total reflects field filters.
    const countSql = `SELECT COUNT(*) FROM registration_form_submissions WHERE ${whereClause}`;
    const { rows: countRows } = await db.query(countSql, [formId, ...whereParams]);

    return res.status(200).json({
      status: 'success',
      data: rows.map(toCamelSubmission),
      pagination: {
        total: parseInt(countRows[0].count, 10),
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching submissions');
    return res.status(500).json({ status: 'failed', message: 'Error fetching submissions' });
  }
};

const getSubmission = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { rows } = await db.query(registrationQueries.selectSubmissionById, [submissionId]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Submission not found' });
    }
    return res.status(200).json({ status: 'success', data: toCamelSubmission(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching submission');
    return res.status(500).json({ status: 'failed', message: 'Error fetching submission' });
  }
};

const updateSubmission = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { status } = req.body;
    const validStatuses = ['new', 'reviewed', 'archived'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ status: 'failed', message: 'Invalid status' });
    }
    const { rows } = await db.query(registrationQueries.updateSubmissionStatus, [status, submissionId]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Submission not found' });
    }
    return res.status(200).json({ status: 'success', data: toCamelSubmission(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error updating submission');
    return res.status(500).json({ status: 'failed', message: 'Error updating submission' });
  }
};

const updateSubmissionAnswers = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { answers } = req.body;
    const school = req.user.school;

    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return res.status(400).json({ status: 'failed', message: 'Answers must be an object' });
    }

    // Look up the submission (and confirm it exists) to get its form_id.
    const { rows: subRows } = await db.query(registrationQueries.selectSubmissionById, [submissionId]);
    if (subRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Submission not found' });
    }

    // Fetch the form's fields to validate against.
    const { rows: fields } = await db.query(registrationQueries.selectFieldsByFormId, [subRows[0].form_id]);
    const fieldMap = new Map(fields.map(f => [f.field_id, f]));

    // Validate required fields, allowed options, and strip unknown keys —
    // mirrors the public submit handler in registrationPublic.controller.js.
    const missingFields = [];
    for (const field of fields) {
      if (field.is_required) {
        const answer = answers[field.field_id];
        if (answer === undefined || answer === null || String(answer).trim() === '') {
          missingFields.push(field.label);
        }
      }
    }
    if (missingFields.length > 0) {
      return res.status(400).json({
        status: 'failed',
        message: `Missing required fields: ${missingFields.join(', ')}`,
      });
    }

    const sanitizedAnswers = {};
    for (const [key, value] of Object.entries(answers)) {
      const field = fieldMap.get(key);
      if (!field) continue; // ignore unknown field IDs

      const cleaned = String(value)
        .replace(/<[^>]*>/g, '') // strip HTML tags
        .trim()
        .slice(0, 5000); // max 5000 chars per answer

      // For select/radio fields, only accept values within the field's options
      // (empty string allowed for optional fields that were cleared).
      if ((field.field_type === 'select' || field.field_type === 'radio') && cleaned !== '') {
        const options = Array.isArray(field.options) ? field.options : [];
        if (!options.includes(cleaned)) {
          return res.status(400).json({
            status: 'failed',
            message: `Invalid value for "${field.label}"`,
          });
        }
      }

      sanitizedAnswers[key] = cleaned;
    }

    const { rows } = await db.query(registrationQueries.updateSubmissionAnswers, [
      JSON.stringify(sanitizedAnswers),
      submissionId,
      school,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Submission not found' });
    }
    return res.status(200).json({ status: 'success', data: toCamelSubmission(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error updating submission answers');
    return res.status(500).json({ status: 'failed', message: 'Error updating submission answers' });
  }
};

const deleteSubmission = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { rows } = await db.query(registrationQueries.deleteSubmission, [submissionId]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Submission not found' });
    }
    return res.status(200).json({ status: 'success', message: 'Submission deleted' });
  } catch (error) {
    logger.error({ err: error }, 'Error deleting submission');
    return res.status(500).json({ status: 'failed', message: 'Error deleting submission' });
  }
};

// ─── CSV Export ─────────────────────────────────────────────────────

const exportSubmissions = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;
    const { status: filterStatus, dateFrom, dateTo } = req.query;
    const sorts = parseSorts(req.query);
    const fieldFilters = parseFieldFilters(req.query);

    // Verify form belongs to school
    const { rows: formRows } = await db.query(registrationQueries.selectFormById, [formId, school]);
    if (formRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found' });
    }

    // Get field definitions for column headers
    const { rows: fields } = await db.query(registrationQueries.selectFieldsByFormId, [formId]);

    // Build dynamic WHERE + ORDER BY (explicit sort wins; otherwise Grade ASC, Name ASC)
    const { clause: whereClause, params: whereParams } = buildSubmissionsWhere(fields, {
      status: filterStatus,
      dateFrom,
      dateTo,
      fieldFilters,
    });
    const { clause: orderClause, params: orderParams } = buildSubmissionsSort(
      fields,
      sorts,
      true, // useExportDefault — multi-column Grade+Name when no explicit sort
    );

    const shift = 1 + whereParams.length;
    const shiftedOrderClause = orderClause.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n, 10) + shift}`);

    const sql = `
      SELECT * FROM registration_form_submissions
      WHERE ${whereClause}
      ORDER BY ${shiftedOrderClause}
    `;

    const { rows: submissions } = await db.query(sql, [formId, ...whereParams, ...orderParams]);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Submissions');

    // Build headers
    const headers = ['Submission Date', 'Status'];
    fields.forEach(f => headers.push(f.label));
    sheet.addRow(headers);

    // Style header row
    sheet.getRow(1).font = { bold: true };

    // Build data rows
    submissions.forEach(sub => {
      const row = [
        new Date(sub.submitted_at).toLocaleString('en-CA', { timeZone: 'America/Toronto' }),
        sub.status,
      ];
      fields.forEach(f => {
        row.push(sub.answers[f.field_id] || '');
      });
      sheet.addRow(row);
    });

    // Auto-fit column widths
    sheet.columns.forEach(col => {
      let maxLen = 10;
      col.eachCell(cell => {
        const len = cell.value ? String(cell.value).length : 0;
        if (len > maxLen) maxLen = Math.min(len, 50);
      });
      col.width = maxLen + 2;
    });

    // Build a clean filename from the form's title:
    //   "Al Haadi Academy ... 2026-2027" → "Al_Haadi_Academy_..._2026_2027_Submissions.csv"
    const formTitle = formRows[0].title
      .replace(/[^a-zA-Z0-9]+/g, '_') // collapse runs of non-alphanumeric → single underscore
      .replace(/^_+|_+$/g, '');         // trim leading/trailing underscores
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${formTitle}_Submissions.csv"`);
    // ExcelJS closes the stream itself — don't call res.end() after.
    await workbook.csv.write(res);
  } catch (error) {
    logger.error({ err: error }, 'Error exporting submissions');
    // If streaming has already started, headers are sent — cannot send JSON error
    if (!res.headersSent) {
      return res.status(500).json({ status: 'failed', message: 'Error exporting submissions' });
    }
  }
};

// ─── New Count (for badge) ──────────────────────────────────────────

const getNewCount = async (req, res) => {
  try {
    const school = req.user.school;
    const { rows } = await db.query(registrationQueries.countNewSubmissionsBySchool, [school]);
    return res.status(200).json({
      status: 'success',
      data: { count: parseInt(rows[0].count, 10) },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching new submission count');
    return res.status(500).json({ status: 'failed', message: 'Error fetching count' });
  }
};

module.exports = {
  upload,
  getForms,
  getForm,
  createForm,
  updateForm,
  updateFormStatus,
  deleteForm,
  uploadBanner,
  deleteBanner,
  upsertFields,
  getSubmissions,
  getSubmission,
  updateSubmission,
  updateSubmissionAnswers,
  deleteSubmission,
  exportSubmissions,
  getNewCount,
};
