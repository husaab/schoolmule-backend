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
const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const { BUCKET, SIGNED_URL_TTL, uploadFiles, signedUrlMap } = require('../utils/attachmentUpload');
const logger = require('../logger');
const q = require('../queries/messaging.queries');
const announcementQueries = require('../queries/announcement.queries');
const adminUserQueries = require('../queries/adminUser.queries');
const schoolQueries = require('../queries/school.queries');
const { getResend, sendOrThrow } = require('../utils/emailUtils');
const { schoolSender } = require('../services/email/senderIdentity');
const { getSchoolName } = require('../utils/schoolUtils');
const { getGuardianInviteEmailHTML } = require('../templates/emailTemplate');
const { accessRowToConversation } = require('../middleware/requireConversationAccess');

const MAX_BODY = 5000;
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_DELAY = '2 minutes';
const MAX_TITLE = 120;
const RESEND_INVITE_COOLDOWN_MS = 60 * 60 * 1000;

const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
// A malformed id in a query string is a client mistake, not a server error.
const badId = (...values) => values.some((v) => v != null && v !== '' && !isUuid(v));
const pctOf = (score, max) => (score == null || !max ? null : Math.round((Number(score) / Number(max)) * 1000) / 10);
const side = (role) => (role === 'PARENT' ? 'parent' : 'staff');
// A staff member in their parent view may not open a thread with themself.
const SELF_THREAD_MESSAGE = "You teach this class, so there's no one to ask. Switch to Teacher view to see it there.";

const toItem = (r) => ({
  conversationId: r.conversation_id,
  studentId: r.student_id,
  studentName: r.student_name,
  classId: r.class_id,
  classSubject: r.class_subject,
  assessmentId: r.assessment_id,
  kind: r.kind || 'assessment',
  teacherId: r.teacher_id ?? null,
  title: r.title,
  status: r.status,
  lastMessageAt: r.last_message_at,
  createdAt: r.created_at,
  leadTeacherName: r.lead_teacher_name ?? null,
  termName: r.term_name ?? null,
  guardianNames: r.guardian_names ?? [],
  unreadCount: r.unread_count ?? 0,
  lastMessage: r.last_message ?? null,
});

// "Needs reply" = the last real (not removed, not system) message came from the
// other side of the table and the thread is still open.
const needsReplyFor = (role, row) =>
  row.status === 'open' && Boolean(row.last_real_sender_role) && side(row.last_real_sender_role) !== side(role);

function validateBody(body, fileCount) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (text.length > MAX_BODY) return { error: `Message must be ${MAX_BODY} characters or fewer` };
  if (text.length === 0 && fileCount === 0) return { error: 'Write a message or attach a file' };
  return { text };
}

// One storage call per thread fetch, not one per attachment.
async function signAttachments(rows) {
  if (rows.length === 0) return [];
  const byPath = await signedUrlMap(rows.map((a) => a.file_path));
  return rows.map((a) => ({
    attachmentId: a.attachment_id,
    messageId: a.message_id,
    fileName: a.file_name,
    mimeType: a.mime_type,
    sizeBytes: a.size_bytes,
    url: byPath.get(a.file_path) ?? null,
  }));
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

const maskEmail = (email) => {
  const [local = '', domain = ''] = String(email).split('@');
  return `${local.slice(0, 1)}${local.length > 1 ? '…' : ''}@${domain}`;
};
const inviteLink = (token, conversationId) =>
  `${process.env.FRONTEND_URL || ''}/reset-password?token=${token}&invite=1&next=${encodeURIComponent(`/parent/messages?thread=${conversationId}`)}`;

async function sendGuardianInvite({ school, to, recipientFirstName, teacherName, studentName, title, preview, token, conversationId }) {
  let schoolInfo = null;
  try {
    const r = await db.query(schoolQueries.selectSchoolByCode, [school]);
    schoolInfo = r.rows[0] || null;
  } catch (e) {
    logger.warn('School lookup failed for invite email:', e);
  }
  const schoolName = getSchoolName(school);
  const studentFirstName = String(studentName || '').split(' ')[0];
  await sendOrThrow(getResend(), {
    ...schoolSender({ school, schoolInfo, role: 'messages' }),
    to: [to],
    subject: `${teacherName} sent you a message about ${studentFirstName}`,
    html: getGuardianInviteEmailHTML({
      recipientFirstName, teacherName, studentFirstName, title, preview,
      url: inviteLink(token, conversationId), schoolName, schoolInfo,
    }),
  });
}

/**
 * Staff wrote to a student whose guardian has an email but no account.
 * Reuses the admin invite mechanism: an invite-pending user ('!' password)
 * linked to the guardian row, a 7-day token, and a branded email that lands
 * in this thread. An email that already has an account is linked instead
 * (they will get the ordinary digest). Never throws.
 */
async function inviteUnlinkedGuardians(conv, user, { invite, includePreview, body }) {
  if (user.role === 'PARENT' || invite === false) return [];
  const results = [];
  try {
    const { rows: links } = await db.query(q.selectUnlinkedGuardians, [conv.studentId]);
    for (const link of links) {
      const email = String(link.parent_email).trim();
      const name = (link.parent_name && link.parent_name.trim()) || email.split('@')[0];
      try {
        const { rows: existing } = await db.query(q.selectUserByEmailInSchool, [email, conv.school]);
        if (existing.length) {
          const u = existing[0];
          // Any live account may be the guardian, staff included: a teacher
          // linked to their own child reads the thread in their parent view.
          if (u.is_archived) {
            results.push({ linkId: link.parent_student_link_id, name, status: 'skipped' });
            continue;
          }
          await db.query(q.linkGuardianToUser, [link.parent_student_link_id, u.user_id, user.userId, conv.conversationId, false]);
          conv.guardianIds.push(u.user_id);
          results.push({ linkId: link.parent_student_link_id, name, status: 'linked' });
          continue;
        }
        const [firstName, ...rest] = name.split(/\s+/);
        const lastName = rest.join(' ') || '';
        const { rows: created } = await db.query(adminUserQueries.insertInvitedUser, [email, name, firstName, lastName, conv.school, 'PARENT']);
        const newUser = created[0];
        await db.query(q.linkGuardianToUser, [link.parent_student_link_id, newUser.user_id, user.userId, conv.conversationId, true]);
        const { rows: tok } = await db.query(adminUserQueries.createInviteToken, [newUser.user_id]);
        await sendGuardianInvite({
          school: conv.school,
          to: email,
          recipientFirstName: firstName,
          teacherName: user.username,
          studentName: conv.studentName,
          title: conv.title,
          // The whole message, not a teaser: the guardian has no other way to read it yet.
          preview: includePreview === false ? null : String(body || ''),
          token: tok[0].token,
          conversationId: conv.conversationId,
        });
        results.push({ linkId: link.parent_student_link_id, name, status: 'invited' });
      } catch (error) {
        logger.error({ err: error, linkId: link.parent_student_link_id }, 'Guardian invite failed');
        results.push({ linkId: link.parent_student_link_id, name, status: 'failed' });
      }
    }
  } catch (error) {
    logger.error('Guardian invite lookup failed:', error);
  }
  return results;
}

const flag = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : !(v === false || v === 'false' || v === '0'));

const PAST_TERM_MESSAGE = 'This class is from a past term. New conversations can only be started about classes in the current term.';

/**
 * The term new threads may target: the school's active term, provided it
 * belongs to the selected school year (X-School-Year). Returns null when no
 * term is active (or the active term sits in another year, e.g. an admin
 * browsing a past year): the queries then skip the term filter and offer
 * every class of the selected year instead of an empty picker.
 */
async function resolveCurrentTerm(req) {
  const { rows } = await db.query(q.selectCurrentTerm, [req.user.school, req.schoolYear?.schoolYearId ?? null]);
  return rows[0] ? { termId: rows[0].term_id, name: rows[0].name } : null;
}
const termParams = (term) => [term?.termId ?? null, term?.name ?? null];
// Teachers and parents may only start threads about current-term classes;
// admins are exempt (they handle the office's cross-term follow-ups). With no
// current term there is nothing to hold anyone to.
const outOfTerm = (user, term, row) => Boolean(term) && user.role !== 'ADMIN' && !row.in_current_term;

async function loadConversation(conversationId) {
  const { rows } = await db.query(q.selectConversationAccess, [conversationId]);
  return rows[0] ? accessRowToConversation(rows[0]) : null;
}

async function buildThread(conv, user) {
  const isStaff = user.role !== 'PARENT';
  const [{ rows: msgRows }, { rows: parts }, { rows: stateRows }, ctxRes, studentRes] = await Promise.all([
    db.query(q.selectMessages, [conv.conversationId]),
    db.query(q.selectParticipants, [conv.conversationId]),
    db.query(q.selectParticipantState, [conv.conversationId, user.userId]),
    conv.assessmentId
      ? db.query(q.selectAssessmentContext, [conv.assessmentId, conv.studentId])
      : Promise.resolve({ rows: [] }),
    isStaff && !conv.assessmentId
      ? db.query(q.selectStudentContext, [conv.studentId])
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
      date: hideScore ? null : c.date,
      weightPoints: hideScore || c.weight_points == null ? null : Number(c.weight_points),
      maxScore: hideScore || c.max_score == null ? null : Number(c.max_score),
      score: hideScore || c.score == null ? null : Number(c.score),
      pct: hideScore || c.status === 'excused' ? null : c.status === 'missing' ? 0 : pctOf(c.score, c.max_score),
      // graded | missing | excused | blank — the same cell state the gradebook shows
      status: hideScore ? null : c.status === 'missing' || c.status === 'excused' ? c.status : c.score == null ? 'blank' : 'graded',
      isPublished: Boolean(c.is_published),
      parentComment: hideScore ? null : c.parent_comment,
      classAvgPct: user.role === 'PARENT' || c.class_avg_pct == null ? null : Number(c.class_avg_pct),
    };
  }

  const st = studentRes.rows[0];
  const student = st
    ? {
        studentId: st.student_id,
        name: st.name,
        grade: st.grade,
        homeroomTeacherName: st.homeroom_teacher_name || null,
        attendancePct: st.attendance_pct == null ? null : Number(st.attendance_pct),
      }
    : null;

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
      kind: conv.kind,
      teacher_id: conv.teacherId,
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
    student,
    participants: parts.map((p) => ({ userId: p.user_id, name: p.name, role: p.role, relation: p.relation, invitePending: Boolean(p.invite_pending) })),
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

/** Staff-side class check shared by targets and stubs. Returns { error: [status, message] } or { cls: row }. */
async function checkClassForStaff(classId, user) {
  const { rows } = await db.query(
    'SELECT school, teacher_id, term_id, term_name, EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = $1 AND ct.teacher_id = $2) AS co FROM classes WHERE class_id = $1',
    [classId, user.userId],
  );
  if (!rows.length || rows[0].school !== user.school) return { error: [404, 'Class not found'] };
  if (user.role === 'TEACHER' && rows[0].teacher_id !== user.userId && !rows[0].co) return { error: [403, 'Not authorized for this class'] };
  return { cls: rows[0] };
}

// JS twin of the SQL inCurrentTerm predicate, for the one class row checkClassForStaff already loaded.
const classInTerm = (cls, term) =>
  !term || cls.term_id === term.termId || (cls.term_id == null && cls.term_name === term.name);

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
  if (badId(req.query.classId, req.query.studentId)) return failed(res, 400, 'Invalid id');
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
      needsReply: needsReplyFor(role, r),
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
    const [{ rows: [r] }, { rows: [a] }] = await Promise.all([
      db.query(q.selectUnreadSummary, [userId, school, role]),
      db.query(announcementQueries.countUnreadAnnouncements, [userId, school, role, req.schoolYear?.schoolYearId ?? null]),
    ]);
    return res.status(200).json({
      status: 'success',
      data: {
        unreadConversations: r?.unread_conversations ?? 0,
        unreadMessages: r?.unread_messages ?? 0,
        needsReply: r?.needs_reply ?? 0,
        unreadAnnouncements: a?.unread_announcements ?? 0,
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
  if (badId(studentId, classId)) return failed(res, 400, 'Invalid id');
  try {
    if (user.role === 'PARENT') {
      if (!studentId) return failed(res, 400, 'studentId is required');
      if (!(await parentLinked(studentId, user.userId))) return failed(res, 403, 'Not authorized for this student');
      const yearId = req.schoolYear?.schoolYearId ?? null;
      const term = await resolveCurrentTerm(req);
      const [{ rows }, { rows: teacherRows }] = await Promise.all([
        db.query(q.selectParentTargets, [studentId, yearId, ...termParams(term)]),
        db.query(q.selectParentTeacherTargets, [studentId, yearId, ...termParams(term)]),
      ]);
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
      return res.status(200).json({
        status: 'success',
        data: {
          currentTerm: term,
          classes: [...byClass.values()],
          // A parent who teaches their own child is never offered themself.
          teachers: teacherRows
            .filter((t) => t.user_id !== user.userId)
            .map((t) => ({ userId: t.user_id, name: t.name, via: t.via, role: t.role })),
        },
      });
    }

    if (!classId && studentId) {
      // Students page: one student, no class in hand. Staff must teach them (or be admin).
      const { rows: srows } = await db.query(q.selectStudentForStaff, [studentId]);
      if (!srows.length || srows[0].school !== user.school) return failed(res, 404, 'Student not found');
      const term = await resolveCurrentTerm(req);
      if (user.role !== 'ADMIN') {
        const { rows: ctxRows } = await db.query(q.selectGeneralAnchorContext, [studentId, user.userId, user.userId, req.schoolYear?.schoolYearId ?? null, ...termParams(term)]);
        if (!ctxRows.length || !ctxRows[0].caller_teaches) return failed(res, 403, 'Not authorized for this student');
      }
      const [{ rows: guardians }, { rows: classRows }] = await Promise.all([
        db.query(q.selectTeacherTargetStudentsOne, [studentId]),
        db.query(q.selectStudentClassesForStaff, [studentId, user.userId, req.schoolYear?.schoolYearId ?? null, ...termParams(term)]),
      ]);
      // A teacher only sees the classes they teach the student in; an admin sees them all.
      const classes = classRows.filter((c) => user.role === 'ADMIN' || c.caller_teaches);
      const { rows: assessmentRows } = classes.length
        ? await db.query(q.selectAssessmentsForClasses, [classes.map((c) => c.class_id)])
        : { rows: [] };
      return res.status(200).json({
        status: 'success',
        data: {
          currentTerm: term,
          students: guardians.map((s) => ({ studentId: s.student_id, name: s.name, guardians: s.guardians })),
          assessments: [],
          classes: classes.map((c) => ({
            classId: c.class_id,
            subject: c.subject,
            assessments: assessmentRows
              .filter((a) => a.class_id === c.class_id)
              .map((a) => ({ assessmentId: a.assessment_id, name: a.name, date: a.date, isPublished: a.is_published })),
          })),
        },
      });
    }

    if (!classId) return failed(res, 400, 'classId is required');
    const { error: err, cls } = await checkClassForStaff(classId, user);
    if (err) return failed(res, err[0], err[1]);
    const term = await resolveCurrentTerm(req);
    const [{ rows: students }, { rows: assessments }] = await Promise.all([
      db.query(q.selectTeacherTargetStudents, [classId]),
      db.query(q.selectTeacherTargetAssessments, [classId]),
    ]);
    return res.status(200).json({
      status: 'success',
      data: {
        currentTerm: term,
        // A gradebook of a past term can still open the picker; the UI warns
        // teachers that sending will be refused (admins are exempt).
        inCurrentTerm: classInTerm(cls, term),
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
  if (badId(classId, studentId)) return failed(res, 400, 'Invalid id');
  try {
    if (user.role === 'PARENT') {
      if (!studentId) return failed(res, 400, 'studentId is required');
      if (!(await parentLinked(studentId, user.userId))) return failed(res, 403, 'Not authorized for this student');
    } else if (classId) {
      const { error: err } = await checkClassForStaff(classId, user);
      if (err) return failed(res, err[0], err[1]);
    } else if (user.role !== 'ADMIN') {
      return failed(res, 403, 'classId is required');
    }
    const { rows } = await db.query(q.selectStubs, [user.userId, classId || null, studentId || null, user.school]);
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
  if (req.body.teacherId && !req.body.assessmentId) return createGeneralConversation(req, res);
  const user = req.user;
  const { studentId, classId, assessmentId } = req.body;
  const files = req.files || [];
  if (!studentId || !classId || !assessmentId) return failed(res, 400, 'studentId, classId and assessmentId are required');
  if (badId(studentId, classId, assessmentId)) return failed(res, 400, 'Invalid id');
  const v = validateBody(req.body.body, files.length);
  if (v.error) return failed(res, 400, v.error);

  try {
    const term = await resolveCurrentTerm(req);
    const { rows } = await db.query(q.selectAnchorContext, [studentId, classId, assessmentId, user.userId, ...termParams(term)]);
    const a = rows[0];
    if (!a || a.school !== user.school || a.student_school !== user.school) return failed(res, 404, 'Class or student not found');
    if (!a.student_in_class) return failed(res, 400, 'Student is not in this class');
    if (!a.assessment_id || !a.assessment_in_class) return failed(res, 400, 'Assessment is not in this class');
    if (a.is_parent) return failed(res, 400, 'Choose a specific assessment, not a category');
    if (user.role === 'PARENT') {
      if (!a.is_guardian) return failed(res, 403, 'Not authorized for this student');
      if (!a.is_published) return failed(res, 403, 'This assessment has not been shared yet');
      // A teacher in their parent view asking about a class they teach would
      // be writing to themself.
      if (a.lead_teacher_id === user.userId || a.is_co_teacher) return failed(res, 403, SELF_THREAD_MESSAGE);
    } else if (user.role === 'TEACHER' && a.lead_teacher_id !== user.userId && !a.is_co_teacher) {
      return failed(res, 403, 'Not authorized for this class');
    }

    // One thread per anchor: a second "Ask the teacher" lands in the first.
    const { rows: existing } = await db.query(q.findConversationByAnchor, [studentId, classId, assessmentId]);
    let conversationId;
    if (existing.length) {
      // Posting into an existing thread is a reply, so the term gate does not apply.
      conversationId = existing[0].conversation_id;
    } else {
      if (outOfTerm(user, term, a)) return failed(res, 400, PAST_TERM_MESSAGE);
      const { rows: [c] } = await db.query(q.insertConversation, [user.school, studentId, classId, assessmentId, a.assessment_name, user.userId]);
      conversationId = c.conversation_id;
    }

    const conv = await loadConversation(conversationId);
    await noteAdminJoin(conv, user);
    await persistMessage({ conversationId, school: user.school, sender: user, body: v.text, files });
    const invites = await inviteUnlinkedGuardians(conv, user, { invite: flag(req.body.invite, true), includePreview: flag(req.body.includePreview, true), body: v.text });
    await queueEmails(conv, user.userId);

    const thread = await buildThread(await loadConversation(conversationId), user);
    return res.status(existing.length ? 200 : 201).json({ status: 'success', data: { ...thread, invites } });
  } catch (error) {
    logger.error('Error creating conversation:', error);
    return failed(res, 500, 'Error sending message');
  }
};

// POST /api/messaging/conversations  (general: studentId, teacherId, title, body, files[])
const createGeneralConversation = async (req, res) => {
  const user = req.user;
  const { studentId, teacherId } = req.body;
  const explicitClassId = req.body.classId || null;
  const files = req.files || [];
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!studentId || !teacherId) return failed(res, 400, 'studentId and teacherId are required');
  if (badId(studentId, teacherId, explicitClassId)) return failed(res, 400, 'Invalid id');
  if (!title || title.length > MAX_TITLE) return failed(res, 400, `Subject must be 1–${MAX_TITLE} characters`);
  const v = validateBody(req.body.body, files.length);
  if (v.error) return failed(res, 400, v.error);
  const announcementId = req.body.announcementId || null;
  if (badId(announcementId)) return failed(res, 400, 'Invalid id');
  if (announcementId && user.role !== 'PARENT') return failed(res, 400, 'announcementId is for parents asking about an announcement');

  try {
    const term = await resolveCurrentTerm(req);
    const { rows } = await db.query(q.selectGeneralAnchorContext, [studentId, teacherId, user.userId, req.schoolYear?.schoolYearId ?? null, ...termParams(term)]);
    const a = rows[0];
    if (!a || a.student_school !== user.school || a.teacher_school !== user.school) return failed(res, 404, 'Student or teacher not found');
    if (!['TEACHER', 'ADMIN'].includes(a.teacher_role) || a.teacher_archived) return failed(res, 400, 'That person cannot receive messages');
    // class_id is current-term only, so a teacher who taught the child in a past term no longer "teaches" them here.
    const teaches = Boolean(a.class_id) || a.is_homeroom;
    // Admins with a staff title (principal, vice principal) are open to every parent in the school.
    const leadership = a.teacher_role === 'ADMIN' && Boolean(a.teacher_staff_title);
    let anchorClassId = a.class_id || null;
    if (user.role === 'PARENT') {
      if (!a.is_guardian) return failed(res, 403, 'Not authorized for this student');
      if (teacherId === user.userId) return failed(res, 403, SELF_THREAD_MESSAGE);
      if (announcementId) {
        // "Ask about this": the author of an announcement the family received
        // may be written to even when they teach none of this parent's children.
        const { rows: arows } = await db.query(announcementQueries.selectParentAnnouncementContext, [announcementId, user.userId, studentId]);
        const an = arows[0];
        if (!an || an.school !== user.school || an.deleted_at) return failed(res, 404, 'Announcement not found');
        if (!an.is_guardian || !an.student_in_audience || an.author_id !== teacherId) return failed(res, 403, 'You can only ask the author about an announcement sent to your child');
        anchorClassId = an.scope === 'class' ? an.class_id : null;
      } else if (!teaches && !leadership) {
        return failed(res, 403, 'That teacher does not teach this student this term');
      }
    } else if (user.role === 'TEACHER') {
      // Writing as yourself is no exemption: the caller must teach the student
      // this term (or be their homeroom teacher), same as the parent-side rule.
      if (!a.caller_teaches) return failed(res, 403, 'You do not teach this student this term');
      if (!teaches && user.userId !== teacherId) return failed(res, 403, 'That teacher does not teach this student this term');
    }

    // The author may name the class (subject) the thread is about; otherwise
    // the first class the teacher teaches the student in is used, or none (homeroom).
    let classId = anchorClassId;
    if (explicitClassId) {
      const { rows: crows } = await db.query(q.selectClassAnchorForGeneral, [explicitClassId, studentId, teacherId, ...termParams(term)]);
      const cl = crows[0];
      if (!cl || cl.school !== user.school) return failed(res, 404, 'Class not found');
      if (!cl.has_student) return failed(res, 400, 'Student is not in this class');
      if (!cl.teacher_teaches) return failed(res, 400, 'That teacher does not teach this class');
      if (outOfTerm(user, term, cl)) return failed(res, 400, PAST_TERM_MESSAGE);
      classId = cl.class_id;
    }
    const { rows: [c] } = await db.query(q.insertGeneralConversation, [user.school, studentId, classId, teacherId, title, user.userId]);
    const conv = await loadConversation(c.conversation_id);
    await noteAdminJoin(conv, user);
    await persistMessage({ conversationId: conv.conversationId, school: user.school, sender: user, body: v.text, files });
    const invites = await inviteUnlinkedGuardians(conv, user, { invite: flag(req.body.invite, true), includePreview: flag(req.body.includePreview, true), body: v.text });
    await queueEmails(conv, user.userId);
    const thread = await buildThread(await loadConversation(conv.conversationId), user);
    return res.status(201).json({ status: 'success', data: { ...thread, invites } });
  } catch (error) {
    logger.error('Error creating general conversation:', error);
    return failed(res, 500, 'Error sending message');
  }
};

// POST /api/messaging/conversations/invites/:linkId/resend
const resendInvite = async (req, res) => {
  const user = req.user;
  if (user.role === 'PARENT') return failed(res, 403, 'Staff only');
  if (!isUuid(req.params.linkId)) return failed(res, 400, 'Invalid id');
  try {
    const { rows } = await db.query(q.selectLinkForInvite, [req.params.linkId, user.school]);
    const link = rows[0];
    if (!link || !link.parent_id || !link.invite_pending) return failed(res, 404, 'No pending invite for this guardian');
    if (link.invited_at && Date.now() - new Date(link.invited_at).getTime() < RESEND_INVITE_COOLDOWN_MS) {
      return failed(res, 429, 'An invite was sent less than an hour ago');
    }
    await db.query(adminUserQueries.deleteTokensForUser, [link.parent_id]);
    const { rows: tok } = await db.query(adminUserQueries.createInviteToken, [link.parent_id]);
    await sendGuardianInvite({
      school: user.school,
      to: link.parent_email,
      recipientFirstName: link.first_name || link.parent_name,
      teacherName: user.username,
      studentName: link.student_name,
      title: 'Your conversation on SchoolMule',
      preview: null,
      token: tok[0].token,
      conversationId: link.invite_conversation_id,
    });
    await db.query(q.touchInvite, [link.parent_student_link_id]);
    return res.status(200).json({ status: 'success', data: { linkId: link.parent_student_link_id, status: 'invited' } });
  } catch (error) {
    logger.error('Error resending guardian invite:', error);
    return failed(res, 500, 'Could not resend the invite');
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
    const invites = await inviteUnlinkedGuardians(conv, req.user, { invite: flag(req.body.invite, true), includePreview: flag(req.body.includePreview, true), body: v.text });
    await queueEmails(conv, req.user.userId);
    const thread = await buildThread(await loadConversation(conv.conversationId), req.user);
    return res.status(201).json({ status: 'success', data: { ...thread, invites } });
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
  resendInvite,
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
