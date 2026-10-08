// Guards /api/messaging/conversations/:id/*.
//
// Membership is derived at request time (never stored) from parent_students,
// classes.teacher_id and class_teachers, so a guardian linked after the
// thread began sees it. Admins of the school always pass. A conversation
// from another school — or an unknown id — is a 404 so tenants cannot probe
// each other; a malformed id is a 403 like verifyParentOwnsStudent.
//
// On success: req.conversation = { conversationId, school, studentId,
//   studentName, classId, classSubject, assessmentId, title, status,
//   leadTeacherId, teacherIds, guardianIds, adminParticipantIds,
//   schoolYearId, lastMessageAt, createdAt }

const db = require('../config/database');
const logger = require('../logger');
const queries = require('../queries/messaging.queries');

const NOT_FOUND = { status: 'failed', message: 'Conversation not found' };
const NOT_AUTHORIZED = { status: 'failed', message: 'Not authorized for this conversation' };

/** Flatten an access row into the shape the controller works with. */
const accessRowToConversation = (c) => ({
  conversationId: c.conversation_id,
  school: c.school,
  studentId: c.student_id,
  studentName: c.student_name,
  classId: c.class_id,
  classSubject: c.class_subject,
  assessmentId: c.assessment_id,
  title: c.title,
  status: c.status,
  leadTeacherId: c.lead_teacher_id,
  teacherIds: [c.lead_teacher_id, ...(c.co_teacher_ids || [])].filter(Boolean),
  guardianIds: c.guardian_ids || [],
  adminParticipantIds: c.admin_participant_ids || [],
  schoolYearId: c.school_year_id,
  lastMessageAt: c.last_message_at,
  createdAt: c.created_at,
});

const isMember = (conv, user) =>
  user.role === 'ADMIN' ||
  (user.role === 'TEACHER' && conv.teacherIds.includes(user.userId)) ||
  (user.role === 'PARENT' && conv.guardianIds.includes(user.userId));

const requireConversationAccess = async (req, res, next) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(queries.selectConversationAccess, [id]);
    if (rows.length === 0) return res.status(404).json(NOT_FOUND);
    if (rows[0].school !== req.user.school) return res.status(404).json(NOT_FOUND);

    const conv = accessRowToConversation(rows[0]);
    if (!isMember(conv, req.user)) return res.status(403).json(NOT_AUTHORIZED);

    req.conversation = conv;
    return next();
  } catch (error) {
    logger.error('Error verifying conversation access:', error);
    return res.status(403).json(NOT_AUTHORIZED);
  }
};

module.exports = requireConversationAccess;
module.exports.accessRowToConversation = accessRowToConversation;
