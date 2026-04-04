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

    // Delete existing fields
    await client.query(registrationQueries.deleteFieldsByFormId, [formId]);

    // Insert new fields
    const validTypes = ['text', 'email', 'phone', 'date', 'select', 'radio', 'textarea'];
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

    await client.query('COMMIT');

    // Return updated fields
    const { rows: updatedFields } = await db.query(registrationQueries.selectFieldsByFormId, [formId]);
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
    const { status: filterStatus, dateFrom, dateTo, page = 1, limit = 25 } = req.query;

    // Verify form belongs to school
    const { rows: formRows } = await db.query(registrationQueries.selectFormById, [formId, school]);
    if (formRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found' });
    }

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const { rows } = await db.query(registrationQueries.selectSubmissionsFiltered, [
      formId,
      filterStatus || null,
      dateFrom || null,
      dateTo || null,
      parseInt(limit, 10),
      offset,
    ]);

    const { rows: countRows } = await db.query(registrationQueries.countSubmissionsFiltered, [
      formId,
      filterStatus || null,
      dateFrom || null,
      dateTo || null,
    ]);

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

// ─── CSV Export ─────────────────────────────────────────────────────

const exportSubmissions = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;
    const { status: filterStatus, dateFrom, dateTo } = req.query;

    // Verify form belongs to school
    const { rows: formRows } = await db.query(registrationQueries.selectFormById, [formId, school]);
    if (formRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found' });
    }

    // Get field definitions for column headers
    const { rows: fields } = await db.query(registrationQueries.selectFieldsByFormId, [formId]);

    // Get filtered submissions
    const { rows: submissions } = await db.query(registrationQueries.selectSubmissionsForExport, [
      formId,
      filterStatus || null,
      dateFrom || null,
      dateTo || null,
    ]);

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

    const formTitle = formRows[0].title.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${formTitle}_submissions.csv"`);
    await workbook.csv.write(res);
    res.end();
  } catch (error) {
    logger.error({ err: error }, 'Error exporting submissions');
    return res.status(500).json({ status: 'failed', message: 'Error exporting submissions' });
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
  exportSubmissions,
  getNewCount,
};
