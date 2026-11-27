// controllers/assistant.controller.js
//
// Muley's endpoints. A turn (POST /turns) answers on a stream of JSON lines
// (services/assistant/stream/ndjson.js); everything else is plain JSON.
//
// Conversations are private to one person in one view: every lookup names
// the caller, so another person's conversation id reads as missing.

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const logger = require('../logger');
const schoolYearQueries = require('../queries/schoolYear.queries');
const config = require('../services/assistant/config');
const settings = require('../services/assistant/settings');
const store = require('../services/assistant/store');
const aiUsage = require('../services/aiUsage');
const { runTurn } = require('../services/assistant/agentLoop');
const { openStream } = require('../services/assistant/stream/ndjson');
const { available } = require('../middleware/requireAssistant');
const actions = require('../services/assistant/actions/service');
const queries = require('../queries/assistant.queries');
const multer = require('multer');
const attachments = require('../services/assistant/attachments');
const voice = require('../services/assistant/transcribe');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { status: 'failed', message: 'Conversation not found' };

const whoOf = (req) => ({ userId: req.user.userId, view: req.user.role, school: req.user.school });
const failed = (res, status, code, message) => res.status(status).json({ status: 'failed', code, message });

/**
 * The school year this turn works in: the one the app has selected
 * (X-School-Year) when it is this school's, otherwise the active one.
 * /api/assistant is mounted ahead of resolveSchoolYear because a question
 * about a past year is a POST, and that middleware refuses POSTs there.
 */
async function yearOf(req) {
  const header = req.headers['x-school-year'];
  if (header && UUID_RE.test(header)) {
    const { rows } = await db.query(schoolYearQueries.selectYearById, [header]);
    if (rows[0] && rows[0].school === req.user.school) return { schoolYearId: rows[0].school_year_id, label: rows[0].label };
  }
  const { rows } = await db.query(schoolYearQueries.selectActiveYearBySchool, [req.user.school]);
  return rows[0] ? { schoolYearId: rows[0].school_year_id, label: rows[0].label } : null;
}

/** What one stored message shows the person: their words, Muley's words, and what the tools showed. */
const toShown = (message) => {
  if (message.role === 'user') return { id: message.id, role: 'user', text: message.content, at: message.createdAt };
  if (message.role === 'assistant') return message.content ? { id: message.id, role: 'assistant', text: message.content, at: message.createdAt } : null;
  if (message.role === 'tool' && message.display) return { id: message.id, role: 'tool', toolCallId: message.toolCallId, ...message.display, at: message.createdAt };
  return null; // events are for the model
};

// GET /api/assistant/settings: whether to show Muley to this person at all.
// Always 200 for a signed-in account, so the app can hide Muley quietly.
const getSettings = async (req, res) => {
  try {
    const verdict = await available(req);
    if (!verdict.ok) {
      return res.status(200).json({ status: 'success', data: { enabled: false, reason: verdict.code, message: verdict.message } });
    }
    return res.status(200).json({
      status: 'success',
      data: { enabled: true, view: req.access.view, capabilities: { writes: Boolean(verdict.settings.allowWrites) && req.access.view !== 'PARENT' }, maxMessageLength: config.caps().messageChars },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error reading assistant settings');
    return res.status(200).json({ status: 'success', data: { enabled: false, reason: 'ASSISTANT_UNAVAILABLE' } });
  }
};

/**
 * POST /api/assistant/turns
 * Body: { message, conversationId?, choice?: { ref }, attachments?: [{ id, name }] (up to 3, from POST /attachments), pageContext?: { route?, classId? } }
 * Answers 400/404/409/429 as JSON before anything is streamed; once the
 * stream is open every outcome is an event on it, ending with `done`.
 */
const startTurn = async (req, res) => {
  const { message, conversationId, choice, pageContext, attachments: files } = req.body || {};
  const caps = config.caps();
  const text = typeof message === 'string' ? message.trim() : '';

  if (!text) return failed(res, 400, 'MESSAGE_REQUIRED', 'Type a message first.');
  if (text.length > caps.messageChars) return failed(res, 400, 'MESSAGE_TOO_LONG', `Keep a message under ${caps.messageChars} characters.`);
  if (conversationId !== undefined && conversationId !== null && !UUID_RE.test(String(conversationId))) return res.status(404).json(NOT_FOUND);
  if (choice && (typeof choice !== 'object' || (choice.ref !== null && typeof choice.ref !== 'string'))) {
    return failed(res, 400, 'INVALID_CHOICE', 'That choice is not one Muley offered.');
  }
  const attached = Array.isArray(files) ? files : [];
  if (files !== undefined && files !== null && (!Array.isArray(files) || attached.length > 3 || attached.some((f) => !f || !attachments.isId(f.id) || typeof f.name !== 'string'))) {
    return failed(res, 400, 'INVALID_ATTACHMENT', 'Those attachments could not be read. Attach the image again.');
  }

  const who = whoOf(req);
  let conversation;
  let turnId;
  try {
    if (attached.length > 0) {
      const kept = await attachments.ownedBy(who, attached.map((f) => f.id));
      if (attached.some((f) => !kept.has(f.id))) return failed(res, 400, 'ATTACHMENT_GONE', 'That image is no longer there. Attach it again.');
    }
    const verdict = await aiUsage.start({ school: who.school, userId: who.userId, feature: 'assistant' });
    if (!verdict.ok) return failed(res, 429, verdict.code, verdict.message);

    const schoolYear = await yearOf(req);
    conversation = conversationId ? await store.find(conversationId, who) : await store.create(who, schoolYear ? schoolYear.schoolYearId : null);
    if (!conversation) return res.status(404).json(NOT_FOUND);

    turnId = uuidv4();
    if (!(await store.claimTurn(conversation.id, turnId))) {
      return failed(res, 409, 'TURN_IN_PROGRESS', 'Muley is still answering your last message.');
    }

    const stream = openStream(res);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), caps.turnMs);
    // The person closed the panel or lost the connection: stop spending on an answer nobody is reading.
    res.on('close', () => { if (!res.writableFinished) stop.abort(); });

    stream.send({ t: 'start', v: 1, conversationId: conversation.id, turnId });
    let reason = 'error';
    try {
      reason = await runTurn({
        who, access: req.access, token: req.headers.authorization.slice(7), schoolYear, conversation, turnId,
        text, choice: choice || null, pageContext: pageContext && typeof pageContext === 'object' ? pageContext : null,
        attached: attached.map((f) => ({ id: f.id, name: f.name.replace(/[\r\n"]/g, ' ').trim().slice(0, 120) || 'image' })),
        allowWrites: Boolean(req.assistant && req.assistant.settings.allowWrites) && req.access.view !== 'PARENT',
        emit: stream.send, signal: stop.signal,
      });
    } finally {
      clearTimeout(timer);
      await store.releaseTurn(conversation.id, turnId).catch(() => {});
      stream.send({ t: 'done', reason });
      stream.end();
    }
    return undefined;
  } catch (error) {
    logger.error({ err: error }, 'Error starting an assistant turn');
    if (conversation && turnId) await store.releaseTurn(conversation.id, turnId).catch(() => {});
    if (res.headersSent) return res.end();
    return failed(res, 500, 'ASSISTANT_UNAVAILABLE', "Muley can't answer right now. Try again in a moment.");
  }
};

// GET /api/assistant/conversations
const listConversations = async (req, res) => {
  try {
    return res.status(200).json({ status: 'success', data: await store.list(whoOf(req)) });
  } catch (error) {
    logger.error({ err: error }, 'Error listing assistant conversations');
    return res.status(500).json({ status: 'failed', message: 'Error loading conversations' });
  }
};

// GET /api/assistant/conversations/:conversationId
const getConversation = async (req, res) => {
  const { conversationId } = req.params;
  if (!UUID_RE.test(conversationId)) return res.status(404).json(NOT_FOUND);
  try {
    const conversation = await store.find(conversationId, whoOf(req));
    if (!conversation) return res.status(404).json(NOT_FOUND);
    const messages = (await store.transcript(conversation.id)).map(toShown).filter(Boolean);
    const prepared = await actions.forConversation(conversation.id);
    return res.status(200).json({
      status: 'success',
      data: { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, lastMessageAt: conversation.lastMessageAt, messages, actions: prepared },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading an assistant conversation');
    return res.status(500).json({ status: 'failed', message: 'Error loading the conversation' });
  }
};

// PATCH /api/assistant/conversations/:conversationId { title }
const renameConversation = async (req, res) => {
  const { conversationId } = req.params;
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!UUID_RE.test(conversationId)) return res.status(404).json(NOT_FOUND);
  if (!title) return failed(res, 400, 'TITLE_REQUIRED', 'Give the conversation a name.');
  try {
    const renamed = await store.rename(conversationId, title, whoOf(req));
    return renamed ? res.status(200).json({ status: 'success', data: renamed }) : res.status(404).json(NOT_FOUND);
  } catch (error) {
    logger.error({ err: error }, 'Error renaming an assistant conversation');
    return res.status(500).json({ status: 'failed', message: 'Error renaming the conversation' });
  }
};

// DELETE /api/assistant/conversations/:conversationId
const deleteConversation = async (req, res) => {
  const { conversationId } = req.params;
  if (!UUID_RE.test(conversationId)) return res.status(404).json(NOT_FOUND);
  try {
    const removed = await store.remove(conversationId, whoOf(req));
    return removed ? res.status(200).json({ status: 'success', message: 'Conversation deleted' }) : res.status(404).json(NOT_FOUND);
  } catch (error) {
    logger.error({ err: error }, 'Error deleting an assistant conversation');
    return res.status(500).json({ status: 'failed', message: 'Error deleting the conversation' });
  }
};

// ── The school's log ──────────────────────────────────────────

const LOG_STATUSES = ['pending', 'applying', 'applied', 'undoing', 'undone', 'rejected', 'expired', 'failed'];
const KIND_LABELS = { class_attendance: 'Attendance', scores: 'Marks', stats_exclusion: 'Class average', school_asset: 'School image' };
const LOG_PAGE = 50;

// GET /api/assistant/log?status=&kind=&before= (full admins): every change prepared through Muley at
// the school, newest first, with who prepared it, who saved or undid it, and what it changed.
const getSchoolLog = async (req, res) => {
  const { status, kind, before } = req.query;
  if (status !== undefined && !LOG_STATUSES.includes(status)) return failed(res, 400, 'INVALID_STATUS', 'Unknown status');
  if (kind !== undefined && !KIND_LABELS[kind]) return failed(res, 400, 'INVALID_KIND', 'Unknown kind of change');
  if (before !== undefined && Number.isNaN(Date.parse(before))) return failed(res, 400, 'INVALID_BEFORE', 'before must be a time');
  try {
    const { rows } = await db.query(queries.selectSchoolLog, [req.user.school, status || null, kind || null, before || null, LOG_PAGE + 1]);
    const page = rows.slice(0, LOG_PAGE).map((r) => ({
      id: r.action_id,
      kind: r.kind,
      kindLabel: KIND_LABELS[r.kind] || r.kind,
      status: r.status,
      title: r.title,
      // Each student or item the change touched: its name, and the value before and after.
      changes: ((r.preview && r.preview.rows) || []).map((row) => ({ name: row.name, now: row.now ?? null, next: row.next ?? null })),
      written: r.result && typeof r.result.written === 'number' ? r.result.written : null,
      error: r.error_message || null,
      preparedBy: r.person_name,
      preparedAs: r.person_view || null,
      preparedAt: r.created_at,
      savedBy: r.applied_by_name || null,
      savedAt: r.applied_at,
      undoneBy: r.undone_by_name || null,
      undoneAt: r.undone_at,
      expiresAt: r.expires_at,
    }));
    return res.status(200).json({
      status: 'success',
      data: page,
      next: rows.length > LOG_PAGE ? page[page.length - 1].preparedAt : null,
    });
  } catch (error) {
    logger.error({ err: error }, "Error reading the school's assistant log");
    return res.status(500).json({ status: 'failed', message: 'Error loading the log' });
  }
};

// ── Attachments ───────────────────────────────────────────────

const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: attachments.MAX_BYTES, files: 1 } }).single('file');
/** Multer, with its refusals said plainly. */
const receiveAttachment = (req, res, next) => attachmentUpload(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return failed(res, 400, 'FILE_TOO_LARGE', 'Keep the image under 5 MB.');
  return failed(res, 400, 'FILE_REFUSED', 'That file could not be read.');
});

// POST /api/assistant/attachments (multipart, one image as `file`): keep an image for a change
// Muley may prepare, such as a new school stamp. Nothing is changed by it.
const uploadAttachment = async (req, res) => {
  if (!req.assistant || !req.assistant.settings.allowWrites || req.access.view === 'PARENT') return failed(res, 403, 'WRITES_OFF', "Your school hasn't switched on saving changes through Muley.");
  if (!req.file) return failed(res, 400, 'FILE_REQUIRED', 'Attach an image.');
  try {
    return res.status(201).json({ status: 'success', data: await attachments.store(whoOf(req), req.file) });
  } catch (err) {
    if (err.status === 400) return failed(res, 400, err.code, err.message);
    logger.error({ err }, 'Error keeping an image attached in Muley');
    return res.status(500).json({ status: 'failed', message: "The image couldn't be uploaded. Try again." });
  }
};

// ── Voice ─────────────────────────────────────────────────────

const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: voice.MAX_BYTES, files: 1 } }).single('audio');
/** Multer, with its refusals said plainly. */
const receiveAudio = (req, res, next) => audioUpload(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return failed(res, 400, 'AUDIO_TOO_LONG', 'That recording is too long. Keep it under two minutes.');
  return failed(res, 400, 'AUDIO_REFUSED', "That recording couldn't be read.");
});

// POST /api/assistant/transcribe (multipart, one recording as `audio`): the words, for the composer.
// The person reads them before sending; nothing is stored. Counted against the AI limits like a turn.
const transcribeAudio = async (req, res) => {
  if (!req.file) return failed(res, 400, 'AUDIO_REQUIRED', 'Record something first.');
  const who = whoOf(req);
  try {
    const verdict = await aiUsage.start({ school: who.school, userId: who.userId, feature: 'assistant_voice' });
    if (!verdict.ok) return failed(res, 429, verdict.code, verdict.message);
    const { text, usage } = await voice.transcribe({ buffer: req.file.buffer, mimetype: req.file.mimetype });
    await aiUsage.record({
      school: who.school, userId: who.userId, feature: 'assistant_voice',
      inputTokens: usage && usage.input_tokens ? usage.input_tokens : 0, cachedInputTokens: 0, outputTokens: usage && usage.output_tokens ? usage.output_tokens : 0,
    }).catch(() => {});
    if (!text) return failed(res, 422, 'NOTHING_HEARD', "Muley didn't catch any words. Try again a little closer to the microphone.");
    return res.status(200).json({ status: 'success', data: { text } });
  } catch (err) {
    if (err instanceof voice.TranscribeError) return failed(res, err.status, err.code, err.message);
    logger.error({ err }, 'Error turning a recording into text');
    return res.status(500).json({ status: 'failed', message: "Your recording couldn't be turned into text. Try again." });
  }
};

// ── Prepared changes ──────────────────────────────────────────

const actionFailed = (res, err) => {
  if (err instanceof actions.ActionError) {
    // The differences (conflicts) and the action as it now stands go in `data`, where the apps' API clients keep them.
    return res.status(err.status).json({ status: 'failed', code: err.code, message: err.message, data: err.extra });
  }
  logger.error({ err }, 'Error handling an assistant action');
  return res.status(500).json({ status: 'failed', code: 'ACTION_FAILED', message: 'That could not be done. Nothing was changed.' });
};
const writesOn = (req, res) => {
  if (req.assistant && req.assistant.settings.allowWrites && req.access.view !== 'PARENT') return true;
  failed(res, 403, 'WRITES_OFF', "Your school hasn't switched on saving changes through Muley.");
  return false;
};
const actionRequest = (req) => ({
  actionId: req.params.actionId,
  who: whoOf(req),
  token: req.headers.authorization.slice(7),
  idempotencyKey: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].slice(0, 100) : null,
  requestId: req.id ? String(req.id) : 'assistant-action',
});

// GET /api/assistant/actions/:actionId
const getAction = async (req, res) => {
  if (!UUID_RE.test(req.params.actionId)) return failed(res, 404, 'ACTION_NOT_FOUND', 'That change was not found.');
  try {
    return res.status(200).json({ status: 'success', data: await actions.get({ actionId: req.params.actionId, who: whoOf(req) }) });
  } catch (err) {
    return actionFailed(res, err);
  }
};

// POST /api/assistant/actions/:actionId/apply { expectedHash }: the person pressed Apply.
const applyAction = async (req, res) => {
  if (!UUID_RE.test(req.params.actionId)) return failed(res, 404, 'ACTION_NOT_FOUND', 'That change was not found.');
  if (!writesOn(req, res)) return undefined;
  try {
    const action = await actions.apply({ ...actionRequest(req), expectedHash: req.body && req.body.expectedHash });
    return res.status(200).json({ status: 'success', data: action });
  } catch (err) {
    return actionFailed(res, err);
  }
};

// POST /api/assistant/actions/:actionId/undo: the person pressed Undo.
const undoAction = async (req, res) => {
  if (!UUID_RE.test(req.params.actionId)) return failed(res, 404, 'ACTION_NOT_FOUND', 'That change was not found.');
  if (!writesOn(req, res)) return undefined;
  try {
    return res.status(200).json({ status: 'success', data: await actions.undo(actionRequest(req)) });
  } catch (err) {
    return actionFailed(res, err);
  }
};

// POST /api/assistant/actions/:actionId/dismiss: the person doesn't want it.
const dismissAction = async (req, res) => {
  if (!UUID_RE.test(req.params.actionId)) return failed(res, 404, 'ACTION_NOT_FOUND', 'That change was not found.');
  try {
    return res.status(200).json({ status: 'success', data: await actions.dismiss({ actionId: req.params.actionId, who: whoOf(req) }) });
  } catch (err) {
    return actionFailed(res, err);
  }
};

const SCHOOL_CODE = /^[A-Z0-9_]{2,60}$/;

// GET /api/assistant/platform/settings (platform owner): every school, its switches and its last 30 days.
const listSchoolSettings = async (req, res) => {
  try {
    const { rows } = await db.query(queries.selectSchoolsWithSettings);
    const data = rows.map((r) => ({
      school: r.school,
      name: r.name,
      settings: r.enabled === null
        ? { ...settings.OFF }
        : {
            enabled: r.enabled, roleTeacher: r.role_teacher, roleAdmin: r.role_admin, roleParent: r.role_parent,
            allowWrites: r.allow_writes, allowOutward: r.allow_outward, selfServe: r.self_serve, transcriptRetentionDays: r.transcript_retention_days,
          },
      updatedAt: r.updated_at,
      lastThirtyDays: { conversations: r.conversations_30d, people: r.people_30d, changesSaved: r.changes_saved_30d },
    }));
    return res.status(200).json({ status: 'success', data, killSwitch: !config.enabled() });
  } catch (error) {
    logger.error({ err: error }, 'Error listing the schools\' assistant settings');
    return res.status(500).json({ status: 'failed', message: 'Error loading the settings' });
  }
};

// GET /api/assistant/platform/settings/:school (platform owner)
const getSchoolSettings = async (req, res) => {
  const school = String(req.params.school || '').toUpperCase();
  if (!SCHOOL_CODE.test(school)) return failed(res, 404, 'SCHOOL_NOT_FOUND', 'School not found');
  try {
    // Compared as text: a code that isn't one of the school enum's values is "not found", not an error.
    const { rows } = await db.query('SELECT 1 FROM schools WHERE school_code::text = $1', [school]);
    if (rows.length === 0) return failed(res, 404, 'SCHOOL_NOT_FOUND', 'School not found');
    return res.status(200).json({ status: 'success', data: await settings.get(school) });
  } catch (error) {
    logger.error({ err: error }, 'Error reading a school\'s assistant settings');
    return res.status(500).json({ status: 'failed', message: 'Error loading the settings' });
  }
};

// PUT /api/assistant/platform/settings/:school (platform owner): switch Muley on or off for a school and its views.
const saveSchoolSettings = async (req, res) => {
  const school = String(req.params.school || '').toUpperCase();
  if (!SCHOOL_CODE.test(school)) return failed(res, 404, 'SCHOOL_NOT_FOUND', 'School not found');
  try {
    // Compared as text: a code that isn't one of the school enum's values is "not found", not an error.
    const { rows } = await db.query('SELECT 1 FROM schools WHERE school_code::text = $1', [school]);
    if (rows.length === 0) return failed(res, 404, 'SCHOOL_NOT_FOUND', 'School not found');
    const saved = await settings.save(school, req.body || {}, req.user.userId);
    return res.status(200).json({ status: 'success', data: saved });
  } catch (error) {
    logger.error({ err: error }, 'Error saving a school\'s assistant settings');
    return res.status(500).json({ status: 'failed', message: 'Error saving the settings' });
  }
};

module.exports = {
  getSettings, startTurn, listConversations, getConversation, renameConversation, deleteConversation,
  getAction, applyAction, undoAction, dismissAction,
  getSchoolSettings, saveSchoolSettings, listSchoolSettings,
  receiveAttachment, uploadAttachment, getSchoolLog,
  receiveAudio, transcribeAudio,
};
