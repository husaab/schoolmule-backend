// controllers/messaging.controller.js
//
// Parent–teacher conversations anchored to a student × class × assessment.
//
// Access to an existing thread is settled by requireConversationAccess
// (req.conversation). Starting a thread re-derives the same membership from
// selectAnchorContext because no row exists yet. Email fan-out never touches
// the HTTP result: a message is committed first, then jobs are queued into
// message_email_jobs for services/messageNotifier.js.

const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const q = require('../queries/messaging.queries');
const { accessRowToConversation } = require('../middleware/requireConversationAccess');

const BUCKET = 'message-attachments';
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BODY = 5000;
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_DELAY = '2 minutes';
const SIGNED_URL_TTL = 3600;

// Declared MIME must match the extension; neither alone is trusted.
const ALLOWED = {
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED[ext] && ALLOWED[ext].includes(file.mimetype)) return cb(null, true);
  const err = new Error('Only images (JPEG, PNG, GIF, WebP), PDF and Word documents are allowed');
  err.code = 'UNSUPPORTED_FILE';
  return cb(err);
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter,
});

// Multer errors become 400s in our envelope instead of reaching errorHandler.
const uploadFiles = (req, res, next) =>
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10 MB or smaller'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `At most ${MAX_FILES} files per message`
          : err.message;
    return res.status(400).json({ status: 'failed', message });
  });

const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });
const pctOf = (score, max) => (score == null || !max ? null : Math.round((Number(score) / Number(max)) * 1000) / 10);
const side = (role) => (role === 'PARENT' ? 'parent' : 'staff');

const toItem = (r) => ({
  conversationId: r.conversation_id,
  studentId: r.student_id,
  studentName: r.student_name,
  classId: r.class_id,
  classSubject: r.class_subject,
  assessmentId: r.assessment_id,
  title: r.title,
  status: r.status,
  lastMessageAt: r.last_message_at,
  createdAt: r.created_at,
  leadTeacherName: r.lead_teacher_name ?? null,
  unreadCount: r.unread_count ?? 0,
  lastMessage: r.last_message ?? null,
});

// "Needs reply" = the last real message came from the other side of the table.
const needsReplyFor = (role, lastMessage) =>
  Boolean(lastMessage && lastMessage.kind === 'message' && side(lastMessage.senderRole) !== side(role));

function validateBody(body, fileCount) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (text.length > MAX_BODY) return { error: `Message must be ${MAX_BODY} characters or fewer` };
  if (text.length === 0 && fileCount === 0) return { error: 'Write a message or attach a file' };
  return { text };
}

async function signAttachments(rows) {
  return Promise.all(
    rows.map(async (a) => {
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(a.file_path, SIGNED_URL_TTL);
      return {
        attachmentId: a.attachment_id,
        messageId: a.message_id,
        fileName: a.file_name,
        mimeType: a.mime_type,
        sizeBytes: a.size_bytes,
        url: data?.signedUrl ?? null,
      };
    }),
  );
}

/**
 * Insert a message and its attachments in one transaction. Files are uploaded
 * before COMMIT so a storage failure rolls the message back; objects already
 * uploaded for that message are removed on the way out.
 */
async function persistMessage({ conversationId, school, sender, kind = 'message', body, files = [] }) {
  const client = await db.connect();
  const uploaded = [];
  try {
    await client.query('BEGIN');
    const { rows: [m] } = await client.query(q.insertMessage, [conversationId, sender.userId, sender.role, kind, body]);
    for (const f of files) {
      const ext = path.extname(f.originalname).toLowerCase();
      const filePath = `${school}/${conversationId}/${m.message_id}/${crypto.randomUUID()}${ext}`;
      const { error } = await supabase.storage.from(BUCKET).upload(filePath, f.buffer, { contentType: f.mimetype, upsert: false });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      uploaded.push(filePath);
      await client.query(q.insertAttachment, [m.message_id, filePath, f.originalname, f.mimetype, f.size]);
    }
    if (kind === 'message') await client.query(q.touchConversation, [conversationId]);
    await client.query('COMMIT');
    return m;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (uploaded.length) {
      await supabase.storage.from(BUCKET).remove(uploaded).catch((e) => logger.warn('Attachment rollback cleanup failed:', e));
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Queue a digest email for everyone but the sender, cancel the sender's own
 * pending job (they obviously just read the thread) and mark them read.
 * Never throws: the message is already committed.
 */
async function queueEmails(conv, senderId) {
  try {
    const recipients = [...new Set([...conv.guardianIds, ...conv.teacherIds, ...conv.adminParticipantIds])]
      .filter((id) => id && id !== senderId);
    if (recipients.length) {
      await db.query(q.enqueueEmailJobs, [conv.conversationId, recipients, conv.school, EMAIL_DELAY]);
    }
    await db.query(q.cancelPendingJob, [conv.conversationId, senderId]);
    await db.query(q.upsertParticipantRead, [conv.conversationId, senderId]);
  } catch (error) {
    logger.error('Failed to queue message emails:', error);
  }
}

/** The first time an admin who does not teach the class writes, say so in the thread. */
async function noteAdminJoin(conv, user) {
  if (user.role !== 'ADMIN') return;
  if (conv.teacherIds.includes(user.userId) || conv.adminParticipantIds.includes(user.userId)) return;
  await db.query(q.ensureParticipant, [conv.conversationId, user.userId]);
  await persistMessage({
    conversationId: conv.conversationId,
    school: conv.school,
    sender: user,
    kind: 'system',
    body: `${user.username} (Admin) joined the conversation`,
  });
  conv.adminParticipantIds.push(user.userId);
}

async function loadConversation(conversationId) {
  const { rows } = await db.query(q.selectConversationAccess, [conversationId]);
  return rows[0] ? accessRowToConversation(rows[0]) : null;
}

async function buildThread(conv, user) {
  const [{ rows: msgRows }, { rows: parts }, { rows: stateRows }, ctxRes] = await Promise.all([
    db.query(q.selectMessages, [conv.conversationId]),
    db.query(q.selectParticipants, [conv.conversationId]),
    db.query(q.selectParticipantState, [conv.conversationId, user.userId]),
    conv.assessmentId
      ? db.query(q.selectAssessmentContext, [conv.assessmentId, conv.studentId])
      : Promise.resolve({ rows: [] }),
  ]);

  const ids = msgRows.map((m) => m.message_id);
  const attRows = ids.length ? (await db.query(q.selectAttachmentsByMessageIds, [ids])).rows : [];
  const byMessage = new Map();
  for (const a of await signAttachments(attRows)) {
    if (!byMessage.has(a.messageId)) byMessage.set(a.messageId, []);
    byMessage.get(a.messageId).push(a);
  }

  // The publish gate holds inside a thread: a parent never sees a score, a
  // class average or the teacher's note until the assessment is shared.
  let context = null;
  const c = ctxRes.rows[0];
  if (c) {
    const hideScore = user.role === 'PARENT' && !c.is_published;
    context = {
      assessmentId: c.assessment_id,
      name: c.name,
      date: c.date,
      weightPoints: c.weight_points == null ? null : Number(c.weight_points),
      maxScore: c.max_score == null ? null : Number(c.max_score),
      score: hideScore || c.score == null ? null : Number(c.score),
      pct: hideScore ? null : pctOf(c.score, c.max_score),
      isPublished: Boolean(c.is_published),
      parentComment: hideScore ? null : c.parent_comment,
      classAvgPct: user.role === 'PARENT' || c.class_avg_pct == null ? null : Number(c.class_avg_pct),
    };
  }

  const leadTeacher = parts.find((p) => p.user_id === conv.leadTeacherId);
  const state = stateRows[0] || {};
  const conversation = {
    ...toItem({
      conversation_id: conv.conversationId,
      student_id: conv.studentId,
      student_name: conv.studentName,
      class_id: conv.classId,
      class_subject: conv.classSubject,
      assessment_id: conv.assessmentId,
      title: conv.title,
      status: conv.status,
      last_message_at: conv.lastMessageAt,
      created_at: conv.createdAt,
      lead_teacher_name: leadTeacher?.name ?? null,
    }),
  };

  return {
    conversation,
    context,
    participants: parts.map((p) => ({ userId: p.user_id, name: p.name, role: p.role, relation: p.relation })),
    messages: msgRows.map((m) => ({
      messageId: m.message_id,
      senderId: m.sender_id,
      senderName: m.sender_name,
      senderRole: m.sender_role,
      senderRelation: m.sender_relation,
      kind: m.kind,
      body: m.deleted_at ? null : m.body,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      deletedAt: m.deleted_at,
      attachments: m.deleted_at ? [] : byMessage.get(m.message_id) || [],
    })),
    lastReadAt: state.last_read_at ?? null,
    muted: Boolean(state.muted),
  };
}

/** Staff-side class check shared by targets and stubs. Returns an error tuple or null. */
async function checkClassForStaff(classId, user) {
  const { rows } = await db.query(
    'SELECT school, teacher_id, EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = $1 AND ct.teacher_id = $2) AS co FROM classes WHERE class_id = $1',
    [classId, user.userId],
  );
  if (!rows.length || rows[0].school !== user.school) return [404, 'Class not found'];
  if (user.role === 'TEACHER' && rows[0].teacher_id !== user.userId && !rows[0].co) return [403, 'Not authorized for this class'];
  return null;
}

async function parentLinked(studentId, userId) {
  const { rows } = await db.query('SELECT 1 FROM parent_students WHERE student_id = $1 AND parent_id = $2', [studentId, userId]);
  return rows.length > 0;
}

// ────────────────────────────────────────────────────────────────────
// GET /api/messaging/conversations
// ────────────────────────────────────────────────────────────────────
const listConversations = async (req, res) => {
  const { userId, school, role } = req.user;
  const status = req.query.status === 'all' ? null : req.query.status === 'resolved' ? 'resolved' : 'open';
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const sql = role === 'PARENT' ? q.listForParent : role === 'ADMIN' ? q.listForAdmin : q.listForTeacher;
  try {
    const { rows } = await db.query(sql, [
      userId,
      school,
      req.schoolYear?.schoolYearId ?? null,
      status,
      req.query.classId || null,
      req.query.studentId || null,
      req.query.q ? String(req.query.q).trim() || null : null,
      limit,
      req.query.unread === '1',
    ]);

    let failedSet = new Set();
    if (role === 'ADMIN' && rows.length) {
      const { rows: f } = await db.query(q.selectFailedEmailConversations, [rows.map((r) => r.conversation_id)]);
      failedSet = new Set(f.map((r) => r.conversation_id));
    }

    const items = rows.map((r) => ({
      ...toItem(r),
      needsReply: needsReplyFor(role, r.last_message),
      ...(role === 'ADMIN' ? { emailFailed: failedSet.has(r.conversation_id) } : {}),
    }));
    return res.status(200).json({ status: 'success', data: items });
  } catch (error) {
    logger.error('Error listing conversations:', error);
    return failed(res, 500, 'Error loading conversations');
  }
};

// GET /api/messaging/conversations/unread-count
const getUnreadSummary = async (req, res) => {
  const { userId, school, role } = req.user;
  try {
    const { rows: [r] } = await db.query(q.selectUnreadSummary, [userId, school, role]);
    return res.status(200).json({
      status: 'success',
      data: {
        unreadConversations: r?.unread_conversations ?? 0,
        unreadMessages: r?.unread_messages ?? 0,
        needsReply: r?.needs_reply ?? 0,
      },
    });
  } catch (error) {
    logger.error('Error loading unread summary:', error);
    return failed(res, 500, 'Error loading unread count');
  }
};

// GET /api/messaging/conversations/targets?studentId= | ?classId=
const getTargets = async (req, res) => {
  const user = req.user;
  const { studentId, classId } = req.query;
  try {
    if (user.role === 'PARENT') {
      if (!studentId) return failed(res, 400, 'studentId is required');
      if (!(await parentLinked(studentId, user.userId))) return failed(res, 403, 'Not authorized for this student');
      const { rows } = await db.query(q.selectParentTargets, [studentId, req.schoolYear?.schoolYearId ?? null]);
      const byClass = new Map();
      for (const r of rows) {
        if (!byClass.has(r.class_id)) {
          byClass.set(r.class_id, { classId: r.class_id, subject: r.subject, teacherName: r.teacher_name || null, assessments: [] });
        }
        if (r.assessment_id) {
          byClass.get(r.class_id).assessments.push({
            assessmentId: r.assessment_id, name: r.assessment_name, date: r.date, conversationId: r.conversation_id,
          });
        }
      }
      return res.status(200).json({ status: 'success', data: [...byClass.values()] });
    }

    if (!classId) return failed(res, 400, 'classId is required');
    const err = await checkClassForStaff(classId, user);
    if (err) return failed(res, err[0], err[1]);
    const [{ rows: students }, { rows: assessments }] = await Promise.all([
      db.query(q.selectTeacherTargetStudents, [classId]),
      db.query(q.selectTeacherTargetAssessments, [classId]),
    ]);
    return res.status(200).json({
      status: 'success',
      data: {
        students: students.map((s) => ({ studentId: s.student_id, name: s.name, guardians: s.guardians })),
        assessments: assessments.map((a) => ({ assessmentId: a.assessment_id, name: a.name, date: a.date, isPublished: a.is_published })),
      },
    });
  } catch (error) {
    logger.error('Error loading message targets:', error);
    return failed(res, 500, 'Error loading targets');
  }
};

// GET /api/messaging/conversations/stubs?classId= | ?studentId=
const getStubs = async (req, res) => {
  const user = req.user;
  const { classId, studentId } = req.query;
  if (!classId && !studentId) return failed(res, 400, 'classId or studentId is required');
  try {
    if (user.role === 'PARENT') {
      if (!studentId) return failed(res, 400, 'studentId is required');
      if (!(await parentLinked(studentId, user.userId))) return failed(res, 403, 'Not authorized for this student');
    } else if (classId) {
      const err = await checkClassForStaff(classId, user);
      if (err) return failed(res, err[0], err[1]);
    } else if (user.role !== 'ADMIN') {
      return failed(res, 403, 'classId is required');
    }
    const { rows } = await db.query(q.selectStubs, [user.userId, classId || null, studentId || null]);
    return res.status(200).json({
      status: 'success',
      data: rows.map((r) => ({
        conversationId: r.conversation_id, studentId: r.student_id, classId: r.class_id,
        assessmentId: r.assessment_id, status: r.status, unreadCount: r.unread_count,
      })),
    });
  } catch (error) {
    logger.error('Error loading conversation stubs:', error);
    return failed(res, 500, 'Error loading conversations');
  }
};

// POST /api/messaging/conversations  (multipart: studentId, classId, assessmentId, body, files[])
const createConversation = async (req, res) => {
  const user = req.user;
  const { studentId, classId, assessmentId } = req.body;
  const files = req.files || [];
  if (!studentId || !classId || !assessmentId) return failed(res, 400, 'studentId, classId and assessmentId are required');
  const v = validateBody(req.body.body, files.length);
  if (v.error) return failed(res, 400, v.error);

  try {
    const { rows } = await db.query(q.selectAnchorContext, [studentId, classId, assessmentId, user.userId]);
    const a = rows[0];
    if (!a || a.school !== user.school || a.student_school !== user.school) return failed(res, 404, 'Class or student not found');
    if (!a.student_in_class) return failed(res, 400, 'Student is not in this class');
    if (!a.assessment_id || !a.assessment_in_class) return failed(res, 400, 'Assessment is not in this class');
    if (a.is_parent) return failed(res, 400, 'Choose a specific assessment, not a category');
    if (user.role === 'PARENT') {
      if (!a.is_guardian) return failed(res, 403, 'Not authorized for this student');
      if (!a.is_published) return failed(res, 403, 'This assessment has not been shared yet');
    } else if (user.role === 'TEACHER' && a.lead_teacher_id !== user.userId && !a.is_co_teacher) {
      return failed(res, 403, 'Not authorized for this class');
    }

    // One thread per anchor: a second "Ask the teacher" lands in the first.
    const { rows: existing } = await db.query(q.findConversationByAnchor, [studentId, classId, assessmentId]);
    let conversationId;
    if (existing.length) {
      conversationId = existing[0].conversation_id;
    } else {
      const { rows: [c] } = await db.query(q.insertConversation, [user.school, studentId, classId, assessmentId, a.assessment_name, user.userId]);
      conversationId = c.conversation_id;
    }

    const conv = await loadConversation(conversationId);
    await noteAdminJoin(conv, user);
    await persistMessage({ conversationId, school: user.school, sender: user, body: v.text, files });
    await queueEmails(conv, user.userId);

    const thread = await buildThread(await loadConversation(conversationId), user);
    return res.status(existing.length ? 200 : 201).json({ status: 'success', data: thread });
  } catch (error) {
    logger.error('Error creating conversation:', error);
    return failed(res, 500, 'Error sending message');
  }
};

// GET /api/messaging/conversations/:id
const getConversation = async (req, res) => {
  try {
    const thread = await buildThread(req.conversation, req.user);
    return res.status(200).json({ status: 'success', data: thread });
  } catch (error) {
    logger.error('Error loading conversation:', error);
    return failed(res, 500, 'Error loading conversation');
  }
};

// POST /api/messaging/conversations/:id/messages  (multipart: body, files[])
const postMessage = async (req, res) => {
  const files = req.files || [];
  const v = validateBody(req.body.body, files.length);
  if (v.error) return failed(res, 400, v.error);
  try {
    const conv = req.conversation;
    await noteAdminJoin(conv, req.user);
    await persistMessage({ conversationId: conv.conversationId, school: conv.school, sender: req.user, body: v.text, files });
    await queueEmails(conv, req.user.userId);
    const thread = await buildThread(await loadConversation(conv.conversationId), req.user);
    return res.status(201).json({ status: 'success', data: thread });
  } catch (error) {
    logger.error('Error posting message:', error);
    return failed(res, 500, 'Error sending message');
  }
};

// PATCH /api/messaging/conversations/:id/messages/:messageId  { body }
const editMessage = async (req, res) => {
  const text = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (!text || text.length > MAX_BODY) return failed(res, 400, `Message must be 1–${MAX_BODY} characters`);
  try {
    const { rows } = await db.query(q.selectMessageForMutation, [req.params.messageId, req.conversation.conversationId]);
    const m = rows[0];
    if (!m || m.kind !== 'message') return failed(res, 404, 'Message not found');
    if (m.sender_id !== req.user.userId) return failed(res, 403, 'You can only edit your own messages');
    if (m.deleted_at) return failed(res, 403, 'This message was removed');
    if (Date.now() - new Date(m.created_at).getTime() > EDIT_WINDOW_MS) {
      return failed(res, 403, 'Messages can be edited for 15 minutes after sending');
    }
    const { rows: [u] } = await db.query(q.updateMessageBody, [m.message_id, text]);
    return res.status(200).json({ status: 'success', data: { messageId: m.message_id, body: text, editedAt: u.edited_at } });
  } catch (error) {
    logger.error('Error editing message:', error);
    return failed(res, 500, 'Error editing message');
  }
};

// DELETE /api/messaging/conversations/:id/messages/:messageId
const deleteMessage = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectMessageForMutation, [req.params.messageId, req.conversation.conversationId]);
    const m = rows[0];
    if (!m || m.kind !== 'message') return failed(res, 404, 'Message not found');
    if (m.sender_id !== req.user.userId && req.user.role !== 'ADMIN') return failed(res, 403, 'You can only remove your own messages');
    if (m.deleted_at) return res.status(200).json({ status: 'success', data: { messageId: m.message_id, deletedAt: m.deleted_at } });

    const { rows: paths } = await db.query(q.selectAttachmentPathsByMessage, [m.message_id]);
    if (paths.length) {
      await supabase.storage.from(BUCKET).remove(paths.map((p) => p.file_path)).catch((e) => logger.warn('Attachment cleanup failed:', e));
    }
    await db.query(q.deleteAttachmentsByMessage, [m.message_id]);
    const { rows: [d] } = await db.query(q.softDeleteMessage, [m.message_id, req.user.userId]);
    return res.status(200).json({ status: 'success', data: { messageId: m.message_id, deletedAt: d.deleted_at } });
  } catch (error) {
    logger.error('Error deleting message:', error);
    return failed(res, 500, 'Error removing message');
  }
};

// POST /api/messaging/conversations/:id/read
const markRead = async (req, res) => {
  try {
    const { conversationId } = req.conversation;
    const { rows: [r] } = await db.query(q.upsertParticipantRead, [conversationId, req.user.userId]);
    await db.query(q.cancelPendingJob, [conversationId, req.user.userId]);
    return res.status(200).json({ status: 'success', data: { lastReadAt: r?.last_read_at ?? null } });
  } catch (error) {
    logger.error('Error marking conversation read:', error);
    return failed(res, 500, 'Error updating conversation');
  }
};

// PATCH /api/messaging/conversations/:id  { status }
const setStatus = async (req, res) => {
  const { status } = req.body;
  if (req.user.role === 'PARENT') return failed(res, 403, 'Only staff can resolve a conversation');
  if (!['open', 'resolved'].includes(status)) return failed(res, 400, 'status must be open or resolved');
  try {
    const conv = req.conversation;
    await db.query(q.updateConversationStatus, [conv.conversationId, status, req.user.userId]);
    await persistMessage({
      conversationId: conv.conversationId,
      school: conv.school,
      sender: req.user,
      kind: 'system',
      body: status === 'resolved'
        ? `${req.user.username} marked this conversation resolved`
        : `${req.user.username} reopened this conversation`,
    });
    return res.status(200).json({ status: 'success', data: { status } });
  } catch (error) {
    logger.error('Error updating conversation status:', error);
    return failed(res, 500, 'Error updating conversation');
  }
};

// PATCH /api/messaging/conversations/:id/mute  { muted }
const setMuted = async (req, res) => {
  if (typeof req.body.muted !== 'boolean') return failed(res, 400, 'muted must be a boolean');
  try {
    const { rows: [r] } = await db.query(q.upsertParticipantMuted, [req.conversation.conversationId, req.user.userId, req.body.muted]);
    return res.status(200).json({ status: 'success', data: { muted: Boolean(r?.muted) } });
  } catch (error) {
    logger.error('Error updating mute:', error);
    return failed(res, 500, 'Error updating conversation');
  }
};

// GET /api/messaging/conversations/:id/attachments/:attachmentId/url
const getAttachmentUrl = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectAttachment, [req.params.attachmentId, req.conversation.conversationId]);
    if (!rows.length) return failed(res, 404, 'Attachment not found');
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(rows[0].file_path, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) return failed(res, 500, 'Could not open attachment');
    return res.status(200).json({ status: 'success', data: { url: data.signedUrl, fileName: rows[0].file_name, mimeType: rows[0].mime_type } });
  } catch (error) {
    logger.error('Error signing attachment:', error);
    return failed(res, 500, 'Could not open attachment');
  }
};

module.exports = {
  uploadFiles,
  listConversations,
  getUnreadSummary,
  getTargets,
  getStubs,
  createConversation,
  getConversation,
  postMessage,
  editMessage,
  deleteMessage,
  markRead,
  setStatus,
  setMuted,
  getAttachmentUrl,
  // exported for unit tests
  validateBody,
  needsReplyFor,
};
