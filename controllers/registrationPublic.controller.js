const jwt = require('jsonwebtoken');
const db = require('../config/database');
const queries = require('../queries/registrationPublic.queries');
const schoolYearQueries = require('../queries/schoolYear.queries');
const googleSheetsQueries = require('../queries/googleSheets.queries');
const logger = require('../logger');
const charges = require('../services/payments/charges');
const { priceSelection, summaryAnswer, PaymentFieldError } = require('../services/payments/paymentField');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The parent signed in on this browser, from an optional bearer token. Public
 * forms work without one; with one, a parent can say which child a response
 * is for. A preview ("view as") token or an unverified account counts as
 * nobody.
 */
function signedInParent(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (decoded.role !== 'PARENT' || !decoded.isVerified || !decoded.isVerifiedSchool || decoded.impersonator) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** The parent's children at the form's school, this year (or one of them). */
async function childrenOf(parent, schoolCode, studentId = null) {
  const { rows: [year] } = await db.query(schoolYearQueries.selectActiveYearBySchool, [schoolCode]);
  const { rows } = await db.query(queries.selectParentChildren, [parent.userId, schoolCode, year?.school_year_id ?? null, studentId]);
  return rows.map((r) => ({ studentId: r.student_id, name: r.name, grade: r.grade }));
}

/** A payment field as the public sees it: no accounting code. */
function publicField(field) {
  if (field.fieldType !== 'payment' || !field.payment) return field;
  const { accountingCode, ...payment } = field.payment;
  return { ...field, payment };
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
    form.fields = form.fields.map(publicField);
    const hasPayment = form.fields.some((f) => f.fieldType === 'payment');
    const pay = hasPayment ? await charges.availability(schoolCode) : { online: false, client: null };
    const { online } = pay;

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
        // Whether the family can pay by card right now (a payment field only).
        // testMode lets the page check its Stripe.js key is for the same mode before showing Stripe's form inside it.
        payments: hasPayment ? { online, currency: 'cad', testMode: pay.client ? !pay.client.livemode : null } : null,
      },
    });
  } catch (error) {
    logger.error('Error fetching public form:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching form' });
  }
};

/**
 * GET /api/registration/public/:schoolSlug/:formSlug/children
 * For a signed-in parent: their children at the form's school, so the form can
 * ask which child it is for. Anyone else gets { signedIn: false }.
 */
const getChildren = async (req, res) => {
  try {
    const parent = signedInParent(req);
    if (!parent) return res.status(200).json({ status: 'success', data: { signedIn: false, children: [] } });
    const { rows: schoolRows } = await db.query(queries.selectSchoolBySlug, [req.params.schoolSlug]);
    if (schoolRows.length === 0) return res.status(404).json({ status: 'failed', message: 'School not found' });
    const children = await childrenOf(parent, schoolRows[0].school_code);
    return res.status(200).json({ status: 'success', data: { signedIn: true, children } });
  } catch (error) {
    logger.error({ err: error }, 'Error loading a parent’s children for a public form');
    return res.status(500).json({ status: 'failed', message: 'Error loading your children' });
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
      if (field.is_required && field.field_type !== 'payment') {
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

    // Sanitize answers — only keep answers for known field IDs, strip HTML, trim.
    // The payment field's answer is written below from the prices, never taken as sent.
    const fieldIds = new Set(fields.filter((f) => f.field_type !== 'payment').map(f => f.field_id));
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

    // ── The child it is for (a signed-in parent only) ──
    const parent = signedInParent(req);
    let studentId = null;
    if (req.body.studentId != null && req.body.studentId !== '') {
      if (!parent) {
        return res.status(401).json({ status: 'failed', code: 'SIGN_IN_AGAIN', message: 'Sign in again to say which child this is for.' });
      }
      const mine = UUID_RE.test(String(req.body.studentId)) ? await childrenOf(parent, schoolCode, req.body.studentId) : [];
      if (mine.length === 0) {
        return res.status(403).json({ status: 'failed', message: 'That child isn’t linked to your account at this school.' });
      }
      studentId = mine[0].studentId;
    }

    // ── Payment ──
    // What is owed is worked out here from the form's own prices.
    const paymentField = fields.find((f) => f.field_type === 'payment' && f.payment_config);
    let priced = null;
    let method = null;
    let payerEmail = null;
    let pay = null;
    if (paymentField) {
      try {
        priced = priceSelection(paymentField.payment_config, req.body.payment?.itemIds);
      } catch (error) {
        if (error instanceof PaymentFieldError) return res.status(400).json({ status: 'failed', message: error.message });
        throw error;
      }
      if (priced.totalCents > 0) {
        const emailField = fields.find((f) => f.field_type === 'email' && EMAIL_RE.test(sanitizedAnswers[f.field_id] || ''));
        if (!emailField) {
          return res.status(400).json({ status: 'failed', message: 'Add your email address so the school can send your receipt.' });
        }
        payerEmail = sanitizedAnswers[emailField.field_id].toLowerCase();
        pay = await charges.availability(schoolCode);
        const allowOffline = Boolean(paymentField.payment_config.allowOffline);
        method = req.body.payment?.method === 'offline' ? 'offline' : 'card';
        if (method === 'offline' && !allowOffline) {
          return res.status(400).json({ status: 'failed', message: 'This form asks for payment online.' });
        }
        if (method === 'card' && !pay.online) {
          return res.status(409).json({
            status: 'failed',
            code: 'PAYMENTS_UNAVAILABLE',
            message: allowOffline
              ? 'Card payments aren’t available right now. Choose to pay at the office, or try again later.'
              : 'This school can’t take payments online right now. Please contact the school.',
          });
        }
      }
      sanitizedAnswers[paymentField.field_id] = summaryAnswer(priced, method);
    }

    const client = await db.connect();
    let rows;
    let charge = null;
    try {
      await client.query('BEGIN');
      ({ rows } = await client.query(queries.insertSubmission, [
        form.form_id,
        schoolCode,
        JSON.stringify(sanitizedAnswers),
        ipAddress,
        studentId,
        parent ? parent.userId : null,
      ]));
      if (priced && priced.totalCents > 0) {
        charge = await charges.createForSubmission(client, {
          school: schoolCode,
          livemode: pay.client ? pay.client.livemode : false,
          submissionId: rows[0].submission_id,
          form,
          field: paymentField,
          priced,
          method,
          payerEmail,
          studentId,
          account: pay.account,
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // Queue the sheet refresh, but never let it affect the response. A parent
    // submitting a form must not see a failure because Google is unreachable —
    // the job row is durable, so the write happens once the outbox drains.
    try {
      await db.query(googleSheetsQueries.enqueueJob, [form.form_id]);
    } catch (error) {
      logger.warn({ err: error, formId: form.form_id }, 'Could not queue sheet sync');
    }

    // A card payment goes straight on to Stripe's page. If Stripe can't open
    // one now, the response is kept and the family's link lets them retry.
    // The web pays inside its own page instead (payment.ui = 'embedded'): it
    // asks for that form itself, so no Stripe page is opened here.
    const embeddedHere = req.body.payment?.ui === 'embedded';
    let payment = null;
    if (charge) {
      payment = {
        token: charge.public_token,
        method,
        totalCents: charge.amount_cents,
        payPath: `/pay/${charge.public_token}`,
        checkoutUrl: null,
      };
      if (method === 'card' && !embeddedHere) {
        try {
          const opened = await charges.openCheckout(charge.charge_id, { client: pay.client });
          payment.checkoutUrl = opened.url;
        } catch (error) {
          logger.error({ err: error, chargeId: charge.charge_id }, 'Payments: could not open Stripe’s page for a new form response');
        }
      }
    }

    return res.status(201).json({
      status: 'success',
      message: 'Your submission has been received. Thank you!',
      data: { submissionId: rows[0].submission_id, payment },
    });
  } catch (error) {
    logger.error('Error submitting form:', error);
    return res.status(500).json({ status: 'failed', message: 'Error submitting form' });
  }
};

// ─── The family's payment link (/pay/<token>) ─────────────────────

const failPayment = (res, error, action) => {
  if (error instanceof charges.ChargeError) return res.status(error.status).json({ status: 'failed', code: error.code, message: error.message });
  logger.error({ err: error }, `Payments: error (${action})`);
  return res.status(502).json({ status: 'failed', message: 'Stripe could not complete that. Please try again in a moment.' });
};

/**
 * GET /api/registration/public/payments/:token
 * What the family owes and has paid. Coming back from Stripe (?session_id=…),
 * the payment is checked with Stripe at once rather than waiting for the
 * webhook, so the page can say "Paid" straight away.
 */
const getPayment = async (req, res) => {
  try {
    let found = await charges.publicView(req.params.token);
    if (!found) return res.status(404).json({ status: 'failed', message: 'Payment not found' });
    const sessionId = String(req.query.session_id || '');
    const owed = found.row.status === 'unpaid' || found.row.status === 'partially_paid';
    if (owed && /^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      try {
        const { client, account } = await charges.availability(found.row.school);
        if (client && account && client.livemode === found.row.livemode) {
          await charges.fulfillSession({ client, accountId: account.stripe_account_id, sessionId });
          found = await charges.publicView(req.params.token);
        }
      } catch (error) {
        // The webhook and the safety net will still record it.
        logger.warn({ err: error.message, chargeId: found.row.charge_id }, 'Payments: return-page check with Stripe failed');
      }
    }
    return res.status(200).json({ status: 'success', data: found.view });
  } catch (error) {
    return failPayment(res, error, 'load payment');
  }
};

/**
 * POST /api/registration/public/payments/:token/checkout: a Stripe payment for
 * what is still owed. { ui: 'embedded' } answers with what Stripe.js needs to
 * show the form inside our page (the client secret, on the school's account);
 * otherwise a link to Stripe's own page.
 */
const startPayment = async (req, res) => {
  try {
    const found = await charges.publicView(req.params.token);
    if (!found) return res.status(404).json({ status: 'failed', message: 'Payment not found' });
    const ui = req.body?.ui === 'embedded' ? 'embedded' : 'hosted';
    const opened = await charges.openCheckout(found.row.charge_id, { ui });
    return res.status(200).json({
      status: 'success',
      data: {
        url: opened.url,
        clientSecret: opened.clientSecret,
        stripeAccountId: opened.clientSecret ? opened.stripeAccountId : null,
        paid: !opened.url && !opened.clientSecret,
      },
    });
  } catch (error) {
    return failPayment(res, error, 'start payment');
  }
};

module.exports = {
  getPublicForm,
  getChildren,
  submitForm,
  getPayment,
  startPayment,
};
