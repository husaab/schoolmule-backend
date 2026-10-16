// controllers/announcement.controller.js
//
// One post, every guardian of every student in the audience. The audience is
// derived at read time (queries/announcement.queries.js IN_AUDIENCE); nothing
// is snapshotted. Emails are queued into announcement_email_jobs after COMMIT
// and drained by services/messageNotifier.js; an edit inside the 2-minute
// window ships corrected, a delete cancels what is still pending.

const path = require('path');
const crypto = require('crypto');
const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const q = require('../queries/announcement.queries');
const { selectCurrentTerm } = require('../queries/termScope');
const schoolQueries = require('../queries/school.queries');
const { getAnnouncementEmailHTML } = require('../templates/emailTemplate');
const { getResend, sendOrThrow } = require('../utils/emailUtils');
const { schoolSender, senderAddress } = require('../services/email/senderIdentity');
const { getSchoolName } = require('../utils/schoolUtils');
const { BUCKET, SIGNED_URL_TTL, signedUrlMap, removeObjects } = require('../utils/attachmentUpload');
const { scopeLabel } = require('../utils/announcementScope');
const { canMutate } = require('../middleware/requireAnnouncementAccess');

const MAX_TITLE = 120;
const MAX_BODY = 5000;
const EMAIL_DELAY = '2 minutes';
const SCOPES = ['class', 'grade', 'school', 'custom'];
const MAX_CUSTOM = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PREVIEW_RECIPIENTS = 5;

const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });
// The active term of the selected year as [term_id, name] query params, or
// [null, null] (no filter) when none is active.
const currentTermParams = async (req) => {
  const { rows } = await db.query(selectCurrentTerm, [req.user.school, req.schoolYear?.schoolYearId ?? null]);
  return rows[0] ? [rows[0].term_id, rows[0].name] : [null, null];
};
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
// A malformed id in a query string is a client mistake, not a server error.
const badId = (...values) => values.some((v) => v != null && v !== '' && !isUuid(v));
const todayToronto = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
const yearOf = (req) => req.schoolYear?.schoolYearId ?? null;
const isStaff = (user) => user.role === 'TEACHER' || user.role === 'ADMIN';
const parseBool = (v) => v === true || v === 'true' || v === '1' || v === 1;
// The "email this post" switch defaults to on: only an explicit no turns it off,
// so a typo never silently stops the families' emails.
const parseSendEmail = (v) => !['false', '0', 'off', 'no'].includes(String(v ?? '').trim().toLowerCase());

/**
 * studentIds for a custom audience: repeated multipart fields, one JSON array
 * string, a comma list (query string) or a JSON body array. Deduped and
 * lower-cased so the same child typed twice is one row.
 */
function parseStudentIds(raw) {
  let list = raw;
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try { list = JSON.parse(raw); } catch { return { error: 'studentIds must be a list of ids' }; }
  } else if (typeof raw === 'string') {
    list = raw.split(',');
  }
  const ids = [...new Set([].concat(list ?? []).map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0) return { error: 'Pick at least one student' };
  if (ids.length > MAX_CUSTOM) return { error: `Pick at most ${MAX_CUSTOM} students` };
  if (ids.some((v) => !isUuid(v))) return { error: 'Invalid student id' };
  return { ids };
}

/** scope / classId / grade / studentIds from a request, validated. Returns { error } or { scope, classId, grade, studentIds }. */
function parseAudience(src) {
  const { scope, classId, grade } = src;
  if (!SCOPES.includes(scope)) return { error: 'scope must be class, grade, school or custom' };
  if (scope === 'class' && !isUuid(classId)) return { error: 'classId is required' };
  if (scope === 'grade' && !(typeof grade === 'string' && grade.trim())) return { error: 'grade is required' };
  let studentIds = null;
  if (scope === 'custom') {
    const parsed = parseStudentIds(src.studentIds);
    if (parsed.error) return { error: parsed.error };
    studentIds = parsed.ids;
  }
  return { scope, classId: scope === 'class' ? classId : null, grade: scope === 'grade' ? grade.trim() : null, studentIds };
}

/** Title / body / pinnedUntil rules shared by create and update. `partial` skips absent fields. */
function validateFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > MAX_TITLE) return { error: `Title must be 1–${MAX_TITLE} characters` };
    out.title = title;
  }
  if (!partial || body.body !== undefined) {
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text || text.length > MAX_BODY) return { error: `Message must be 1–${MAX_BODY} characters` };
    out.body = text;
  }
  if (body.pinnedUntil !== undefined) {
    const p = body.pinnedUntil === null || body.pinnedUntil === '' || body.pinnedUntil === 'null' ? null : String(body.pinnedUntil);
    if (p !== null) {
      if (!DATE_RE.test(p) || Number.isNaN(Date.parse(`${p}T12:00:00`))) return { error: 'Pin date must be YYYY-MM-DD' };
      if (p < todayToronto()) return { error: 'Pin date cannot be in the past' };
    }
    out.pinnedUntil = p;
  } else if (!partial) {
    out.pinnedUntil = null;
  }
  return out;
}

/** One announcement as the list (and detail, create, edit) returns it; staff items carry the counts. */
const toListItem = (r, user) => {
  const base = {
    announcementId: r.announcement_id,
    scope: r.scope,
    classId: r.class_id ?? null,
    classSubject: r.class_subject ?? null,
    classGrade: r.class_grade ?? null,
    grade: r.grade ?? null,
    scopeLabel: scopeLabel(r),
    title: r.title,
    body: r.body,
    authorId: r.author_id ?? null,
    authorName: r.author_name || 'SchoolMule',
    authorRole: r.author_role,
    publishedAt: r.published_at,
    pinnedUntil: r.pinned_until ?? null,
    isPinned: Boolean(r.is_pinned),
    editedAt: r.edited_at ?? null,
    attachmentCount: r.attachment_count ?? 0,
    read: Boolean(r.read),
    canEdit: user.role === 'ADMIN' || r.author_id === user.userId,
    ackRequested: Boolean(r.ack_requested),
    acked: Boolean(r.acked_at),
    ackedAt: r.acked_at ?? null,
  };
  if (user.role === 'PARENT') return { ...base, children: r.children ?? [] };
  return {
    ...base,
    seenCount: r.seen_count ?? 0,
    audienceCount: r.audience_count ?? 0,
    ackCount: r.ack_count ?? 0,
    studentCount: r.student_count ?? 0,
    studentNamesPreview: r.student_names_preview ?? [],
    // Student logins in the audience and how many opened it (students join the Stream).
    studentAudienceCount: r.student_audience_count ?? 0,
    studentSeenCount: r.student_seen_count ?? 0,
    // false when the author posted without emailing anyone.
    sendEmail: r.send_email !== false,
  };
};

// req.announcement (camelCase, from the middleware) back into a row for toListItem.
const fromAccess = (ann) => ({
  announcement_id: ann.announcementId, scope: ann.scope, class_id: ann.classId, class_subject: ann.classSubject,
  class_grade: ann.classGrade, grade: ann.grade, title: ann.title, body: ann.body, author_id: ann.authorId,
  author_name: ann.authorName, author_role: ann.authorRole, published_at: ann.publishedAt, pinned_until: ann.pinnedUntil,
  is_pinned: ann.isPinned, edited_at: ann.editedAt, attachment_count: ann.attachmentCount,
  ack_requested: ann.ackRequested, acked_at: ann.ackedAt, student_count: ann.studentCount, student_names_preview: ann.studentNamesPreview,
  send_email: ann.sendEmail,
});

/** Scope ownership without a row yet. Returns { error: [status, message] } or class meta. */
async function checkScope(user, scope, classId, grade, yearId, studentIds = null) {
  if (!isStaff(user)) return { error: [403, 'Only teachers and admins can post announcements'] };
  if (scope === 'school') return user.role === 'ADMIN' ? {} : { error: [403, 'Only admins can post to the whole school'] };
  if (scope === 'custom') {
    // Every id must be a live student of this school and year; a teacher may only
    // pick students they teach this year or are homeroom for. Admins pick anyone.
    const { rows: [c] } = await db.query(q.selectPickableCount, [studentIds, user.school, yearId, user.userId, user.role]);
    if ((c?.in_school ?? 0) !== studentIds.length) return { error: [404, 'Student not found'] };
    if ((c?.pickable ?? 0) !== studentIds.length) return { error: [403, 'You can only pick students you teach'] };
    return {};
  }
  if (scope === 'class') {
    const { rows } = await db.query(q.canPostToClass, [classId, user.userId, yearId]);
    const cl = rows[0];
    if (!cl || cl.school !== user.school) return { error: [404, 'Class not found'] };
    if (user.role !== 'ADMIN' && !cl.allowed) return { error: [403, 'You can only post to classes you teach this year'] };
    return { classSubject: cl.subject, classGrade: cl.grade };
  }
  if (user.role === 'ADMIN') return {};
  const { rows } = await db.query(q.canPostToGrade, [grade, user.userId, user.school, yearId]);
  return rows[0]?.allowed ? {} : { error: [403, 'Only the homeroom teacher of this grade (or an admin) can post to it'] };
}

/** Upload files under the announcement's prefix inside an open transaction. */
async function storeFiles(client, announcementId, school, files, uploaded) {
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    const filePath = `${school}/announcements/${announcementId}/${crypto.randomUUID()}${ext}`;
    const { error } = await supabase.storage.from(BUCKET).upload(filePath, f.buffer, { contentType: f.mimetype, upsert: false });
    if (error) throw new Error(`Upload failed: ${error.message}`);
    uploaded.push(filePath);
    await client.query(q.insertAttachment, [announcementId, filePath, f.originalname, f.mimetype, f.size]);
  }
}

async function signedAttachments(announcementId) {
  const { rows } = await db.query(q.selectAttachments, [announcementId]);
  const byPath = await signedUrlMap(rows.map((a) => a.file_path));
  return rows.map((a) => ({ attachmentId: a.attachment_id, fileName: a.file_name, mimeType: a.mime_type, sizeBytes: a.size_bytes, url: byPath.get(a.file_path) ?? null }));
}

// GET /api/announcements
const list = async (req, res) => {
  const { userId, school, role } = req.user;
  const { classId, scope, grade, authorId, q: search, studentId } = req.query;
  if (badId(classId, authorId, studentId)) return failed(res, 400, 'Invalid id');
  if (scope && !SCOPES.includes(scope)) return failed(res, 400, 'Invalid scope');
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
  try {
    const { rows } = await db.query(q.listAnnouncements, [
      userId, school, role, yearOf(req), classId || null, scope || null, grade || null, authorId || null,
      req.query.mine === '1', req.query.unread === '1', search ? String(search).trim() || null : null, studentId || null, limit,
    ]);
    let failedSet = new Set();
    if (role === 'ADMIN' && rows.length) {
      const { rows: f } = await db.query(q.selectFailedEmailAnnouncements, [rows.map((r) => r.announcement_id)]);
      failedSet = new Set(f.map((r) => r.announcement_id));
    }
    const items = rows.map((r) => ({ ...toListItem(r, req.user), ...(role === 'ADMIN' ? { emailFailed: failedSet.has(r.announcement_id) } : {}) }));
    return res.status(200).json({ status: 'success', data: items });
  } catch (error) {
    logger.error('Error listing announcements:', error);
    return failed(res, 500, 'Error loading announcements');
  }
};

// GET /api/announcements/unread-count
const unreadCount = async (req, res) => {
  try {
    const { rows: [r] } = await db.query(q.countUnreadAnnouncements, [req.user.userId, req.user.school, req.user.role, yearOf(req)]);
    return res.status(200).json({ status: 'success', data: { unreadAnnouncements: r?.unread_announcements ?? 0 } });
  } catch (error) {
    logger.error('Error counting unread announcements:', error);
    return failed(res, 500, 'Error loading unread count');
  }
};

// GET /api/announcements/targets
const targets = async (req, res) => {
  const { userId, school, role } = req.user;
  if (!isStaff(req.user)) return failed(res, 403, 'Staff access required');
  try {
    const term = await currentTermParams(req);
    const [{ rows: classes }, { rows: grades }, { rows: schoolRows }] = await Promise.all([
      db.query(q.selectStaffClasses, [userId, school, role, yearOf(req), ...term]),
      db.query(q.selectStaffGrades, [userId, school, role, yearOf(req)]),
      db.query(schoolQueries.selectSchoolByCode, [school]),
    ]);
    // Where replies land, so the author can see it before posting. Office
    // addresses that belong to an account in the school show by name.
    const sender = schoolSender({ school, schoolInfo: schoolRows[0] || null, role: 'messages' });
    const replyTo = sender.replyTo ?? [];
    const { rows: named } = replyTo.length ? await db.query(q.selectUserNamesByEmail, [school, replyTo]) : { rows: [] };
    const nameOf = new Map(named.map((u) => [u.email, u.name || null]));
    return res.status(200).json({
      status: 'success',
      data: {
        classes: classes.map((c) => ({ classId: c.class_id, subject: c.subject, grade: c.grade, studentCount: c.student_count })),
        grades: grades.map((g) => ({ grade: g.grade, studentCount: g.student_count })),
        canSchool: role === 'ADMIN',
        // A teacher with no class and no homeroom has nobody to hand-pick.
        canCustom: role === 'ADMIN' || classes.length > 0 || grades.length > 0,
        sender: {
          from: senderAddress(sender.from),
          replyTo: replyTo.map((email) => ({ email, name: nameOf.get(email) ?? null })),
          includesAuthor: role === 'TEACHER',
          canEdit: role === 'ADMIN',
        },
      },
    });
  } catch (error) {
    logger.error('Error loading announcement targets:', error);
    return failed(res, 500, 'Error loading targets');
  }
};

// GET /api/announcements/students — the roster a custom audience is picked from.
const students = async (req, res) => {
  const { userId, school, role } = req.user;
  if (!isStaff(req.user)) return failed(res, 403, 'Staff access required');
  try {
    const term = await currentTermParams(req);
    const { rows } = await db.query(q.selectPickableStudents, [userId, school, role, yearOf(req), ...term]);
    return res.status(200).json({
      status: 'success',
      data: rows.map((s) => ({ studentId: s.student_id, name: s.name, grade: s.grade ?? null, classes: s.classes ?? [], guardianNames: s.guardian_names ?? [], hasEmail: Boolean(s.has_email) })),
    });
  } catch (error) {
    logger.error('Error loading pickable students:', error);
    return failed(res, 500, 'Error loading students');
  }
};

// GET /api/announcements/preview?scope=&classId=&grade=   |   POST /api/announcements/preview { scope: 'custom', studentIds[] }
// (POST exists because 500 ids do not fit a query string.)
const preview = async (req, res) => {
  const a = parseAudience({ ...req.query, ...(req.body || {}) });
  if (a.error) return failed(res, 400, a.error);
  const { scope, classId, grade, studentIds } = a;
  try {
    const check = await checkScope(req.user, scope, classId, grade, yearOf(req), studentIds);
    if (check.error) return failed(res, check.error[0], check.error[1]);
    const { rows: [r] } = await db.query(q.selectAudiencePreview, [req.user.school, scope, classId, grade, yearOf(req), studentIds]);
    return res.status(200).json({
      status: 'success',
      data: {
        students: r?.students ?? 0,
        guardiansWithAccount: r?.guardians_with_account ?? 0,
        guardiansInvitePending: r?.guardians_invite_pending ?? 0,
        guardiansEmailOnly: r?.guardians_email_only ?? 0,
        studentsWithoutEmail: r?.students_without_email ?? [],
        // Students whose own login would get the email (school switch and grade permitting).
        studentsWithAccount: r?.students_with_account ?? 0,
      },
    });
  } catch (error) {
    logger.error('Error previewing announcement audience:', error);
    return failed(res, 500, 'Error loading audience');
  }
};

// POST /api/announcements/preview-email  { scope, classId?, grade?, title, body, attachmentCount?, to?[] }
// Emails one copy, exactly as a guardian with an account will get it, to the
// author or to up to MAX_PREVIEW_RECIPIENTS addresses they name (a colleague,
// the principal). Each address gets its own send. Same validation and scope
// rules as posting; nothing is stored or queued.
const previewEmail = async (req, res) => {
  const a = parseAudience(req.body || {});
  if (a.error) return failed(res, 400, a.error);
  const { scope, classId, grade, studentIds } = a;
  const v = validateFields({ title: req.body.title, body: req.body.body });
  if (v.error) return failed(res, 400, v.error);
  const to = [...new Set([].concat(req.body.to ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (to.length === 0) {
    if (!req.user.email) return failed(res, 400, 'Your account has no email address to send the preview to');
    to.push(String(req.user.email).trim().toLowerCase());
  }
  if (to.length > MAX_PREVIEW_RECIPIENTS) return failed(res, 400, `Send the preview to at most ${MAX_PREVIEW_RECIPIENTS} addresses`);
  const malformed = to.find((e) => !EMAIL_RE.test(e));
  if (malformed) return failed(res, 400, `${malformed} is not a valid email address`);
  const attachmentCount = Math.max(0, Math.min(20, Number.parseInt(req.body.attachmentCount, 10) || 0));

  try {
    const check = await checkScope(req.user, scope, classId, grade, yearOf(req), studentIds);
    if (check.error) return failed(res, check.error[0], check.error[1]);
    const label = scopeLabel({ scope, grade, class_subject: check.classSubject, class_grade: check.classGrade });
    const { rows: schoolRows } = await db.query(schoolQueries.selectSchoolByCode, [req.user.school]);
    const authorName = req.user.username || 'SchoolMule';
    const ownEmail = String(req.user.email || '').trim().toLowerCase();
    const htmlFor = (addr) => getAnnouncementEmailHTML({
      // The author sees their own greeting; a colleague gets the neutral one.
      recipientFirstName: addr === ownEmail ? authorName.split(' ')[0] : null,
      authorName,
      scopeLabel: label,
      childNames: [],
      title: v.title,
      body: v.body,
      attachmentCount,
      link: `${process.env.FRONTEND_URL || ''}/messages?tab=announcements`,
      kind: 'account',
      schoolName: getSchoolName(req.user.school),
      schoolInfo: schoolRows[0] || null,
    });
    // Previews go to staff, so replies stay with the office list (no author prepended).
    const sender = schoolSender({ school: req.user.school, schoolInfo: schoolRows[0] || null, role: 'messages' });
    for (const addr of to) {
      await sendOrThrow(getResend(), {
        ...sender,
        to: [addr],
        subject: `[Preview] ${label}: ${v.title}`,
        html: htmlFor(addr),
      });
    }
    return res.status(200).json({ status: 'success', data: { sentTo: to } });
  } catch (error) {
    logger.error('Error sending announcement preview email:', error);
    return failed(res, 500, 'Could not send the preview email');
  }
};

// POST /api/announcements  (multipart: scope, classId?, grade?, studentIds[]?, ackRequested?, sendEmail?, title, body, pinnedUntil?, files[])
// sendEmail (default true): false posts without emailing anyone, guardians or students.
const create = async (req, res) => {
  const user = req.user;
  const files = req.files || [];
  const a = parseAudience(req.body);
  if (a.error) return failed(res, 400, a.error);
  const { scope, classId, grade, studentIds } = a;
  const ackRequested = parseBool(req.body.ackRequested);
  const sendEmail = parseSendEmail(req.body.sendEmail);
  const v = validateFields(req.body);
  if (v.error) return failed(res, 400, v.error);

  try {
    const yearId = yearOf(req);
    const check = await checkScope(user, scope, classId, grade, yearId, studentIds);
    if (check.error) return failed(res, check.error[0], check.error[1]);

    const client = await db.connect();
    const uploaded = [];
    let row;
    try {
      await client.query('BEGIN');
      ({ rows: [row] } = await client.query(q.insertAnnouncement, [
        user.school, yearId, scope, classId, grade, v.title, v.body, user.userId, user.role, v.pinnedUntil, ackRequested, sendEmail,
      ]));
      // The enqueue runs after COMMIT and reads the audience, so the picked rows must land in this transaction.
      if (scope === 'custom') await client.query(q.insertAnnouncementStudents, [row.announcement_id, studentIds]);
      await storeFiles(client, row.announcement_id, user.school, files, uploaded);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      await removeObjects(uploaded);
      throw error;
    } finally {
      client.release();
    }

    // The post is committed; a queue hiccup must never fail the request.
    if (sendEmail) {
      try {
        await db.query(q.enqueueAnnouncementJobs, [row.announcement_id, EMAIL_DELAY]);
      } catch (error) {
        logger.error('Failed to queue announcement emails:', error);
      }
    }

    const item = toListItem({
      announcement_id: row.announcement_id, scope, class_id: classId,
      class_subject: check.classSubject ?? null, class_grade: check.classGrade ?? null, grade,
      title: v.title, body: v.body, author_id: user.userId, author_name: user.username, author_role: user.role,
      published_at: row.published_at, pinned_until: v.pinnedUntil, is_pinned: Boolean(v.pinnedUntil), edited_at: null,
      attachment_count: files.length, read: true, seen_count: 0, audience_count: 0, ack_requested: ackRequested,
      student_count: studentIds ? studentIds.length : 0, send_email: sendEmail,
    }, user);
    return res.status(201).json({ status: 'success', data: { ...item, attachments: await signedAttachments(row.announcement_id) } });
  } catch (error) {
    logger.error('Error creating announcement:', error);
    return failed(res, 500, 'Error posting announcement');
  }
};

// GET /api/announcements/:id
const get = async (req, res) => {
  const ann = req.announcement;
  const user = req.user;
  try {
    const [attachments, readRes] = await Promise.all([
      signedAttachments(ann.announcementId),
      db.query('SELECT read_at FROM announcement_reads WHERE announcement_id = $1 AND user_id = $2', [ann.announcementId, user.userId]),
    ]);
    const item = toListItem({ ...fromAccess(ann), read: readRes.rows.length > 0 }, user);
    if (!isStaff(user)) return res.status(200).json({ status: 'success', data: { ...item, attachments } });

    const [{ rows: receipts }, { rows: [stats] }, { rows: picked }, { rows: [studentCounts] }] = await Promise.all([
      db.query(q.selectReceipts, [ann.announcementId]),
      db.query(q.selectEmailStats, [ann.announcementId]),
      ann.scope === 'custom' ? db.query(q.selectAnnouncementStudents, [ann.announcementId]) : Promise.resolve({ rows: null }),
      db.query(q.selectStudentCounts, [ann.announcementId]),
    ]);
    const shape = (r) => ({ userId: r.user_id, name: r.name, relation: r.relation, studentNames: r.student_names || [], readAt: r.read_at, ackedAt: r.acked_at ?? null, state: r.state });
    const seen = receipts.filter((r) => r.state === 'seen').map(shape);
    const notYet = receipts.filter((r) => r.state !== 'seen').map(shape);
    return res.status(200).json({
      status: 'success',
      data: {
        ...item,
        attachments,
        seenCount: seen.length,
        ackCount: receipts.filter((r) => r.acked_at).length,
        // Guardian accounts that can read: linked, not pending, not email-only.
        audienceCount: receipts.filter((r) => r.user_id && r.state !== 'invited' && r.state !== 'no-account').length,
        studentAudienceCount: studentCounts?.student_audience_count ?? 0,
        studentSeenCount: studentCounts?.student_seen_count ?? 0,
        receipts: { seen, notYet },
        ...(picked ? { students: picked.map((p) => ({ studentId: p.student_id, name: p.name, grade: p.grade ?? null })) } : {}),
        emails: { sent: stats?.sent ?? 0, pending: stats?.pending ?? 0, failed: stats?.failed ?? 0, signup: stats?.signup ?? 0, invite: stats?.invite ?? 0 },
      },
    });
  } catch (error) {
    logger.error('Error loading announcement:', error);
    return failed(res, 500, 'Error loading announcement');
  }
};

// PATCH /api/announcements/:id  (multipart: title?, body?, pinnedUntil?, ackRequested?, studentIds[]? (custom only), removeAttachmentIds?, files[])
const update = async (req, res) => {
  const ann = req.announcement;
  if (!canMutate(ann, req.user)) return failed(res, 403, 'Only the author or an admin can edit this announcement');
  // An unchanged pin (even one that has expired) is not a new date in the past.
  const pinUnchanged = req.body.pinnedUntil !== undefined && String(req.body.pinnedUntil) === String(ann.pinnedUntil ?? '');
  const v = validateFields(pinUnchanged ? { ...req.body, pinnedUntil: undefined } : req.body, { partial: true });
  if (v.error) return failed(res, 400, v.error);
  const removeIds = [].concat(req.body.removeAttachmentIds ?? []).filter(Boolean);
  if (badId(...removeIds)) return failed(res, 400, 'Invalid id');
  const files = req.files || [];
  // A custom post may change who it reaches; the other scopes are frozen.
  let studentIds = null;
  if (req.body.studentIds !== undefined) {
    if (ann.scope !== 'custom') return failed(res, 400, 'Only custom announcements can change their students');
    const parsed = parseStudentIds(req.body.studentIds);
    if (parsed.error) return failed(res, 400, parsed.error);
    studentIds = parsed.ids;
  }
  const ackRequested = req.body.ackRequested === undefined ? ann.ackRequested : parseBool(req.body.ackRequested);
  try {
    if (studentIds) {
      // Checked against the post's own year: an old custom post is edited against its own cohort.
      const check = await checkScope(req.user, 'custom', null, null, ann.schoolYearId ?? yearOf(req), studentIds);
      if (check.error) return failed(res, check.error[0], check.error[1]);
    }
    const client = await db.connect();
    const uploaded = [];
    let removedPaths = [];
    let editedAt = ann.editedAt;
    const title = v.title ?? ann.title;
    const body = v.body ?? ann.body;
    const pinnedUntil = v.pinnedUntil === undefined ? ann.pinnedUntil : v.pinnedUntil;
    try {
      await client.query('BEGIN');
      const { rows: [u] } = await client.query(q.updateAnnouncement, [ann.announcementId, title, body, pinnedUntil, ackRequested]);
      editedAt = u?.edited_at ?? editedAt;
      if (removeIds.length) ({ rows: removedPaths } = await client.query(q.deleteAttachmentsByIds, [ann.announcementId, removeIds]));
      await storeFiles(client, ann.announcementId, ann.school, files, uploaded);
      // Attachments changing is an edit families should notice, like the words.
      if (removeIds.length || files.length) {
        const { rows: [t] } = await client.query(q.touchEdited, [ann.announcementId]);
        editedAt = t?.edited_at ?? editedAt;
      }
      if (studentIds) {
        await client.query(q.insertAnnouncementStudents, [ann.announcementId, studentIds]);
        await client.query(q.deleteAnnouncementStudentsNotIn, [ann.announcementId, studentIds]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      await removeObjects(uploaded);
      throw error;
    } finally {
      client.release();
    }
    await removeObjects(removedPaths.map((p) => p.file_path));
    if (studentIds) {
      // Families no longer in the audience lose their pending email first (the
      // send path double-checks membership too); then new families get one, and
      // a family picked again after being removed gets its skipped job back.
      try {
        await db.query(q.cancelJobsOutsideAudience, [ann.announcementId]);
      } catch (error) {
        logger.error('Failed to cancel announcement emails after an audience change:', error);
      }
      // A post made without email stays without email when its selection changes.
      if (ann.sendEmail !== false) {
        try {
          await db.query(q.enqueueAnnouncementJobs, [ann.announcementId, EMAIL_DELAY]);
        } catch (error) {
          logger.error('Failed to queue announcement emails after an audience change:', error);
        }
      }
    }
    const item = toListItem({
      ...fromAccess(ann), title, body, pinned_until: pinnedUntil, edited_at: editedAt, read: true, ack_requested: ackRequested,
      student_count: studentIds ? studentIds.length : ann.studentCount,
    }, req.user);
    return res.status(200).json({ status: 'success', data: { ...item, attachments: await signedAttachments(ann.announcementId) } });
  } catch (error) {
    logger.error('Error editing announcement:', error);
    return failed(res, 500, 'Error saving announcement');
  }
};

// DELETE /api/announcements/:id
const remove = async (req, res) => {
  const ann = req.announcement;
  if (!canMutate(ann, req.user)) return failed(res, 403, 'Only the author or an admin can remove this announcement');
  try {
    const { rows: paths } = await db.query(q.selectAttachmentPaths, [ann.announcementId]);
    await removeObjects(paths.map((p) => p.file_path));
    await db.query(q.deleteAllAttachments, [ann.announcementId]);
    await db.query(q.cancelPendingAnnouncementJobs, [ann.announcementId]);
    const { rows: [d] } = await db.query(q.softDeleteAnnouncement, [ann.announcementId, req.user.userId]);
    return res.status(200).json({ status: 'success', data: { announcementId: ann.announcementId, deletedAt: d?.deleted_at ?? null } });
  } catch (error) {
    logger.error('Error removing announcement:', error);
    return failed(res, 500, 'Error removing announcement');
  }
};

// POST /api/announcements/:id/read
const markRead = async (req, res) => {
  try {
    const { rows: [r] } = await db.query(q.upsertRead, [req.announcement.announcementId, req.user.userId]);
    return res.status(200).json({ status: 'success', data: { readAt: r?.read_at ?? null } });
  } catch (error) {
    logger.error('Error marking announcement read:', error);
    return failed(res, 500, 'Error updating announcement');
  }
};

// POST /api/announcements/:id/ack — "Got it". Only a guardian in the audience
// (whatever their role) and only when the author asked for it. Acknowledging
// implies having read it.
const acknowledge = async (req, res) => {
  const ann = req.announcement;
  if (!ann.isGuardian) return failed(res, 403, 'Only a guardian in the audience can acknowledge this');
  if (!ann.ackRequested) return res.status(409).json({ status: 'failed', code: 'ACK_NOT_REQUESTED', message: 'This announcement does not ask for acknowledgement' });
  try {
    await db.query(q.upsertRead, [ann.announcementId, req.user.userId]);
    const { rows: [r] } = await db.query(q.upsertAck, [ann.announcementId, req.user.userId]);
    return res.status(200).json({ status: 'success', data: { ackedAt: r?.acked_at ?? null } });
  } catch (error) {
    logger.error('Error acknowledging announcement:', error);
    return failed(res, 500, 'Error updating announcement');
  }
};

// DELETE /api/announcements/:id/ack — undo.
const unacknowledge = async (req, res) => {
  const ann = req.announcement;
  if (!ann.isGuardian) return failed(res, 403, 'Only a guardian in the audience can acknowledge this');
  try {
    await db.query(q.deleteAck, [ann.announcementId, req.user.userId]);
    return res.status(200).json({ status: 'success', data: { ackedAt: null } });
  } catch (error) {
    logger.error('Error withdrawing announcement acknowledgement:', error);
    return failed(res, 500, 'Error updating announcement');
  }
};

// POST /api/announcements/:id/emails/retry  (admin)
const retryEmails = async (req, res) => {
  if (req.user.role !== 'ADMIN') return failed(res, 403, 'Admin access required');
  try {
    const { rows } = await db.query(q.retryFailedAnnouncementJobs, [req.announcement.announcementId]);
    return res.status(200).json({ status: 'success', data: { requeued: rows.length } });
  } catch (error) {
    logger.error('Error retrying announcement emails:', error);
    return failed(res, 500, 'Error retrying emails');
  }
};

// GET /api/announcements/:id/attachments/:attachmentId/url
const attachmentUrl = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectAttachment, [req.params.attachmentId, req.announcement.announcementId]);
    if (!rows.length) return failed(res, 404, 'Attachment not found');
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(rows[0].file_path, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) return failed(res, 500, 'Could not open attachment');
    return res.status(200).json({ status: 'success', data: { url: data.signedUrl, fileName: rows[0].file_name, mimeType: rows[0].mime_type } });
  } catch (error) {
    logger.error('Error signing announcement attachment:', error);
    return failed(res, 500, 'Could not open attachment');
  }
};

module.exports = {
  list, unreadCount, targets, students, preview, previewEmail, create, get, update, remove, markRead, acknowledge, unacknowledge,
  retryEmails, attachmentUrl, validateFields, toListItem,
};
