// controllers/studentView.controller.js

const { Resend } = require('resend');
const db = require('../config/database');
const ExcelJS = require('exceljs');
const logger = require('../logger');
const q = require('../queries/studentView.queries');
const studentViewEmailsQueries = require('../queries/studentViewEmails.queries');
const schoolQueries = require('../queries/school.queries');
const { evaluateView } = require('../services/studentViewEvaluator');
const { createPDFBuffer, createPDFBuffers } = require('../utils/pdfGenerator');
const certificateTemplate = require('../templates/certificateTemplate');
const { getCertificateEmailHTML } = require('../templates/emailTemplate');
const { getSchoolName } = require('../utils/schoolUtils');
const { cleanEmailArray, getSchoolApiKey, getSchoolDomain } = require('../utils/emailUtils');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

const VALID_TERM_SCOPES = new Set(['active', 'specific', 'all', 'every_listed', 'any_listed']);
const VALID_AGG_MODES = new Set(['overall_avg', 'every_class', 'any_class']);

const mapViewRow = (row) => ({
  viewId: row.view_id,
  school: row.school,
  ownerUserId: row.owner_user_id,
  name: row.name,
  description: row.description,
  isShared: row.is_shared,
  isSystem: row.is_system,
  criteria: row.criteria,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function validateCriteria(c) {
  if (!c || typeof c !== 'object') return 'criteria must be an object';
  if (!VALID_TERM_SCOPES.has(c.termScope)) return 'invalid termScope';
  if (!VALID_AGG_MODES.has(c.aggregationMode)) return 'invalid aggregationMode';
  if (typeof c.thresholdPercent !== 'number' || c.thresholdPercent < 0 || c.thresholdPercent > 100) {
    return 'thresholdPercent must be 0..100';
  }
  const needsTermIds = ['specific', 'every_listed', 'any_listed'].includes(c.termScope);
  if (needsTermIds) {
    const hasIds = Array.isArray(c.termIds) && c.termIds.length > 0;
    const hasMarker = c.termIdsMode === 'FIRST_TWO_TERMS';
    if (!hasIds && !hasMarker) return 'termIds (or termIdsMode) is required for this termScope';
  }
  if (c.attendanceMinPercent != null) {
    if (typeof c.attendanceMinPercent !== 'number' || c.attendanceMinPercent < 0 || c.attendanceMinPercent > 100) {
      return 'attendanceMinPercent must be 0..100';
    }
  }
  return null;
}

function canAccess(view, userId) {
  return view.is_system || view.is_shared || view.owner_user_id === userId;
}

// Edit rule:
//   - Admins can edit any view in their school, including system views.
//   - Non-admins can only edit views they personally own.
function canEdit(view, userId, role) {
  if (role === 'ADMIN') return true;
  return !view.is_system && view.owner_user_id === userId;
}

// Delete rule (intentionally stricter):
//   - System views are never deletable, even by admins — they're the
//     baseline awards every school relies on. Edit, don't delete.
//   - Otherwise, only the owner can delete.
function canDelete(view, userId) {
  return !view.is_system && view.owner_user_id === userId;
}

// ────────────────────────────────────────────────────────────────────
// CRUD
// ────────────────────────────────────────────────────────────────────

const listViews = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const { rows } = await db.query(q.selectVisibleViews, [school, userId]);
    return res.status(200).json({ status: 'success', data: rows.map(mapViewRow) });
  } catch (err) {
    logger.error({ err }, 'listViews failed');
    return res.status(500).json({ status: 'failed', message: 'Failed to list views' });
  }
};

const getView = async (req, res) => {
  const { userId } = req.user;
  const { viewId } = req.params;
  try {
    const { rows } = await db.query(q.selectViewById, [viewId]);
    const view = rows[0];
    if (!view) return res.status(404).json({ status: 'failed', message: 'View not found' });
    if (!canAccess(view, userId)) return res.status(403).json({ status: 'failed', message: 'Forbidden' });
    return res.status(200).json({ status: 'success', data: mapViewRow(view) });
  } catch (err) {
    logger.error({ err }, 'getView failed');
    return res.status(500).json({ status: 'failed', message: 'Failed to get view' });
  }
};

const createView = async (req, res) => {
  const { school, userId, role } = req.user;
  const { name, description, isShared, isSystem, criteria } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ status: 'failed', message: 'name is required' });
  }
  const err = validateCriteria(criteria);
  if (err) return res.status(400).json({ status: 'failed', message: err });

  // System view creation is admin-only. System views are unowned and always shared.
  if (isSystem && role !== 'ADMIN') {
    return res
      .status(403)
      .json({ status: 'failed', message: 'Only admins can create system views' });
  }

  const ownerUserId = isSystem ? null : userId;
  const sharedFlag = isSystem ? true : Boolean(isShared);
  const systemFlag = Boolean(isSystem);

  try {
    const { rows } = await db.query(q.insertView, [
      school,
      ownerUserId,
      name,
      description || '',
      sharedFlag,
      systemFlag,
      JSON.stringify(criteria),
    ]);
    return res.status(201).json({ status: 'success', data: mapViewRow(rows[0]) });
  } catch (e) {
    // Likely a unique-index hit on (school, name) WHERE is_system = TRUE
    if (e && e.code === '23505') {
      return res.status(409).json({
        status: 'failed',
        message: 'A system view with that name already exists for this school',
      });
    }
    logger.error({ err: e }, 'createView failed');
    return res.status(500).json({ status: 'failed', message: 'Failed to create view' });
  }
};

const updateView = async (req, res) => {
  const { userId, role } = req.user;
  const { viewId } = req.params;
  const { name, description, isShared, isSystem, criteria } = req.body;

  if (criteria != null) {
    const err = validateCriteria(criteria);
    if (err) return res.status(400).json({ status: 'failed', message: err });
  }

  // System-flag flips (promote/demote) are admin-only.
  if (isSystem != null && role !== 'ADMIN') {
    return res
      .status(403)
      .json({ status: 'failed', message: 'Only admins can change a view\'s system status' });
  }

  try {
    const existing = await db.query(q.selectViewById, [viewId]);
    const view = existing.rows[0];
    if (!view) return res.status(404).json({ status: 'failed', message: 'View not found' });
    if (!canEdit(view, userId, role)) {
      return res.status(403).json({
        status: 'failed',
        message: view.is_system
          ? 'Only admins can edit system views'
          : 'Only the owner can edit this view',
      });
    }

    // Compute owner/shared transitions implied by isSystem changes.
    //   promote (false → true): clear owner, force shared on.
    //   demote  (true → false): assign admin as owner; leave is_shared alone
    //                           unless the body explicitly toggles it.
    let nextIsShared = isShared;
    let nextOwnerUserId = null;
    let shouldReplaceOwner = false;
    if (isSystem === true && !view.is_system) {
      nextOwnerUserId = null;
      shouldReplaceOwner = true;
      nextIsShared = true;
    } else if (isSystem === false && view.is_system) {
      nextOwnerUserId = userId;
      shouldReplaceOwner = true;
    }

    const { rows } = await db.query(q.updateView, [
      viewId,
      name ?? null,
      description ?? null,
      nextIsShared ?? null,
      criteria == null ? null : JSON.stringify(criteria),
      isSystem ?? null,
      nextOwnerUserId,
      shouldReplaceOwner,
    ]);
    return res.status(200).json({ status: 'success', data: mapViewRow(rows[0]) });
  } catch (e) {
    // Same unique-index hit that creation catches — when promoting to a name
    // already used by another system view in this school.
    if (e && e.code === '23505') {
      return res.status(409).json({
        status: 'failed',
        message: 'A system view with that name already exists for this school',
      });
    }
    logger.error({ err: e }, 'updateView failed');
    return res.status(500).json({ status: 'failed', message: 'Failed to update view' });
  }
};

const deleteView = async (req, res) => {
  const { userId } = req.user;
  const { viewId } = req.params;
  try {
    const existing = await db.query(q.selectViewById, [viewId]);
    const view = existing.rows[0];
    if (!view) return res.status(404).json({ status: 'failed', message: 'View not found' });
    if (!canDelete(view, userId)) {
      return res.status(403).json({
        status: 'failed',
        message: view.is_system
          ? 'System views cannot be deleted'
          : 'Only the owner can delete this view',
      });
    }
    await db.query(q.deleteView, [viewId]);
    return res.status(200).json({ status: 'success', data: { viewId } });
  } catch (e) {
    logger.error({ err: e }, 'deleteView failed');
    return res.status(500).json({ status: 'failed', message: 'Failed to delete view' });
  }
};

// ────────────────────────────────────────────────────────────────────
// Evaluate (saved view)
// ────────────────────────────────────────────────────────────────────

const evaluateSavedView = async (req, res) => {
  const { userId } = req.user;
  const { viewId } = req.params;
  try {
    const { rows } = await db.query(q.selectViewById, [viewId]);
    const view = rows[0];
    if (!view) return res.status(404).json({ status: 'failed', message: 'View not found' });
    if (!canAccess(view, userId)) return res.status(403).json({ status: 'failed', message: 'Forbidden' });

    const students = await evaluateView(view);
    return res.status(200).json({ status: 'success', data: { view: mapViewRow(view), students } });
  } catch (e) {
    logger.error({ err: e }, 'evaluateSavedView failed');
    return res.status(500).json({ status: 'failed', message: 'Failed to evaluate view' });
  }
};

// Evaluate ad-hoc criteria (used by the live "matches preview" while building)
const evaluatePreview = async (req, res) => {
  const { school } = req.user;
  const { criteria, name = 'Preview', description = '' } = req.body;
  const err = validateCriteria(criteria);
  if (err) return res.status(400).json({ status: 'failed', message: err });

  try {
    const students = await evaluateView({ school, criteria, name, description });
    return res.status(200).json({ status: 'success', data: { students } });
  } catch (e) {
    logger.error({ err: e }, 'evaluatePreview failed');
    return res.status(500).json({ status: 'failed', message: 'Failed to evaluate preview' });
  }
};

// ────────────────────────────────────────────────────────────────────
// CSV export
// ────────────────────────────────────────────────────────────────────

const exportCsv = async (req, res) => {
  const { userId } = req.user;
  const { viewId } = req.params;
  try {
    const { rows } = await db.query(q.selectViewById, [viewId]);
    const view = rows[0];
    if (!view) return res.status(404).json({ status: 'failed', message: 'View not found' });
    if (!canAccess(view, userId)) return res.status(403).json({ status: 'failed', message: 'Forbidden' });

    const students = await evaluateView(view);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(view.name.slice(0, 31)); // sheet name max 31 chars
    ws.columns = [
      { header: 'Student Name', key: 'studentName', width: 28 },
      { header: 'Grade', key: 'grade', width: 8 },
      { header: 'Metric (%)', key: 'metric', width: 12 },
    ];
    students.forEach((s) => {
      ws.addRow({
        studentName: s.studentName,
        grade: s.grade,
        metric: Number(s.displayMetric.toFixed(2)),
      });
    });

    const buffer = await wb.csv.writeBuffer();
    const safeName = view.name.replace(/[^a-z0-9-_]+/gi, '_');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
    return res.send(buffer);
  } catch (e) {
    logger.error({ err: e }, 'exportCsv failed');
    return res.status(500).json({ status: 'failed', message: 'Failed to export CSV' });
  }
};

// ────────────────────────────────────────────────────────────────────
// PDF certificates
// ────────────────────────────────────────────────────────────────────

const generateCertificates = async (req, res) => {
  const { userId, school } = req.user;
  const { viewId } = req.params;
  const { studentIds } = req.body;
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    return res.status(400).json({ status: 'failed', message: 'studentIds is required' });
  }
  try {
    const { rows } = await db.query(q.selectViewById, [viewId]);
    const view = rows[0];
    if (!view) return res.status(404).json({ status: 'failed', message: 'View not found' });
    if (!canAccess(view, userId)) return res.status(403).json({ status: 'failed', message: 'Forbidden' });

    const students = await evaluateView(view);
    const selected = students.filter((s) => studentIds.includes(s.studentId));
    if (selected.length === 0) {
      return res.status(400).json({ status: 'failed', message: 'No matching students for given studentIds' });
    }

    const html = certificateTemplate({
      schoolName: school,
      viewName: view.name,
      viewDescription: view.description,
      students: selected.map((s) => ({
        studentName: s.studentName,
        grade: s.grade,
        metric: Number(s.displayMetric.toFixed(2)),
      })),
      issuedDate: new Date().toLocaleDateString('en-CA'),
    });

    const pdfBuffer = await createPDFBuffer(html, {
      landscape: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    const safeName = view.name.replace(/[^a-z0-9-_]+/gi, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_certificates.pdf"`);
    return res.send(pdfBuffer);
  } catch (e) {
    logger.error({ err: e }, 'generateCertificates failed');
    return res.status(500).json({ status: 'failed', message: 'Failed to generate certificates' });
  }
};

// ────────────────────────────────────────────────────────────────────
// Email certificates to parents
// ────────────────────────────────────────────────────────────────────
//
// Mirrors sendBulkReportEmails (reportEmails.controller.js): one email
// per student to their parents, the child's certificate PDF attached,
// sent sequentially with a 600ms gap to respect Resend's rate limit,
// failures captured per-student so the batch always completes. Unlike
// report cards, the PDF is generated in-memory (not pulled from
// Supabase Storage), so all certificates are rendered up front in a
// single Puppeteer browser pass before the rate-limited send loop.

const sendStudentViewCertificateEmails = async (req, res) => {
  const startTime = Date.now();
  const { userId, school } = req.user;
  const { viewId } = req.params;
  const { studentIds, customHeader, customMessage, ccAddresses: rawCcAddresses } = req.body;

  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    return res.status(400).json({ status: 'failed', message: 'studentIds is required' });
  }

  try {
    const { rows } = await db.query(q.selectViewById, [viewId]);
    const view = rows[0];
    if (!view) return res.status(404).json({ status: 'failed', message: 'View not found' });
    if (!canAccess(view, userId)) return res.status(403).json({ status: 'failed', message: 'Forbidden' });

    // Qualifying students for this view, narrowed to the caller's selection.
    const evaluated = await evaluateView(view);
    const selected = evaluated.filter((s) => studentIds.includes(s.studentId));
    if (selected.length === 0) {
      return res.status(400).json({ status: 'failed', message: 'No matching students for given studentIds' });
    }

    // Parent emails aren't part of the evaluator output — fetch them.
    const { rows: contactRows } = await db.query(
      studentViewEmailsQueries.selectStudentEmailsByIds,
      [selected.map((s) => s.studentId)],
    );
    const contactById = new Map(contactRows.map((r) => [r.student_id, r]));

    // School info for the footer (best-effort, mirrors the report flow).
    let schoolInfo = null;
    try {
      const { rows: schoolRows } = await db.query(schoolQueries.selectSchoolByCode, [view.school]);
      if (schoolRows.length > 0) schoolInfo = schoolRows[0];
    } catch (schoolError) {
      logger.warn({ err: schoolError }, 'sendStudentViewCertificateEmails: school info lookup failed');
    }

    const schoolName = getSchoolName(view.school);
    const schoolDomain = getSchoolDomain(view.school);
    const resend = new Resend(getSchoolApiKey(view.school));
    const ccAddresses = cleanEmailArray(rawCcAddresses);
    const issuedDate = new Date().toLocaleDateString('en-CA');

    // Split the selection into sendable tasks vs. students with no parent email.
    const results = [];
    const tasks = [];
    for (const student of selected) {
      const contact = contactById.get(student.studentId);
      const parentEmails = cleanEmailArray([contact?.mother_email, contact?.father_email]);
      if (parentEmails.length === 0) {
        results.push({
          studentId: student.studentId,
          studentName: student.studentName,
          status: 'failed',
          error: 'No parent email addresses found',
        });
        continue;
      }
      tasks.push({ student, parentEmails });
    }

    // Render every certificate PDF in a SINGLE browser launch (one page per
    // child), instead of relaunching Puppeteer inside the rate-limited loop.
    const pdfBuffers = await createPDFBuffers(
      tasks.map((t) =>
        certificateTemplate({
          schoolName: view.school,
          viewName: view.name,
          viewDescription: view.description,
          students: [
            {
              studentName: t.student.studentName,
              grade: t.student.grade,
              metric: Number(t.student.displayMetric.toFixed(2)),
            },
          ],
          issuedDate,
        }),
      ),
      { landscape: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } },
    );

    // Send sequentially, respecting Resend's rate limit (2 req/sec max).
    for (let i = 0; i < tasks.length; i++) {
      const { student, parentEmails } = tasks[i];
      try {
        const subject = customHeader && customHeader.trim()
          ? customHeader.trim()
          : `${student.studentName} — ${view.name}`;

        const html = getCertificateEmailHTML({
          studentName: student.studentName,
          viewName: view.name,
          customMessage,
          schoolName,
          customHeader: subject,
          schoolInfo,
        });

        const safeStudent = student.studentName.replace(/[^a-z0-9-_]+/gi, '_');
        const safeView = view.name.replace(/[^a-z0-9-_]+/gi, '_');

        const emailPayload = {
          from: `certificates@${schoolDomain}`,
          to: parentEmails,
          subject,
          html,
          attachments: [
            {
              filename: `${safeView}_${safeStudent}.pdf`,
              content: Buffer.from(pdfBuffers[i]),
            },
          ],
        };

        if (ccAddresses.length) emailPayload.cc = ccAddresses;

        const emailResult = await resend.emails.send(emailPayload);
        if (emailResult.error) {
          throw new Error(emailResult.error.message || 'Email sending failed');
        }

        await db.query(studentViewEmailsQueries.createStudentViewCertificateEmail, [
          view.view_id,
          student.studentId,
          userId || null,
          JSON.stringify(parentEmails),
          ccAddresses.length ? JSON.stringify(ccAddresses) : null,
          customHeader || null,
          customMessage || null,
          Number(student.displayMetric.toFixed(2)),
          view.school,
        ]);

        results.push({
          studentId: student.studentId,
          studentName: student.studentName,
          status: 'success',
          emailId: emailResult.data?.id,
          sentTo: parentEmails,
        });
      } catch (err) {
        logger.error({ err }, `Failed to send certificate email for student ${tasks[i].student.studentName}`);
        results.push({
          studentId: tasks[i].student.studentId,
          studentName: tasks[i].student.studentName,
          status: 'failed',
          error: err.message,
        });
      }

      // Rate limiting: wait 600ms between sends (< 2 req/sec).
      if (i < tasks.length - 1) await sleep(600);
    }

    const duration = (Date.now() - startTime) / 1000;
    const successful = results.filter((r) => r.status === 'success');
    const failed = results.filter((r) => r.status === 'failed');

    logger.info(
      `Certificate email batch for view ${view.view_id} completed: ${successful.length} sent, ${failed.length} failed in ${duration}s`,
    );

    return res.status(200).json({
      status: 'completed',
      viewId: view.view_id,
      summary: {
        total: results.length,
        sent: successful.length,
        failed: failed.length,
        duration: `${duration}s`,
      },
      results: results.map((r) => ({
        studentId: r.studentId,
        studentName: r.studentName,
        status: r.status,
        ...(r.status === 'success' ? { sentTo: r.sentTo } : { error: r.error }),
      })),
    });
  } catch (e) {
    logger.error({ err: e }, 'sendStudentViewCertificateEmails failed');
    return res.status(500).json({ status: 'failed', message: 'Failed to send certificate emails' });
  }
};

// Email ONE student's certificate to an explicit recipient list (e.g. a
// single parent). Same building blocks as the bulk flow, but the caller
// supplies the recipients instead of them being assembled from
// mother_email/father_email — mirrors report cards' single /send.
const sendSingleStudentViewCertificateEmail = async (req, res) => {
  const { userId } = req.user;
  const { viewId, studentId } = req.params;
  const { emailAddresses: rawEmailAddresses, customHeader, customMessage, ccAddresses: rawCcAddresses } = req.body;

  const emailAddresses = cleanEmailArray(rawEmailAddresses);
  if (emailAddresses.length === 0) {
    return res.status(400).json({ status: 'failed', message: 'At least one recipient email address is required' });
  }

  try {
    const { rows } = await db.query(q.selectViewById, [viewId]);
    const view = rows[0];
    if (!view) return res.status(404).json({ status: 'failed', message: 'View not found' });
    if (!canAccess(view, userId)) return res.status(403).json({ status: 'failed', message: 'Forbidden' });

    // The certificate states the student's metric/award, so only send for a
    // student who currently qualifies for this view.
    const evaluated = await evaluateView(view);
    const student = evaluated.find((s) => s.studentId === studentId);
    if (!student) {
      return res.status(400).json({ status: 'failed', message: 'Student does not currently qualify for this view' });
    }

    let schoolInfo = null;
    try {
      const { rows: schoolRows } = await db.query(schoolQueries.selectSchoolByCode, [view.school]);
      if (schoolRows.length > 0) schoolInfo = schoolRows[0];
    } catch (schoolError) {
      logger.warn({ err: schoolError }, 'sendSingleStudentViewCertificateEmail: school info lookup failed');
    }

    const schoolName = getSchoolName(view.school);
    const schoolDomain = getSchoolDomain(view.school);
    const resend = new Resend(getSchoolApiKey(view.school));
    const ccAddresses = cleanEmailArray(rawCcAddresses);

    const pdfBuffer = await createPDFBuffer(
      certificateTemplate({
        schoolName: view.school,
        viewName: view.name,
        viewDescription: view.description,
        students: [
          {
            studentName: student.studentName,
            grade: student.grade,
            metric: Number(student.displayMetric.toFixed(2)),
          },
        ],
        issuedDate: new Date().toLocaleDateString('en-CA'),
      }),
      { landscape: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } },
    );

    const subject = customHeader && customHeader.trim()
      ? customHeader.trim()
      : `${student.studentName} — ${view.name}`;

    const html = getCertificateEmailHTML({
      studentName: student.studentName,
      viewName: view.name,
      customMessage,
      schoolName,
      customHeader: subject,
      schoolInfo,
    });

    const safeStudent = student.studentName.replace(/[^a-z0-9-_]+/gi, '_');
    const safeView = view.name.replace(/[^a-z0-9-_]+/gi, '_');

    const emailPayload = {
      from: `certificates@${schoolDomain}`,
      to: emailAddresses,
      subject,
      html,
      attachments: [
        {
          filename: `${safeView}_${safeStudent}.pdf`,
          content: Buffer.from(pdfBuffer),
        },
      ],
    };

    if (ccAddresses.length) emailPayload.cc = ccAddresses;

    const emailResult = await resend.emails.send(emailPayload);
    if (emailResult.error) {
      logger.error({ err: emailResult.error }, 'Single certificate email send failed');
      return res.status(500).json({ status: 'failed', message: 'Failed to send certificate email', error: emailResult.error });
    }

    const { rows: logRows } = await db.query(studentViewEmailsQueries.createStudentViewCertificateEmail, [
      view.view_id,
      student.studentId,
      userId || null,
      JSON.stringify(emailAddresses),
      ccAddresses.length ? JSON.stringify(ccAddresses) : null,
      customHeader || null,
      customMessage || null,
      Number(student.displayMetric.toFixed(2)),
      view.school,
    ]);

    return res.status(200).json({
      status: 'success',
      message: 'Certificate email sent successfully',
      data: {
        id: logRows[0]?.id,
        sentAt: logRows[0]?.sent_at,
        emailId: emailResult.data?.id,
        sentTo: emailAddresses,
      },
    });
  } catch (e) {
    logger.error({ err: e }, 'sendSingleStudentViewCertificateEmail failed');
    return res.status(500).json({ status: 'failed', message: 'Failed to send certificate email' });
  }
};

module.exports = {
  listViews,
  getView,
  createView,
  updateView,
  deleteView,
  evaluateSavedView,
  evaluatePreview,
  exportCsv,
  generateCertificates,
  sendStudentViewCertificateEmails,
  sendSingleStudentViewCertificateEmail,
};
