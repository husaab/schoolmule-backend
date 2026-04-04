const db = require('../config/database');
const queries = require('../queries/registrationPublic.queries');
const logger = require('../logger');

function toCamelForm(row) {
  return {
    formId: row.form_id,
    school: row.school,
    title: row.title,
    slug: row.slug,
    description: row.description,
    bannerImagePath: row.banner_image_path,
    status: row.status,
    createdAt: row.created_at,
    fields: row.fields || [],
  };
}

/**
 * GET /api/registration/public/:schoolSlug/:formSlug
 * Fetch a published form for public rendering
 */
const getPublicForm = async (req, res) => {
  try {
    const { schoolSlug, formSlug } = req.params;

    // Resolve school by slug
    const { rows: schoolRows } = await db.query(queries.selectSchoolBySlug, [schoolSlug]);
    if (schoolRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'School not found' });
    }

    const schoolCode = schoolRows[0].school_code;
    const schoolName = schoolRows[0].name;

    // Fetch published form with fields
    const { rows: formRows } = await db.query(queries.selectPublishedForm, [schoolCode, formSlug]);
    if (formRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found or not published' });
    }

    const form = toCamelForm(formRows[0]);

    // Build banner image URL if it exists
    let bannerImageUrl = null;
    if (form.bannerImagePath) {
      const supabaseUrl = process.env.SUPABASE_URL;
      bannerImageUrl = `${supabaseUrl}/storage/v1/object/public/registration-forms/${form.bannerImagePath}`;
    }

    return res.status(200).json({
      status: 'success',
      data: {
        ...form,
        bannerImageUrl,
        schoolName,
        schoolSlug,
      },
    });
  } catch (error) {
    logger.error('Error fetching public form:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching form' });
  }
};

/**
 * POST /api/registration/public/:schoolSlug/:formSlug/submit
 * Submit a public form
 */
const submitForm = async (req, res) => {
  try {
    const { schoolSlug, formSlug } = req.params;
    const { answers } = req.body;

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ status: 'failed', message: 'Answers are required' });
    }

    // Resolve school
    const { rows: schoolRows } = await db.query(queries.selectSchoolBySlug, [schoolSlug]);
    if (schoolRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'School not found' });
    }

    const schoolCode = schoolRows[0].school_code;

    // Fetch form (check it's published)
    const { rows: formRows } = await db.query(queries.selectPublishedForm, [schoolCode, formSlug]);
    if (formRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Form not found or not accepting submissions' });
    }

    const form = formRows[0];

    // Validate required fields
    const { rows: fields } = await db.query(queries.selectFormFieldsForValidation, [form.form_id]);
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

    // Sanitize answers — only keep answers for known field IDs, strip HTML, trim
    const fieldIds = new Set(fields.map(f => f.field_id));
    const sanitizedAnswers = {};
    for (const [key, value] of Object.entries(answers)) {
      if (fieldIds.has(key)) {
        sanitizedAnswers[key] = String(value)
          .replace(/<[^>]*>/g, '') // strip HTML tags
          .trim()
          .slice(0, 5000); // max 5000 chars per answer
      }
    }

    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || null;

    const { rows } = await db.query(queries.insertSubmission, [
      form.form_id,
      schoolCode,
      JSON.stringify(sanitizedAnswers),
      ipAddress,
    ]);

    return res.status(201).json({
      status: 'success',
      message: 'Your submission has been received. Thank you!',
      data: { submissionId: rows[0].submission_id },
    });
  } catch (error) {
    logger.error('Error submitting form:', error);
    return res.status(500).json({ status: 'failed', message: 'Error submitting form' });
  }
};

module.exports = {
  getPublicForm,
  submitForm,
};
