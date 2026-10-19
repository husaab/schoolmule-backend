/*
  controllers/studentMessaging.controller.js
  Students message their teachers (/api/student/conversations, spec D14).

  This is the existing parent–teacher messaging with the student added: every
  thread a student starts or comments in includes the student
  (includes_student) and their guardians are always derived in, so a student
  can never talk to a teacher without their parents. The only exception is a
  school setting that keeps item threads ("messages about this work") from
  guardians. A student reaches only their own current teachers (lead and
  co-teachers of their current-term classes, and the homeroom teacher), never
  another student, and never sees an older parent–teacher thread about them.

  requireStudent runs first (req.student = the caller's own student row); the
  :conversationId routes then run requireStudentConversationAccess. Nothing
  here takes a student id from the client. Emails ride the existing coalesced
  message digests (services/messageNotifier.js).
*/

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/messaging.queries');
const work = require('../services/classroom/studentWork');
const { isMember } = require('../middleware/requireConversationAccess');
const m = require('./messaging.controller');

const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });
const failed = (res, status, message, code) => res.status(status).json({ status: 'failed', message, ...(code ? { code } : {}) });

const MESSAGES = Object.freeze({
  NOT_YOUR_TEACHER: 'You can message your own teachers only.',
  NOT_THAT_CLASS: "That teacher doesn't teach you in this class.",
  CLASS_REQUIRED: 'Choose which class this message is about.',
  SUBJECT: `Subject must be 1–${m.MAX_TITLE} characters`,
  BODY: `Message must be 1–${m.MAX_BODY} characters`,
  ITEM_NOT_FOUND: 'Item not found',
  NO_THREAD_HERE: 'Messages about work are for assignments and quizzes.',
  DELETE_WINDOW: 'Messages can be removed for 15 minutes after sending',
});

const STATUSES = ['open', 'resolved'];
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const yearOf = (req) => req.schoolYear?.schoolYearId ?? req.student.schoolYearId ?? null;

/** Marks the thread read for the caller (and cancels their pending email); an admin's "View as" preview writes nothing. */
async function markReadFor(req, conversationId) {
  if (req.user.impersonator) return;
  await db.query(q.upsertParticipantRead, [conversationId, req.user.userId]);
  await db.query(q.cancelPendingJob, [conversationId, req.user.userId]);
}

/** The teachers the student may write to, and the guardians who will be in the thread. */
async function loadTargets(req) {
  const term = await m.resolveCurrentTerm(req);
  const { studentId } = req.student;
  const [{ rows: teachers }, { rows: guardians }] = await Promise.all([
    db.query(q.selectStudentTeacherTargets, [studentId, yearOf(req), ...m.termParams(term)]),
    db.query(q.selectStudentGuardians, [studentId]),
  ]);
  return {
    teachers: teachers.map((t) => ({ userId: t.user_id, name: t.name, avatar: t.avatar ?? null, classes: t.classes || [] })),
    guardians: guardians.map((g) => ({ name: g.name, relation: g.relation ?? null })),
  };
}

// GET /api/student/conversations?status=open|resolved&classId=&q=&unread=1&limit=
// The student's own threads (every status unless one is asked for).
const listConversations = async (req, res) => {
  const { userId, school } = req.user;
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  if (m.badId(req.query.classId)) return failed(res, 400, 'Invalid id');
  try {
    const { rows } = await db.query(q.listForStudent, [
      userId, school, yearOf(req), status, req.query.classId || null, null,
      req.query.q ? String(req.query.q).trim() || null : null, limit, req.query.unread === '1',
    ]);
    return ok(res, { items: rows.map((r) => ({ ...m.toItem(r), needsReply: m.needsReplyFor('STUDENT', r) })) });
  } catch (error) {
    logger.error({ err: error, userId }, 'Error listing student conversations');
    return failed(res, 500, 'Error loading your messages');
  }
};

// GET /api/student/conversations/unread-count → { unreadConversations, unreadMessages }
const getUnreadCount = async (req, res) => {
  try {
    const { rows: [r] } = await db.query(q.selectStudentUnreadSummary, [req.user.userId, req.user.school, yearOf(req)]);
    return ok(res, { unreadConversations: r?.unread_conversations ?? 0, unreadMessages: r?.unread_messages ?? 0 });
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Error loading the student unread count');
    return failed(res, 500, 'Error loading your messages');
  }
};

// GET /api/student/conversations/targets → { teachers, guardians }
const getTargets = async (req, res) => {
  try {
    return ok(res, await loadTargets(req));
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Error loading the student message targets');
    return failed(res, 500, 'Error loading your teachers');
  }
};

// POST /api/student/conversations  { teacherId, classId?, subject, body }
// A new thread with one of the student's own teachers; the student's
// guardians are in it from the first message. The thread is filed under the
// class it is about, never a guess (Fable M3): classId is required when the
// teacher teaches the student in more than one class (400 CLASS_REQUIRED);
// with one class it is that class, with none (the homeroom teacher) no class.
const createConversation = async (req, res) => {
  const body = req.body || {};
  const teacherId = typeof body.teacherId === 'string' ? body.teacherId.toLowerCase() : body.teacherId;
  const classId = body.classId ? String(body.classId).toLowerCase() : null;
  if (!teacherId || !m.isUuid(teacherId)) return failed(res, 400, 'teacherId is required');
  if (m.badId(classId)) return failed(res, 400, 'Invalid id');
  const subject = text(body.subject);
  if (!subject || subject.length > m.MAX_TITLE) return failed(res, 400, MESSAGES.SUBJECT);
  const message = text(body.body);
  if (!message || message.length > m.MAX_BODY) return failed(res, 400, MESSAGES.BODY);

  try {
    const { teachers } = await loadTargets(req);
    const teacher = teachers.find((t) => t.userId === teacherId);
    if (!teacher) return failed(res, 403, MESSAGES.NOT_YOUR_TEACHER);
    let anchorClassId = teacher.classes.length === 1 ? teacher.classes[0].classId : null;
    if (classId) {
      if (!teacher.classes.some((c) => c.classId === classId)) return failed(res, 400, MESSAGES.NOT_THAT_CLASS);
      anchorClassId = classId;
    } else if (teacher.classes.length > 1) {
      return failed(res, 400, MESSAGES.CLASS_REQUIRED, 'CLASS_REQUIRED');
    }

    const { rows: [c] } = await db.query(q.insertStudentConversation, [
      req.user.school, req.student.studentId, anchorClassId, teacherId, subject, req.user.userId,
    ]);
    const conv = await m.loadConversation(c.conversation_id);
    await m.persistMessage({ conversationId: conv.conversationId, school: req.user.school, sender: req.user, body: message });
    await m.queueEmails(conv, req.user.userId);
    return ok(res, await m.buildThread(await m.loadConversation(conv.conversationId), req.user), 201);
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Error starting a student conversation');
    return failed(res, 500, 'Error sending message');
  }
};

// GET /api/student/conversations/:conversationId → Thread (and marks it read)
const getConversation = async (req, res) => {
  try {
    await markReadFor(req, req.conversation.conversationId);
    return ok(res, await m.buildThread(req.conversation, req.user));
  } catch (error) {
    logger.error({ err: error, conversationId: req.conversation.conversationId }, 'Error loading a student conversation');
    return failed(res, 500, 'Error loading conversation');
  }
};

// DELETE /api/student/conversations/:conversationId/messages/:messageId
// A student removes their own message within 15 minutes of sending it (the
// edit window): their parents are in the thread, and what was said there
// stays. The rest is messaging's own delete.
const deleteMessage = async (req, res, next) => {
  try {
    const { rows: [msg] } = await db.query(q.selectMessageForMutation, [req.params.messageId, req.conversation.conversationId]);
    if (msg && msg.kind === 'message' && msg.sender_id === req.user.userId && !msg.deleted_at
        && Date.now() - new Date(msg.created_at).getTime() > m.EDIT_WINDOW_MS) {
      return failed(res, 403, MESSAGES.DELETE_WINDOW);
    }
    return m.deleteMessage(req, res, next);
  } catch (error) {
    logger.error({ err: error }, 'Error removing a student message');
    return failed(res, 500, 'Error removing message');
  }
};

// ── Messages about one piece of work ("private comments") ────────────────

/** The item when the student can see it and it takes a thread; else { status, message }. */
async function loadThreadItem(req) {
  const row = await work.findVisibleItem({ studentId: req.student.studentId, school: req.user.school, itemId: req.params.itemId });
  if (!row) return { error: [404, MESSAGES.ITEM_NOT_FOUND] };
  return { row, takesThread: work.takesThread(row.kind) };
}

/**
 * The student's thread about the item (keyed on their own row) as the access
 * shape: { conv } when there is one they are in, {} when there is none yet,
 * { refused: true } when one exists that they are not in.
 */
async function loadItemConversation(req, conversationId = null) {
  let id = conversationId;
  if (!id) {
    const { rows: [t] } = await db.query(q.findClassworkThread, [req.student.studentId, req.params.itemId]);
    if (!t) return {};
    id = t.conversation_id;
  }
  const conv = await m.loadConversation(id);
  if (!conv || conv.school !== req.user.school || !isMember(conv, req.user)) return { refused: true };
  return { conv };
}

// GET /api/student/items/:itemId/thread → { thread: Thread | null } (marks it read)
const getItemThread = async (req, res) => {
  try {
    const { error, takesThread } = await loadThreadItem(req);
    if (error) return failed(res, error[0], error[1]);
    if (!takesThread) return ok(res, { thread: null });
    const { conv } = await loadItemConversation(req);
    if (!conv) return ok(res, { thread: null });
    await markReadFor(req, conv.conversationId);
    return ok(res, { thread: await m.buildThread(conv, req.user) });
  } catch (error) {
    logger.error({ err: error, itemId: req.params.itemId }, 'Error loading the messages about work');
    return failed(res, 500, 'Error loading the messages');
  }
};

// POST /api/student/items/:itemId/thread/messages  { body } → Thread
// The first message creates the thread (once per student × item): the
// item's class, its lead teacher, the item's title. Starting one is held to
// the current term like every new thread.
const postItemThreadMessage = async (req, res) => {
  const message = text(req.body?.body);
  if (!message || message.length > m.MAX_BODY) return failed(res, 400, MESSAGES.BODY);
  try {
    const { error, takesThread } = await loadThreadItem(req);
    if (error) return failed(res, error[0], error[1]);
    if (!takesThread) return failed(res, 400, MESSAGES.NO_THREAD_HERE);

    let { conv, refused } = await loadItemConversation(req);
    if (!conv && !refused) {
      const term = await m.resolveCurrentTerm(req);
      const { rows: [anchor] } = await db.query(q.selectClassworkThreadAnchor, [req.params.itemId, ...m.termParams(term)]);
      if (!anchor) return failed(res, 404, MESSAGES.ITEM_NOT_FOUND);
      if (term && !anchor.in_current_term) return failed(res, 400, m.PAST_TERM_MESSAGE);
      const { rows: [c] } = await db.query(q.insertClassworkThread, [
        req.user.school, req.student.studentId, anchor.class_id, anchor.lead_teacher_id ?? null,
        anchor.title || 'Classwork', req.user.userId, req.params.itemId,
      ]);
      ({ conv, refused } = await loadItemConversation(req, c.conversation_id));
    }
    if (refused) return failed(res, 403, 'Not authorized for this conversation');
    await m.persistMessage({ conversationId: conv.conversationId, school: conv.school, sender: req.user, body: message });
    await m.queueEmails(conv, req.user.userId);
    return ok(res, await m.buildThread(await m.loadConversation(conv.conversationId), req.user), 201);
  } catch (error) {
    logger.error({ err: error, itemId: req.params.itemId }, 'Error sending a message about work');
    return failed(res, 500, 'Error sending message');
  }
};

module.exports = {
  MESSAGES,
  listConversations,
  getUnreadCount,
  getTargets,
  createConversation,
  getConversation,
  deleteMessage,
  getItemThread,
  postItemThreadMessage,
  // messaging's own handlers, on req.conversation (requireStudentConversationAccess)
  uploadFiles: m.uploadFiles,
  postMessage: m.postMessage,
  editMessage: m.editMessage,
  markRead: m.markRead,
  getAttachmentUrl: m.getAttachmentUrl,
};
