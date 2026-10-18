// Guards /api/student/conversations/:conversationId/* (after requireStudent).
//
// The same access projection as requireConversationAccess, with the STUDENT
// membership rule: the thread includes the student (includes_student) and
// the caller's own live login is linked to the thread's student row. An
// older parent–teacher thread about the student never passes, and nothing
// here takes a student id from the client. Another school's thread, or an
// unknown id, is a 404; a thread the student is not in is a 403.
//
// On success: req.conversation (the requireConversationAccess shape).

const db = require('../config/database');
const logger = require('../logger');
const queries = require('../queries/messaging.queries');
const { accessRowToConversation, isMember } = require('./requireConversationAccess');

const NOT_FOUND = { status: 'failed', message: 'Conversation not found' };
const NOT_AUTHORIZED = { status: 'failed', message: 'Not authorized for this conversation' };

const requireStudentConversationAccess = async (req, res, next) => {
  if (req.user?.role !== 'STUDENT') return res.status(403).json(NOT_AUTHORIZED);
  try {
    const { rows } = await db.query(queries.selectConversationAccess, [req.params.conversationId]);
    if (rows.length === 0 || rows[0].school !== req.user.school) return res.status(404).json(NOT_FOUND);

    const conv = accessRowToConversation(rows[0]);
    if (!isMember(conv, req.user)) return res.status(403).json(NOT_AUTHORIZED);

    req.conversation = conv;
    return next();
  } catch (error) {
    logger.error({ err: error }, 'Error verifying student conversation access');
    return res.status(403).json(NOT_AUTHORIZED);
  }
};

module.exports = requireStudentConversationAccess;
