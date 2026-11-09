// services/messageCorrections.js
//
// The "corrected version" email a sender can ask for when editing a message
// that has already gone out by email (kind message_correction in
// services/email/outbox.js). Built when it is sent, from the message as it is
// then: the current words and the files on it now.

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/messaging.queries');
const schoolQueries = require('../queries/school.queries');
const { emailAttachments } = require('../utils/attachmentUpload');
const { schoolSender } = require('./email/senderIdentity');
const { getSchoolName } = require('../utils/schoolUtils');
const { getConversationDigestEmailHTML } = require('../templates/emailTemplate');
const { messageLink, timeLabel } = require('./messageNotifier');

function correctionSubject(ctx) {
  const sender = ctx.sender_name || 'SchoolMule';
  const general = Boolean(ctx.includes_student && !ctx.assessment_id && !ctx.classwork_item_id);
  if (ctx.recipient_role === 'STUDENT' || general) return `${sender} corrected a message: ${ctx.title}`;
  return `${sender} corrected a message about ${ctx.student_name}'s ${ctx.title}`;
}

async function loadSchoolInfo(school) {
  try {
    const { rows } = await db.query(schoolQueries.selectSchoolByCode, [school]);
    return rows[0] || null;
  } catch (error) {
    logger.warn('School lookup failed for a corrected message email:', error);
    return null;
  }
}

const messageCorrectionHandler = {
  async build(job) {
    const { rows: [ctx] } = await db.query(q.selectCorrectionContext, [job.payload.messageId, job.recipient_user_id]);
    if (!ctx) return { skip: 'Message not found' };
    if (ctx.deleted_at) return { skip: 'Message was removed' };
    if (ctx.recipient_archived) return { skip: 'Recipient archived' };
    if (ctx.muted) return { skip: 'Conversation muted' };

    const { rows: attachmentRows } = await db.query(q.selectAttachmentsByMessageIds, [[ctx.message_id]]);
    const { attachments, files } = await emailAttachments(attachmentRows);
    const schoolInfo = await loadSchoolInfo(job.school);
    const html = getConversationDigestEmailHTML({
      corrected: true,
      forStudent: ctx.recipient_role === 'STUDENT',
      parentsIncluded: !ctx.guardians_hidden && Boolean(ctx.has_guardians),
      recipientFirstName: ctx.recipient_first_name,
      studentName: ctx.student_name,
      className: ctx.class_subject,
      title: ctx.title,
      contextLine: null,
      messages: [{
        senderName: ctx.sender_name || 'SchoolMule',
        body: ctx.body,
        sentAtLabel: timeLabel(ctx.created_at),
        attachmentCount: attachmentRows.length,
        attachments: files,
      }],
      link: await messageLink(ctx, job.recipient_user_id, ctx.conversation_id),
      accountSetup: Boolean(ctx.recipient_invite_pending),
      schoolName: getSchoolName(job.school),
      schoolInfo,
    });
    return {
      message: {
        ...schoolSender({ school: job.school, schoolInfo, role: 'messages' }),
        to: [job.recipient_email],
        subject: correctionSubject(ctx),
        html,
        ...(attachments.length ? { attachments } : {}),
      },
      sentContent: { messageId: ctx.message_id, fileCount: attachmentRows.length },
    };
  },
};

module.exports = { messageCorrectionHandler };
