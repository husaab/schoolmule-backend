// controllers/registrationStatus.controller.js
//
// CRUD for a school's submission status vocabulary.

const db = require('../config/database');
const logger = require('../logger');
const statusQueries = require('../queries/registrationStatus.queries');

// Colours the UI knows how to render. Stored as tokens rather than CSS so the
// palette can be restyled without a data migration.
const ALLOWED_COLORS = ['cyan', 'emerald', 'amber', 'rose', 'violet', 'blue', 'slate'];

const toCamel = (row) => ({
  statusId: row.status_id,
  key: row.key,
  label: row.label,
  color: row.color,
  sortOrder: row.sort_order,
  isBuiltin: row.is_builtin,
  isDefault: row.is_default,
});

// Derives a stable storage key from a label: "On Waitlist" → "on_waitlist".
// Keys are what submissions actually store, so they never change afterwards.
const toKey = (label) =>
  String(label)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);

const getStatuses = async (req, res) => {
  try {
    const school = req.user.school;
    let { rows } = await db.query(statusQueries.selectStatusesBySchool, [school]);

    // A school onboarded after the statuses migration has no vocabulary yet,
    // and its submissions couldn't satisfy the status foreign key. Seed the
    // built-ins on first read rather than leaving that school broken.
    if (rows.length === 0) {
      await db.query(statusQueries.seedBuiltinsForSchool, [school]);
      ({ rows } = await db.query(statusQueries.selectStatusesBySchool, [school]));
      logger.info({ school }, 'Seeded built-in submission statuses');
    }

    return res.status(200).json({ status: 'success', data: rows.map(toCamel) });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching submission statuses');
    return res.status(500).json({ status: 'failed', message: 'Error fetching statuses' });
  }
};

const createStatus = async (req, res) => {
  try {
    const school = req.user.school;
    const { label, color } = req.body;

    if (!label || !String(label).trim()) {
      return res.status(400).json({ status: 'failed', message: 'A label is required' });
    }
    if (color && !ALLOWED_COLORS.includes(color)) {
      return res.status(400).json({ status: 'failed', message: 'Unknown colour' });
    }

    const key = toKey(label);
    if (!key) {
      return res.status(400).json({ status: 'failed', message: 'Label must contain letters or numbers' });
    }

    const { rows: existing } = await db.query(statusQueries.selectStatusByKey, [school, key]);
    if (existing.length > 0) {
      return res.status(409).json({ status: 'failed', message: `"${existing[0].label}" already exists` });
    }

    const { rows } = await db.query(statusQueries.insertStatus, [
      school, key, String(label).trim(), color || 'slate',
    ]);
    return res.status(201).json({ status: 'success', data: toCamel(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error creating submission status');
    return res.status(500).json({ status: 'failed', message: 'Error creating status' });
  }
};

const updateStatus = async (req, res) => {
  try {
    const school = req.user.school;
    const { statusId } = req.params;
    const { label, color } = req.body;

    if (!label || !String(label).trim()) {
      return res.status(400).json({ status: 'failed', message: 'A label is required' });
    }
    if (color && !ALLOWED_COLORS.includes(color)) {
      return res.status(400).json({ status: 'failed', message: 'Unknown colour' });
    }

    // Built-ins are editable here — only their key is fixed, and the key is
    // never taken from the request.
    const { rows } = await db.query(statusQueries.updateStatus, [
      statusId, school, String(label).trim(), color || 'slate',
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Status not found' });
    }
    return res.status(200).json({ status: 'success', data: toCamel(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error updating submission status');
    return res.status(500).json({ status: 'failed', message: 'Error updating status' });
  }
};

/**
 * How many submissions use this status, so the delete dialog can warn before
 * anything is destroyed rather than after.
 */
const getStatusUsage = async (req, res) => {
  try {
    const school = req.user.school;
    const { rows } = await db.query(statusQueries.selectStatusById, [req.params.statusId, school]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Status not found' });
    }
    const { rows: counts } = await db.query(statusQueries.countSubmissionsWithStatus, [school, rows[0].key]);
    return res.status(200).json({
      status: 'success',
      data: { ...toCamel(rows[0]), submissionCount: parseInt(counts[0].count, 10) },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error checking status usage');
    return res.status(500).json({ status: 'failed', message: 'Error checking status' });
  }
};

/**
 * Delete a custom status.
 *
 * A status still in use is refused unless the caller names a replacement, so a
 * school can never silently lose workflow state — 14 waitlisted families don't
 * quietly become new submissions again.
 */
const deleteStatus = async (req, res) => {
  const client = await db.connect();
  try {
    const school = req.user.school;
    const { statusId } = req.params;
    const { reassignTo } = req.body || {};

    const { rows: target } = await client.query(statusQueries.selectStatusById, [statusId, school]);
    if (target.length === 0) {
      client.release();
      return res.status(404).json({ status: 'failed', message: 'Status not found' });
    }
    if (target[0].is_builtin) {
      client.release();
      return res.status(400).json({
        status: 'failed',
        message: `"${target[0].label}" is a built-in status and can't be deleted. You can rename it instead.`,
      });
    }

    const { rows: counts } = await client.query(
      statusQueries.countSubmissionsWithStatus, [school, target[0].key],
    );
    const inUse = parseInt(counts[0].count, 10);

    if (inUse > 0 && !reassignTo) {
      client.release();
      return res.status(409).json({
        status: 'failed',
        code: 'IN_USE',
        message: `${inUse} submission${inUse === 1 ? '' : 's'} still use this status. Choose a status to move them to.`,
        data: { submissionCount: inUse },
      });
    }

    await client.query('BEGIN');

    if (inUse > 0) {
      const { rows: replacement } = await client.query(statusQueries.selectStatusByKey, [school, reassignTo]);
      if (replacement.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ status: 'failed', message: 'Replacement status not found' });
      }
      if (replacement[0].key === target[0].key) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ status: 'failed', message: "Can't reassign a status to itself" });
      }
      await client.query(statusQueries.reassignSubmissions, [school, target[0].key, replacement[0].key]);
    }

    await client.query(statusQueries.deleteStatus, [statusId, school]);
    await client.query('COMMIT');

    logger.info({ school, key: target[0].key, reassigned: inUse }, 'Submission status deleted');
    return res.status(200).json({
      status: 'success',
      message: inUse > 0
        ? `Status deleted. ${inUse} submission${inUse === 1 ? '' : 's'} moved to ${reassignTo}.`
        : 'Status deleted',
      data: { reassigned: inUse },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: error }, 'Error deleting submission status');
    return res.status(500).json({ status: 'failed', message: 'Error deleting status' });
  } finally {
    client.release();
  }
};

/** Persists a drag-reorder as one transaction so the list can't end up half-sorted. */
const reorderStatuses = async (req, res) => {
  const client = await db.connect();
  try {
    const school = req.user.school;
    const { statusIds } = req.body;

    if (!Array.isArray(statusIds) || statusIds.length === 0) {
      client.release();
      return res.status(400).json({ status: 'failed', message: 'statusIds must be a non-empty array' });
    }

    await client.query('BEGIN');
    for (let i = 0; i < statusIds.length; i++) {
      await client.query(statusQueries.updateSortOrder, [statusIds[i], school, i]);
    }
    await client.query('COMMIT');

    const { rows } = await db.query(statusQueries.selectStatusesBySchool, [school]);
    return res.status(200).json({ status: 'success', data: rows.map(toCamel) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: error }, 'Error reordering submission statuses');
    return res.status(500).json({ status: 'failed', message: 'Error reordering statuses' });
  } finally {
    client.release();
  }
};

module.exports = {
  getStatuses,
  createStatus,
  updateStatus,
  getStatusUsage,
  deleteStatus,
  reorderStatuses,
  ALLOWED_COLORS,
  toKey,
};
