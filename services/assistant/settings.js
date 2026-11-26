// services/assistant/settings.js
//
// Whether Muley is on for a school, and for which views. A school with no
// row is off. The platform owner switches a school on; each view (teachers,
// administrators, parents) has its own switch beside it.
//
// Read on every assistant request, so the answer is cached for a few
// seconds per school; a change through save() takes effect at once.

const db = require('../../config/database');
const queries = require('../../queries/assistant.queries');

const TTL_MS = 15_000;
const cache = new Map();

const OFF = Object.freeze({
  enabled: false, roleTeacher: false, roleAdmin: false, roleParent: false,
  allowWrites: false, allowOutward: false, selfServe: false, transcriptRetentionDays: 90,
});

const fromRow = (row) => ({
  enabled: row.enabled,
  roleTeacher: row.role_teacher,
  roleAdmin: row.role_admin,
  roleParent: row.role_parent,
  allowWrites: row.allow_writes,
  allowOutward: row.allow_outward,
  selfServe: row.self_serve,
  transcriptRetentionDays: row.transcript_retention_days,
});

/** The school's switches (all off when it has never been set up). */
async function get(school) {
  const hit = cache.get(school);
  if (hit && hit.until > Date.now()) return hit.value;
  const { rows } = await db.query(queries.selectSettings, [school]);
  const value = rows[0] ? fromRow(rows[0]) : OFF;
  cache.set(school, { value, until: Date.now() + TTL_MS });
  return value;
}

/** Whether a view of this school gets Muley at all. */
function onFor(settings, view) {
  if (!settings.enabled) return false;
  if (view === 'TEACHER') return settings.roleTeacher;
  if (view === 'ADMIN') return settings.roleAdmin;
  if (view === 'PARENT') return settings.roleParent;
  return false;
}

const BOOLEANS = ['enabled', 'roleTeacher', 'roleAdmin', 'roleParent', 'allowWrites', 'allowOutward', 'selfServe'];

/** Change some of a school's switches, leaving the rest as they are. -> the new settings */
async function save(school, patch, userId) {
  const current = await get(school);
  const next = { ...current };
  for (const key of BOOLEANS) if (typeof patch[key] === 'boolean') next[key] = patch[key];
  if (Number.isInteger(patch.transcriptRetentionDays)) {
    next.transcriptRetentionDays = Math.min(365, Math.max(7, patch.transcriptRetentionDays));
  }
  const { rows } = await db.query(queries.upsertSettings, [
    school, next.enabled, next.roleTeacher, next.roleAdmin, next.roleParent, next.allowWrites,
    next.allowOutward, next.selfServe, next.transcriptRetentionDays, userId,
  ]);
  cache.delete(school);
  return fromRow(rows[0]);
}

const invalidateAll = () => cache.clear();

module.exports = { get, onFor, save, invalidateAll, OFF };
