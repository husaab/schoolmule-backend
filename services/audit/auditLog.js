// services/audit/auditLog.js
//
// The one way a row gets into audit_log (who changed what, and what it was
// before). record() never throws and never blocks the change it describes: a
// change that happened is not undone because its log line failed, the failure
// is logged instead.
//
// `changes` is a list of { key, label, before, after } holding ids, labels
// and values only. Never put an education number or a contact detail in it.

const db = require('../../config/database');
const logger = require('../../logger');

const SOURCES = new Set(['ui', 'assistant', 'system']);

const insertAudit = `
  INSERT INTO audit_log (
    school, school_year_id, actor_user_id, actor_view, source, action,
    entity_type, entity_id, summary, changes, request_id, assistant_action_id
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
  RETURNING audit_id
`;

/** The audit fields a request carries: who is acting, in which view and year. */
const actorOf = (req) => ({
  school: req.user?.school,
  schoolYearId: req.schoolYear?.schoolYearId ?? null,
  actorUserId: req.user?.userId ?? null,
  actorView: req.user?.role ?? null,
  requestId: req.id ? String(req.id) : null,
});

/**
 * Write one audit row. Resolves to its id, or null when it could not be
 * written (the reason is logged).
 *
 * @param {{ school: string, action: string, entityType: string, summary: string,
 *   schoolYearId?: string|null, actorUserId?: string|null, actorView?: string|null,
 *   source?: 'ui'|'assistant'|'system', entityId?: string|null,
 *   changes?: Array<{ key: string, label?: string, before: unknown, after: unknown }>,
 *   requestId?: string|null, assistantActionId?: string|null }} entry
 */
async function record(entry) {
  try {
    const { school, action, entityType, summary } = entry || {};
    if (!school || !action || !entityType || !summary) {
      logger.warn({ action, entityType }, 'Audit entry without a school, action, entity type or summary was not written');
      return null;
    }
    const source = SOURCES.has(entry.source) ? entry.source : 'ui';
    const { rows } = await db.query(insertAudit, [
      school,
      entry.schoolYearId ?? null,
      entry.actorUserId ?? null,
      entry.actorView ?? null,
      source,
      action,
      entityType,
      entry.entityId ?? null,
      summary,
      JSON.stringify(Array.isArray(entry.changes) ? entry.changes : []),
      entry.requestId ?? null,
      entry.assistantActionId ?? null,
    ]);
    return rows[0]?.audit_id ?? null;
  } catch (err) {
    logger.warn({ err, action: entry?.action }, 'Audit entry could not be written');
    return null;
  }
}

module.exports = { record, actorOf };
