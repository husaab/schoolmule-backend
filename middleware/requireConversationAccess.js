// Guards /api/messaging/conversations/:id/*.
//
// Membership is derived at request time (never stored) from parent_students,
// classes.teacher_id and class_teachers, so a guardian linked after the
// thread began sees it. Admins of the school always pass. A conversation
// from another school — or an unknown id — is a 404 so tenants cannot probe
// each other; a malformed id is a 403 like verifyParentOwnsStudent.
//
// Student portal (T17): a STUDENT is a member only of a thread that includes
// the student (includes_student) through their own live login, never of an
// older parent–teacher thread about them. Guardians are always derived in,
// except on an item thread the school keeps from guardians
// (guardians_hidden): then guardianIds is empty, so they are not members and
// get no email.
//
// On success: req.conversation = { conversationId, school, studentId,
//   studentName, classId, classSubject, assessmentId, title, status,
//   leadTeacherId, teacherIds, guardianIds, adminParticipantIds,
//   schoolYearId, lastMessageAt, createdAt, includesStudent,
//   classworkItemId, studentUserIds, guardiansHidden }

const db = require('../config/database');
const logger = require('../logger');
const { can } = require('../services/access/access');
const { withAccess } = require('./access');
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
  kind: c.kind || 'assessment',
  teacherId: c.teacher_id || null,
  title: c.title,
  status: c.status,
  leadTeacherId: c.lead_teacher_id,
  teacherIds: [c.lead_teacher_id, ...(c.co_teacher_ids || [])].filter(Boolean),
  guardianIds: c.guardians_hidden ? [] : c.guardian_ids || [],
  adminParticipantIds: c.admin_participant_ids || [],
  schoolYearId: c.school_year_id,
  lastMessageAt: c.last_message_at,
  createdAt: c.created_at,
  includesStudent: Boolean(c.includes_student),
  classworkItemId: c.classwork_item_id || null,
  studentUserIds: c.student_user_ids || [],
  guardiansHidden: Boolean(c.guardians_hidden),
});

// Staff: every thread with messages.all (RBAC; pass req), otherwise the
// threads they teach, are addressed to, or have joined. Without req (student
// callers) an ADMIN view counts as messages.all, as before.
const isMember = (conv, user, req = null) => {
  if (user.role === 'ADMIN' || user.role === 'TEACHER') {
    const seesAll = req ? can(req, 'messages.all') : user.role === 'ADMIN';
    return seesAll
      || conv.teacherIds.includes(user.userId)
      || conv.teacherId === user.userId
      || conv.adminParticipantIds.includes(user.userId);
  }
  if (user.role === 'PARENT') return conv.guardianIds.includes(user.userId);
  if (user.role === 'STUDENT') return conv.includesStudent && conv.studentUserIds.includes(user.userId);
  return false;
};

const requireConversationAccess = withAccess(async (req, res, next) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(queries.selectConversationAccess, [id]);
    if (rows.length === 0) return res.status(404).json(NOT_FOUND);
    if (rows[0].school !== req.user.school) return res.status(404).json(NOT_FOUND);

    const conv = accessRowToConversation(rows[0]);
    if (!isMember(conv, req.user, req)) return res.status(403).json(NOT_AUTHORIZED);

    req.conversation = conv;
    return next();
  } catch (error) {
    logger.error('Error verifying conversation access:', error);
    return res.status(403).json(NOT_AUTHORIZED);
  }
});

module.exports = requireConversationAccess;
module.exports.accessRowToConversation = accessRowToConversation;
module.exports.isMember = isMember;
