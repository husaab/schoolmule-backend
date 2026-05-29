// controllers/studentView.controller.js

const db = require('../config/database');
const ExcelJS = require('exceljs');
const logger = require('../logger');
const q = require('../queries/studentView.queries');
const { evaluateView } = require('../services/studentViewEvaluator');
const { createPDFBuffer } = require('../utils/pdfGenerator');
const certificateTemplate = require('../templates/certificateTemplate');

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
  const { name, description, isShared, criteria } = req.body;

  if (criteria != null) {
    const err = validateCriteria(criteria);
    if (err) return res.status(400).json({ status: 'failed', message: err });
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

    const { rows } = await db.query(q.updateView, [
      viewId,
      name ?? null,
      description ?? null,
      isShared ?? null,
      criteria == null ? null : JSON.stringify(criteria),
    ]);
    return res.status(200).json({ status: 'success', data: mapViewRow(rows[0]) });
  } catch (e) {
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
};
