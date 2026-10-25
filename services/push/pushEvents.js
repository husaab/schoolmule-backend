// services/push/pushEvents.js
//
// Where things that happen become push notifications. Every function here
// is called after the event is committed, never throws, and only queues for
// people who have the app (services/push/pushQueue sends).
//
//   onMessagePosted   at once, to each other person in the conversation
//   onAnnouncement    at once, to the post's families and students
//   onNewWork         2 minutes after classwork is posted, to its students
//   onGraded          when a 15-minute bucket of published grades closes
//   onDueReminders    the 5 pm sweep: work due tomorrow
//   fromEmail         beside an email that was just sent: a parent's new
//                     grades, a teacher's reply reminder, the office's
//                     escalation, a parent's nudge or missing-work alert
//
// Lock screens are public, so a notification never carries a score; a
// message shows its first line, as the email digest shows it whole.

const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/push.queries');
const pushQueue = require('./pushQueue');
const { threadPath } = require('../../utils/appPaths');
const { scopeLabel, parentPath, studentPath } = require('../../utils/announcementScope');
const digest = require('../classroom/classroomDigest');

const NEW_WORK_DELAY_MS = 2 * 60 * 1000;
const iso = (d) => new Date(d).toISOString();
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

const attachmentLine = (n) => (n > 1 ? `Sent ${n} attachments` : 'Sent an attachment');

/**
 * A new message: everyone else in the conversation who should hear about it
 * (not muted, can read the thread), once per message, grouped per thread.
 * `recipientIds` is the email digest's list, so both reach the same people.
 */
async function onMessagePosted(conv, senderId, recipientIds) {
  try {
    if (!recipientIds?.length) return 0;
    const [{ rows: targets }, { rows: [m] }] = await Promise.all([
      db.query(q.selectMessageTargets, [conv.conversationId, recipientIds]),
      db.query(q.selectLatestMessage, [conv.conversationId, senderId]),
    ]);
    if (!targets.length || !m) return 0;
    const body = pushQueue.preview(m.body) || (m.attachment_count ? attachmentLine(m.attachment_count) : 'New message');
    return await pushQueue.enqueue(targets.map((t) => ({
      recipientId: t.user_id,
      kind: 'message',
      category: 'messages',
      dedupeKey: `msg:${m.message_id}`,
      title: m.sender_name || 'New message',
      // A student knows who the thread is about; a parent or teacher sees the child's name.
      subtitle: [t.role === 'STUDENT' ? null : firstName(m.student_name), m.title].filter(Boolean).join(' · '),
      body,
      path: threadPath(t.role, conv.conversationId),
      threadKey: `conv:${conv.conversationId}`,
    })));
  } catch (error) {
    logger.warn({ err: error, conversationId: conv?.conversationId }, 'Queueing message push failed');
    return 0;
  }
}

/** A new announcement, or new people after its audience changed (the rest already have it). */
async function onAnnouncement(announcementId) {
  try {
    const { rows } = await db.query(q.selectAnnouncementTargets, [announcementId]);
    return await pushQueue.enqueue(rows.map((r) => ({
      recipientId: r.recipient_id,
      kind: 'announcement',
      category: 'announcements',
      dedupeKey: `ann:${r.announcement_id}`,
      title: r.title || 'New announcement',
      subtitle: scopeLabel(r),
      body: pushQueue.preview(r.body) || scopeLabel(r),
      path: r.as_student ? studentPath(r) : parentPath(r.announcement_id),
    })));
  } catch (error) {
    logger.warn({ err: error, announcementId }, 'Queueing announcement push failed');
    return 0;
  }
}

/** Classwork just posted (created, edited or promoted): its students, in 2 minutes. */
function onNewWork(itemIds, { now = new Date() } = {}) {
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  if (!ids.length) return Promise.resolve(0);
  return pushQueue.run('new work', q.enqueueNewWork, [ids, iso(now), iso(new Date(now).getTime() + NEW_WORK_DELAY_MS)]);
}

/**
 * Grades just published to students (Classwork) or on whole columns
 * (Grades): one notification per student per 15-minute bucket, like the email.
 */
async function onGraded({ school, studentIds = [], assessmentIds = [], now = new Date() }) {
  if (!school) return 0;
  const bucket = digest.gradedBucket(now);
  const tail = [school, bucket.key, iso(bucket.end)];
  const students = [...new Set(studentIds.filter(Boolean))];
  const columns = [...new Set(assessmentIds.filter(Boolean))];
  let queued = 0;
  if (students.length) queued += await pushQueue.run('graded', q.enqueueGraded, [students, ...tail]);
  if (columns.length) queued += await pushQueue.run('graded', q.enqueueGradedColumns, [columns, ...tail]);
  return queued;
}

/** The 5 pm sweep: turn-in work due on `dueDate` ('YYYY-MM-DD') and not turned in. */
function onDueReminders(now, dueDate) {
  return pushQueue.run('due reminders', q.enqueueDueReminders, [iso(now), dueDate]);
}

/**
 * Beside an email that just went out. `job` is its email row (an outbox row
 * or a classroom one): `recipient_user_id`/`recipient_id` or, for an office
 * address, the address and school. `push` is the handler's notification:
 * { category, title, body, path, subtitle?, userId? }.
 */
async function fromEmail(job, push) {
  try {
    if (!push) return 0;
    let userId = push.userId ?? job.recipient_user_id ?? job.recipient_id ?? null;
    if (!userId && job.recipient_email && job.school) {
      const { rows } = await db.query(q.selectUserByEmail, [job.recipient_email, job.school]);
      userId = rows[0]?.user_id ?? null;
    }
    if (!userId) return 0;
    return await pushQueue.enqueue([{
      recipientId: userId,
      kind: job.kind,
      category: push.category,
      dedupeKey: `email:${job.id ?? job.job_id}`,
      title: push.title,
      subtitle: push.subtitle,
      body: push.body,
      path: push.path,
    }]);
  } catch (error) {
    logger.warn({ err: error, kind: job?.kind }, 'Queueing push beside an email failed');
    return 0;
  }
}

module.exports = { onMessagePosted, onAnnouncement, onNewWork, onGraded, onDueReminders, fromEmail };
