// services/assistant/actions/service.js
//
// A change Muley prepared, from the moment it is shown to the person to the
// moment it is undone. Nothing here runs on the model's say-so: create() only
// records what was proposed; apply() and undo() run when the person presses
// the button, through their own request.
//
//   pending -> applying -> applied -> undoing -> undone
//   pending -> rejected (dismissed) | expired
//   a refused write goes back to where it was, with the reason
//
// Apply re-reads the students' current values first. A value that has
// changed since the preview (someone typed in the gradebook) stops the whole
// apply with the differences, so nothing the person didn't see is
// overwritten. Undo puts back exactly what was there before the write,
// unless that changed again since, the same way.

const crypto = require('crypto');
const db = require('../../../config/database');
const logger = require('../../../logger');
const queries = require('../../../queries/assistant.queries');
const audit = require('../../audit/auditLog');
const store = require('../store');
const { KINDS } = require('./kinds');
const { createDispatcher } = require('../tools/dispatcher');
const { ToolError } = require('../errors');

const PENDING_HOURS = 24;
const UNDO_DAYS = 14;

/** JSON with its keys sorted, so the same change always hashes the same. */
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
};
const hashOf = (kind, args, before) => crypto.createHash('sha256').update(canonical({ kind, args, before })).digest('hex');

class ActionError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** What the app is told about an action: no ids of students, enough to draw the card's footer. */
function publicView(row) {
  const kind = KINDS[row.kind];
  const n = Object.keys(row.args.targets || {}).length;
  const result = row.result || {};
  return {
    id: row.action_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    hash: row.args_hash,
    expiresAt: row.expires_at,
    applyLabel: `Save ${kind.count(n)}`,
    doneLabel: result.written === 0 ? 'Already up to date' : `Saved ${kind.count(result.written ?? n)}`,
    undoLabel: 'Undo',
    undoneLabel: `Undone. ${kind.count(n)} put back as they were.`,
    canUndo: row.status === 'applied' && row.applied_at && Date.now() - new Date(row.applied_at).getTime() < UNDO_DAYS * 86_400_000,
    topics: kind.topics(row.args),
    error: row.error_message || null,
  };
}

/** Record a change a tool prepared. -> its public view. Nothing is written to school data. */
async function create({ conversationId, toolCallId, who, schoolYearId, kind, title, args, before, preview }) {
  if (!KINDS[kind]) throw new Error(`Unknown action kind "${kind}"`);
  const expires = new Date(Date.now() + PENDING_HOURS * 3_600_000);
  const hash = hashOf(kind, args, before);
  const { rows } = await db.query(queries.insertAction, [
    conversationId, who.school, schoolYearId, who.userId, kind, 'reversible', title,
    JSON.stringify(args), JSON.stringify(preview), JSON.stringify(before), hash, toolCallId, expires,
  ]);
  if (rows[0]) return publicView(rows[0]);
  // The same tool call again (a retried turn): the action it already made.
  const { rows: [existing] } = await db.query(
    'SELECT * FROM assistant_actions WHERE conversation_id = $1 AND tool_call_id = $2', [conversationId, toolCallId]);
  return publicView(existing);
}

async function load(actionId, who) {
  const { rows: [row] } = await db.query(queries.selectAction, [actionId, who.userId, who.school]);
  if (!row) throw new ActionError(404, 'ACTION_NOT_FOUND', 'That change was not found.');
  return row;
}

const move = async (actionId, from, to) => (await db.query(queries.moveAction, [actionId, from, to])).rows[0] || null;

/** Tell the model, on its next turn, what happened to a change it prepared. */
async function tellConversation(row, sentence) {
  if (!row.conversation_id) return;
  await store.append(row.conversation_id, null, { role: 'event', content: sentence }).catch((err) =>
    logger.warn({ err }, 'Assistant: could not note an applied change in the conversation'));
}

/** Read, compare and write one direction of a change. -> { written, current } or throws ActionError(409) with the differences. */
async function settle(row, { read, write }, { from, to, labelOf }) {
  const kind = KINDS[row.kind];
  const current = await kind.read(read, row.args);
  const keys = Object.keys(to);
  const conflicts = [];
  const toWrite = {};
  for (const key of keys) {
    const now = kind.valueOf(current, key);
    if (kind.same(now, to[key])) continue; // already as it should be
    if (!kind.same(now, from[key])) {
      conflicts.push({ name: labelOf(key), was: kind.label(from[key], row.args), now: kind.label(now, row.args) });
      continue;
    }
    toWrite[key] = to[key];
  }
  if (conflicts.length > 0) return { conflicts, current };
  if (Object.keys(toWrite).length > 0) await kind.write(write, row.args, toWrite);
  return { conflicts: [], current, written: Object.keys(toWrite).length };
}

const namesOf = (row) => {
  const names = {};
  for (const r of (row.preview && row.preview.rows) || []) if (r.key) names[r.key] = r.name;
  return (key) => names[key] || 'A student';
};

/**
 * The person pressed Apply.
 * @param {{ actionId: string, who: object, token: string, expectedHash: string, idempotencyKey?: string|null, requestId?: string, transport?: Function }} request
 */
async function apply({ actionId, who, token, expectedHash, idempotencyKey = null, requestId = 'apply', transport }) {
  let row = await load(actionId, who);
  if (row.status === 'applied') {
    if (idempotencyKey && row.apply_key === idempotencyKey) return publicView(row);
    throw new ActionError(409, 'ALREADY_APPLIED', 'This change was already saved.', { action: publicView(row) });
  }
  if (row.status !== 'pending') throw new ActionError(409, 'NOT_PENDING', 'This change can no longer be applied.', { action: publicView(row) });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    row = (await move(actionId, 'pending', 'expired')) || row;
    throw new ActionError(410, 'EXPIRED', 'This preview is out of date. Ask Muley again to see the current values.', { action: publicView(row) });
  }
  if (expectedHash !== row.args_hash) throw new ActionError(409, 'HASH_MISMATCH', 'This is not the change you were shown. Ask Muley again.');

  const claimed = await move(actionId, 'pending', 'applying');
  if (!claimed) throw new ActionError(409, 'BUSY', 'This change is already being saved.');

  const dispatcher = createDispatcher({ token, schoolYearId: row.school_year_id, requestId, ...(transport ? { transport } : {}) });
  const labelOf = namesOf(row);
  try {
    const outcome = await settle(row, dispatcher, { from: row.before_state, to: row.args.targets, labelOf });
    if (outcome.conflicts.length > 0) {
      await move(actionId, 'applying', 'pending');
      throw new ActionError(409, 'STALE', 'Some of these changed after Muley showed you the preview, so nothing was saved.', { conflicts: outcome.conflicts });
    }
    const kind = KINDS[row.kind];
    const beforeApplied = {};
    for (const key of Object.keys(row.args.targets)) beforeApplied[key] = kind.valueOf(outcome.current, key);
    const afterRead = await kind.read(dispatcher.read, row.args);
    const after = {};
    let mismatched = 0;
    for (const key of Object.keys(row.args.targets)) {
      after[key] = kind.valueOf(afterRead, key);
      if (!kind.same(after[key], row.args.targets[key])) mismatched += 1;
    }
    const { rows: [applied] } = await db.query(queries.markApplied, [
      actionId, JSON.stringify(beforeApplied), JSON.stringify(after), JSON.stringify({ written: outcome.written, mismatched }), who.userId, idempotencyKey,
    ]);
    await audit.record({
      school: who.school, schoolYearId: row.school_year_id, actorUserId: who.userId, actorView: who.view, source: 'assistant',
      action: `assistant.${row.kind}.apply`, entityType: 'class', entityId: row.args.classId, summary: row.title,
      changes: Object.keys(row.args.targets).map((key) => ({ key, label: labelOf(key), before: beforeApplied[key], after: after[key] })),
      requestId, assistantActionId: actionId,
    });
    await tellConversation(row, `The person pressed Save on "${row.title}": ${KINDS[row.kind].count(outcome.written)} saved. It can be undone from the same card.`);
    return publicView(applied);
  } catch (err) {
    if (err instanceof ActionError) throw err;
    const refused = err instanceof ToolError;
    if (!refused) logger.error({ err }, 'Assistant: applying a change failed');
    await db.query(queries.markRefused, [actionId, 'applying', 'pending', refused ? err.code : 'FAILED', refused ? err.message : 'The change could not be saved.']);
    throw new ActionError(refused ? 422 : 500, refused ? err.code : 'APPLY_FAILED', refused ? err.message : 'The change could not be saved. Nothing was changed.');
  }
}

/** The person pressed Undo on a change that was applied. */
async function undo({ actionId, who, token, idempotencyKey = null, requestId = 'undo', transport }) {
  const row = await load(actionId, who);
  if (row.status === 'undone') {
    if (idempotencyKey && row.undo_key === idempotencyKey) return publicView(row);
    throw new ActionError(409, 'ALREADY_UNDONE', 'This change was already undone.', { action: publicView(row) });
  }
  if (row.status !== 'applied') throw new ActionError(409, 'NOT_APPLIED', 'Only a saved change can be undone.', { action: publicView(row) });
  if (!publicView(row).canUndo) throw new ActionError(409, 'UNDO_TOO_LATE', `A change can be undone for ${UNDO_DAYS} days after it was saved.`, { action: publicView(row) });

  const claimed = await move(actionId, 'applied', 'undoing');
  if (!claimed) throw new ActionError(409, 'BUSY', 'This change is already being undone.');

  const dispatcher = createDispatcher({ token, schoolYearId: row.school_year_id, requestId, ...(transport ? { transport } : {}) });
  const labelOf = namesOf(row);
  try {
    const outcome = await settle(row, dispatcher, { from: row.after_state, to: row.before_applied, labelOf });
    if (outcome.conflicts.length > 0) {
      await move(actionId, 'undoing', 'applied');
      throw new ActionError(409, 'STALE', 'Some of these were changed again after Muley saved them, so nothing was undone.', { conflicts: outcome.conflicts });
    }
    const { rows: [undone] } = await db.query(queries.markUndone, [actionId, who.userId, idempotencyKey, JSON.stringify({ undoWritten: outcome.written })]);
    await audit.record({
      school: who.school, schoolYearId: row.school_year_id, actorUserId: who.userId, actorView: who.view, source: 'assistant',
      action: `assistant.${row.kind}.undo`, entityType: 'class', entityId: row.args.classId, summary: `Undone: ${row.title}`,
      changes: Object.keys(row.before_applied).map((key) => ({ key, label: labelOf(key), before: row.after_state[key], after: row.before_applied[key] })),
      requestId, assistantActionId: actionId,
    });
    await tellConversation(row, `The person pressed Undo on "${row.title}": it was put back as it was before.`);
    return publicView(undone);
  } catch (err) {
    if (err instanceof ActionError) throw err;
    const refused = err instanceof ToolError;
    if (!refused) logger.error({ err }, 'Assistant: undoing a change failed');
    await db.query(queries.markRefused, [actionId, 'undoing', 'applied', refused ? err.code : 'FAILED', refused ? err.message : 'The change could not be undone.']);
    throw new ActionError(refused ? 422 : 500, refused ? err.code : 'UNDO_FAILED', refused ? err.message : 'The change could not be undone. Nothing was changed.');
  }
}

/** The person dismissed a change they don't want. */
async function dismiss({ actionId, who }) {
  const row = await load(actionId, who);
  if (row.status === 'rejected') return publicView(row);
  const moved = await move(actionId, 'pending', 'rejected');
  if (!moved) throw new ActionError(409, 'NOT_PENDING', 'Only a change that has not been saved can be dismissed.', { action: publicView(row) });
  await tellConversation(row, `The person dismissed "${row.title}". Nothing was saved.`);
  return publicView(moved);
}

async function get({ actionId, who }) {
  return publicView(await load(actionId, who));
}

async function forConversation(conversationId) {
  const { rows } = await db.query(queries.selectConversationActions, [conversationId]);
  return rows.map(publicView);
}

module.exports = { create, apply, undo, dismiss, get, forConversation, publicView, hashOf, ActionError, PENDING_HOURS, UNDO_DAYS };
