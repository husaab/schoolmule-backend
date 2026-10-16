/*
  controllers/classwork.controller.js
  Classwork for staff (/api/classroom): items, topics, attachments and copy
  from another class. Class routes run requireClassOwnership; item, topic and
  attachment routes run requireClassroomResource, which applies the same
  rule to the resource's class. The flows themselves live in
  services/classroom/classworkItems.js.
*/

const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const engine = require('../services/analyticsEngine');
const q = require('../queries/classwork.queries');
const items = require('../services/classroom/classworkItems');
const { classLabel } = require('../services/classroom/classCards');
const {
  BUCKET, MAX_ATTACHMENTS_PER_ITEM, classworkFilePath, parseLinkUrl, parseLinkTitle,
} = require('../utils/classworkUpload');
const { signedUrlMap, removeObjects } = require('../utils/attachmentUpload');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOPIC_NAME_MAX = 80;
const MAX_COPY_ITEMS = 200;

const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });
const has = (body, key) => Boolean(body) && Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
const isObject = (body) => Boolean(body) && typeof body === 'object' && !Array.isArray(body);

/** A service error (httpError) answers with its own status; anything else is logged as a 500. */
function fail(res, error, userMessage, context) {
  if (error && error.expose && error.status) return failed(res, error.status, error.message);
  logger.error({ err: error, ...context }, userMessage);
  return failed(res, 500, userMessage);
}

/** Scores or weights changed: the cached grade matrices are stale. */
const gradebookTouched = (school, changed) => { if (changed) engine.invalidateCache(school); };

// ── Items ─────────────────────────────────────────────────────────────────

// GET /api/classroom/classes/:classId/items?topic=<uuid|none>&kind=<ItemKind>
const listItems = async (req, res) => {
  const { classId } = req.class;
  const topic = req.query.topic ? String(req.query.topic).toLowerCase() : null;
  const kind = req.query.kind ? String(req.query.kind) : null;
  if (topic && topic !== 'none' && !UUID_RE.test(topic)) return failed(res, 400, 'topic must be a topic id or none');
  if (kind && !items.ITEM_KINDS.includes(kind)) return failed(res, 400, 'kind must be assessment, assignment, quiz or material');
  try {
    const [itemRes, ctx] = await Promise.all([
      db.query(q.selectClassItems, [classId, topic, kind]),
      items.loadContext(db, classId),
    ]);
    return ok(res, {
      topics: ctx.topicRows.map(items.toTopic),
      items: await items.withClassAverages(itemRes.rows.map(items.toItemSummary), classId),
      categories: ctx.categoryRows.map(items.toCategoryOption),
      linkableColumns: ctx.columnRows.map(items.toColumnOption),
    });
  } catch (error) {
    return fail(res, error, 'Error loading the classwork', { classId });
  }
};

// POST /api/classroom/classes/:classId/items  ItemInput
const createItem = async (req, res) => {
  const { classId, school } = req.class;
  if (!isObject(req.body)) return failed(res, 400, 'Send the item as JSON');
  try {
    const result = await items.inTransaction(async (client) => {
      const ctx = await items.loadContext(client, classId);
      const checked = items.validateItemInput(req.body, ctx);
      if (checked.error) throw items.httpError(400, checked.error);
      return items.createItem(client, { classId, userId: req.user.userId, value: checked.value });
    });
    gradebookTouched(school, result.gradebookChanged);
    return ok(res, await items.loadItem(result.itemId), 201);
  } catch (error) {
    return fail(res, error, 'Error creating the item', { classId });
  }
};

// GET /api/classroom/items/:itemId
const getItem = async (req, res) => {
  try {
    const item = await items.loadItem(req.item.itemId);
    if (!item) return failed(res, 404, 'Item not found');
    return ok(res, item);
  } catch (error) {
    return fail(res, error, 'Error loading the item', { itemId: req.item.itemId });
  }
};

/** The item's ITEM_SELECT row, locked for the transaction; 404 when it is gone. */
async function lockedItemRow(client, itemId) {
  const locked = await client.query(q.lockItem, [itemId]);
  if (!locked.rows[0]) throw items.httpError(404, 'Item not found');
  const { rows } = await client.query(q.selectItem, [itemId]);
  return rows[0];
}

// PATCH /api/classroom/items/:itemId  partial ItemInput
const updateItem = async (req, res) => {
  const { itemId } = req.item;
  const { classId, school } = req.class;
  if (!isObject(req.body) || Object.keys(req.body).length === 0) return failed(res, 400, 'Send the fields to change');
  try {
    const result = await items.inTransaction(async (client) => {
      const row = await lockedItemRow(client, itemId);
      const studentIds = (await client.query(q.selectItemStudentIds, [itemId])).rows.map((r) => r.student_id);
      const cur = items.toCurrent(row, studentIds);
      const ctx = await items.loadContext(client, classId);
      const checked = items.validateItemInput(req.body, { ...ctx, current: cur });
      if (checked.error) throw items.httpError(400, checked.error);
      return items.updateItem(client, { classId, userId: req.user.userId, row, cur, value: checked.value });
    });
    gradebookTouched(school, result.gradebookChanged);
    return ok(res, await items.loadItem(itemId));
  } catch (error) {
    return fail(res, error, 'Error saving the item', { itemId });
  }
};

// DELETE /api/classroom/items/:itemId
// An ungraded item is hidden; a graded one takes its gradebook column (and
// the scores in it) along, and its category refills.
const deleteItem = async (req, res) => {
  const { itemId } = req.item;
  const { school } = req.class;
  try {
    const { removedColumn, orphanFiles } = await items.inTransaction(async (client) => {
      const row = await lockedItemRow(client, itemId);
      // A plain assessment's row is removed outright, attachments with it.
      const hard = row.kind === 'assessment' && row.assessment_id;
      const files = hard
        ? (await client.query(q.selectAttachments, [itemId])).rows.filter((a) => a.kind === 'file').map((a) => a.file_path)
        : [];
      const out = await items.deleteItem(client, { row });
      return { ...out, orphanFiles: files };
    });
    await removeObjects(orphanFiles);
    gradebookTouched(school, removedColumn);
    return ok(res, { deleted: true, removedColumn });
  } catch (error) {
    return fail(res, error, 'Error deleting the item', { itemId });
  }
};

// ── Topics ────────────────────────────────────────────────────────────────

/** A topic name: trimmed, 1–80 characters. */
function topicName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > TOPIC_NAME_MAX) return { error: `A topic name is 1 to ${TOPIC_NAME_MAX} characters` };
  return { value: name };
}

const topicReply = async (res, topicId, status = 200) => {
  const { rows } = await db.query(q.selectTopic, [topicId]);
  if (!rows[0]) return failed(res, 404, 'Topic not found');
  return ok(res, items.toTopic(rows[0]), status);
};

// GET /api/classroom/classes/:classId/topics
const listTopics = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectTopics, [req.class.classId]);
    return ok(res, rows.map(items.toTopic));
  } catch (error) {
    return fail(res, error, 'Error loading the topics', { classId: req.class.classId });
  }
};

// POST /api/classroom/classes/:classId/topics  { name }
const createTopic = async (req, res) => {
  const name = topicName(req.body?.name);
  if (name.error) return failed(res, 400, name.error);
  try {
    const { rows } = await db.query(q.insertTopic, [req.class.classId, name.value]);
    return await topicReply(res, rows[0].topic_id, 201);
  } catch (error) {
    return fail(res, error, 'Error creating the topic', { classId: req.class.classId });
  }
};

// PATCH /api/classroom/topics/:topicId  { name?, sortOrder? }
const updateTopic = async (req, res) => {
  const body = req.body || {};
  if (!has(body, 'name') && !has(body, 'sortOrder')) return failed(res, 400, 'Send a name or sortOrder');
  let name = null;
  if (has(body, 'name')) {
    const parsed = topicName(body.name);
    if (parsed.error) return failed(res, 400, parsed.error);
    name = parsed.value;
  }
  if (has(body, 'sortOrder') && !(Number.isInteger(body.sortOrder) && body.sortOrder >= 0 && body.sortOrder <= 10000)) {
    return failed(res, 400, 'sortOrder must be a whole number from 0');
  }
  try {
    await db.query(q.updateTopic, [req.topic.topicId, name, has(body, 'sortOrder') ? body.sortOrder : null]);
    return await topicReply(res, req.topic.topicId);
  } catch (error) {
    return fail(res, error, 'Error saving the topic', { topicId: req.topic.topicId });
  }
};

// DELETE /api/classroom/topics/:topicId  (its items stay, with no topic)
const deleteTopic = async (req, res) => {
  try {
    await db.query(q.deleteTopic, [req.topic.topicId]);
    return ok(res, { deleted: true });
  } catch (error) {
    return fail(res, error, 'Error deleting the topic', { topicId: req.topic.topicId });
  }
};

// POST /api/classroom/classes/:classId/topics/reorder  { topicIds } (every topic of the class, once)
const reorderTopics = async (req, res) => {
  const { classId } = req.class;
  const ids = req.body?.topicIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    return failed(res, 400, 'topicIds must be a list of topic ids');
  }
  const wanted = ids.map((id) => id.toLowerCase());
  try {
    const { rows } = await db.query(q.selectTopics, [classId]);
    const current = new Set(rows.map((r) => r.topic_id));
    if (new Set(wanted).size !== wanted.length || wanted.length !== current.size || wanted.some((id) => !current.has(id))) {
      return failed(res, 400, 'Send every topic of this class once, in the new order');
    }
    await db.query(q.reorderTopics, [classId, wanted]);
    const { rows: after } = await db.query(q.selectTopics, [classId]);
    return ok(res, after.map(items.toTopic));
  } catch (error) {
    return fail(res, error, 'Error reordering the topics', { classId });
  }
};

// ── Attachments ───────────────────────────────────────────────────────────

/** Attachment rows → Attachment[], files signed for an hour. */
async function attachmentsReply(rows) {
  const signed = await signedUrlMap(rows.filter((r) => r.kind === 'file').map((r) => r.file_path));
  return rows.map((r) => items.toAttachment(r, signed.get(r.file_path) ?? null));
}

const TOO_MANY = `An item holds at most ${MAX_ATTACHMENTS_PER_ITEM} attachments`;

/** Inside the insert's transaction: the item row is locked, so concurrent adds can't pass the cap together. */
async function assertRoom(client, itemId, adding) {
  await client.query(q.lockItemRow, [itemId]);
  const { rows } = await client.query(q.countAttachments, [itemId]);
  if (rows[0].n + adding > MAX_ATTACHMENTS_PER_ITEM) throw items.httpError(400, TOO_MANY);
}

// POST /api/classroom/items/:itemId/attachments  multipart "files" (≤ 5 × 10 MB)
// Objects are stored first, rows written in one transaction; a failure
// removes whatever was stored.
const uploadAttachments = async (req, res) => {
  const { itemId } = req.item;
  const { school } = req.class;
  const uploaded = [];
  try {
    const rows = await items.inTransaction(async (client) => {
      await assertRoom(client, itemId, req.files.length);
      const out = [];
      for (const f of req.files) {
        const filePath = classworkFilePath(school, itemId, f.originalname);
        const { error } = await supabase.storage.from(BUCKET).upload(filePath, f.buffer, { contentType: f.mimetype, upsert: false });
        if (error) throw new Error(`Upload failed: ${error.message}`);
        uploaded.push(filePath);
        const { rows: [row] } = await client.query(q.insertFileAttachment, [itemId, filePath, f.originalname, f.mimetype, f.size, req.user.userId]);
        out.push(row);
      }
      await client.query(q.touchItem, [itemId]);
      return out;
    });
    return ok(res, await attachmentsReply(rows), 201);
  } catch (error) {
    await removeObjects(uploaded);
    return fail(res, error, 'Error uploading the files', { itemId });
  }
};

// POST /api/classroom/items/:itemId/links  { title?, url }
const addLink = async (req, res) => {
  const { itemId } = req.item;
  const url = parseLinkUrl(req.body?.url);
  if (!url) return failed(res, 400, 'Enter a link that starts with http:// or https://');
  const title = parseLinkTitle(req.body?.title);
  if (title.error) return failed(res, 400, title.error);
  try {
    const row = await items.inTransaction(async (client) => {
      await assertRoom(client, itemId, 1);
      const { rows } = await client.query(q.insertLinkAttachment, [itemId, url, title.value, req.user.userId]);
      await client.query(q.touchItem, [itemId]);
      return rows[0];
    });
    return ok(res, items.toAttachment(row), 201);
  } catch (error) {
    return fail(res, error, 'Error adding the link', { itemId });
  }
};

// PATCH /api/classroom/attachments/:attachmentId  { title?, url? } (url for links only)
const updateAttachment = async (req, res) => {
  const { attachmentId, itemId, kind } = req.attachment;
  const body = req.body || {};
  if (!has(body, 'title') && !has(body, 'url')) return failed(res, 400, 'Send a title or url');
  let url = null;
  if (has(body, 'url')) {
    if (kind !== 'link') return failed(res, 400, 'Only a link has a URL; replace the file instead');
    url = parseLinkUrl(body.url);
    if (!url) return failed(res, 400, 'Enter a link that starts with http:// or https://');
  }
  const title = has(body, 'title') ? parseLinkTitle(body.title) : { value: null };
  if (title.error) return failed(res, 400, title.error);
  try {
    const row = await items.inTransaction(async (client) => {
      const { rows } = await client.query(q.updateAttachment, [attachmentId, has(body, 'title'), title.value, url]);
      await client.query(q.touchItem, [itemId]);
      return rows[0];
    });
    return ok(res, (await attachmentsReply([row]))[0]);
  } catch (error) {
    return fail(res, error, 'Error saving the attachment', { attachmentId });
  }
};

// PUT /api/classroom/attachments/:attachmentId/file  multipart "file"
// The new object is stored, the row repointed, then the old object removed.
const replaceAttachmentFile = async (req, res) => {
  const { attachmentId, itemId, kind } = req.attachment;
  const { school } = req.class;
  if (kind !== 'file') return failed(res, 400, 'A link has no file to replace; edit its URL instead');
  const f = req.file;
  const filePath = classworkFilePath(school, itemId, f.originalname);
  try {
    const { error } = await supabase.storage.from(BUCKET).upload(filePath, f.buffer, { contentType: f.mimetype, upsert: false });
    if (error) throw new Error(`Upload failed: ${error.message}`);
  } catch (error) {
    return fail(res, error, 'Error uploading the file', { attachmentId });
  }
  try {
    const row = await items.inTransaction(async (client) => {
      const { rows } = await client.query(q.replaceAttachmentFile, [attachmentId, filePath, f.originalname, f.mimetype, f.size]);
      await client.query(q.touchItem, [itemId]);
      return rows[0];
    });
    if (!row) {
      await removeObjects([filePath]);
      return failed(res, 404, 'Attachment not found');
    }
    if (row.old_path && row.old_path !== filePath) await removeObjects([row.old_path]);
    return ok(res, (await attachmentsReply([row]))[0]);
  } catch (error) {
    await removeObjects([filePath]);
    return fail(res, error, 'Error replacing the file', { attachmentId });
  }
};

// DELETE /api/classroom/attachments/:attachmentId
const deleteAttachment = async (req, res) => {
  const { attachmentId, itemId } = req.attachment;
  try {
    const row = await items.inTransaction(async (client) => {
      const { rows } = await client.query(q.deleteAttachment, [attachmentId]);
      await client.query(q.touchItem, [itemId]);
      return rows[0];
    });
    if (row?.kind === 'file' && row.file_path) await removeObjects([row.file_path]);
    return ok(res, { deleted: true });
  } catch (error) {
    return fail(res, error, 'Error removing the attachment', { attachmentId });
  }
};

// GET /api/classroom/attachments/:attachmentId/url
// A signed URL (1 h) for a file; the link itself for a link.
const attachmentUrl = async (req, res) => {
  const { attachmentId } = req.attachment;
  try {
    const { rows } = await db.query(q.selectAttachment, [attachmentId]);
    const row = rows[0];
    if (!row) return failed(res, 404, 'Attachment not found');
    if (row.kind === 'link') return ok(res, { url: row.url });
    return ok(res, { url: await items.signedFileUrl(row.file_path) });
  } catch (error) {
    return fail(res, error, 'Error opening the attachment', { attachmentId });
  }
};

// ── Copy from another class ───────────────────────────────────────────────

// GET /api/classroom/classes/:classId/copy-sources
// The caller's other classes in this class's year (admins: every class).
const copySources = async (req, res) => {
  const { classId, school } = req.class;
  const { userId, role } = req.user;
  try {
    const { rows: [cls] } = await db.query(q.selectClassSchoolYear, [classId]);
    const { rows } = await db.query(q.selectCopySources, [userId, school, role, cls?.school_year_id ?? null, classId]);
    return ok(res, {
      classes: rows.map((r) => {
        const label = classLabel(r.grade, r.subject);
        return { classId: r.class_id, label: r.term_name ? `${label} · ${r.term_name}` : label, itemCount: Number(r.item_count) || 0 };
      }),
    });
  } catch (error) {
    return fail(res, error, 'Error loading the classes to copy from', { classId });
  }
};

// POST /api/classroom/classes/:classId/copy  { sourceClassId, itemIds?, includeTopics? = true }
// Copies classwork as drafts: graded items under the category of the same
// name, else ungraded (plain assessments are skipped), with warnings.
const copyFromClass = async (req, res) => {
  const { classId, school } = req.class;
  const { userId, role } = req.user;
  const body = req.body || {};
  const sourceClassId = typeof body.sourceClassId === 'string' ? body.sourceClassId.toLowerCase() : '';
  if (!UUID_RE.test(sourceClassId)) return failed(res, 400, 'Choose a class to copy from');
  if (sourceClassId === classId) return failed(res, 400, 'Choose another class to copy from');
  let itemIds = null;
  if (has(body, 'itemIds')) {
    if (!Array.isArray(body.itemIds) || body.itemIds.length === 0 || body.itemIds.length > MAX_COPY_ITEMS
      || body.itemIds.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
      return failed(res, 400, `itemIds must list 1 to ${MAX_COPY_ITEMS} items`);
    }
    itemIds = [...new Set(body.itemIds.map((id) => id.toLowerCase()))];
  }
  if (has(body, 'includeTopics') && typeof body.includeTopics !== 'boolean') return failed(res, 400, 'includeTopics must be true or false');
  const includeTopics = has(body, 'includeTopics') ? body.includeTopics : true;

  const copied = [];
  try {
    const { rows: [source] } = await db.query(q.selectSourceClass, [sourceClassId, userId]);
    if (!source) return failed(res, 404, 'Class not found');
    const teaches = source.teacher_id === userId || source.is_co_teacher;
    if (source.school !== school || (role !== 'ADMIN' && !teaches)) return failed(res, 403, 'Not authorized for that class');

    const result = await items.inTransaction((client) => items.copyClasswork(client, {
      sourceClassId, targetClassId: classId, school, userId, itemIds, includeTopics, copied,
    }));
    gradebookTouched(school, result.gradebookChanged);
    const { rows } = result.itemIds.length ? await db.query(q.selectItemsByIds, [result.itemIds]) : { rows: [] };
    return ok(res, { copied: result.itemIds.length, items: rows.map(items.toItemSummary), warnings: result.warnings });
  } catch (error) {
    await removeObjects(copied);
    return fail(res, error, 'Error copying the classwork', { classId, sourceClassId });
  }
};

module.exports = {
  listItems, createItem, getItem, updateItem, deleteItem,
  listTopics, createTopic, updateTopic, deleteTopic, reorderTopics,
  uploadAttachments, addLink, updateAttachment, replaceAttachmentFile, deleteAttachment, attachmentUrl,
  copySources, copyFromClass,
};
