// middleware/requireClassroomResource.js
//
// requireClassroomResource('item' | 'topic' | 'attachment' | 'quizAnswer') guards the
// classroom routes addressed by a resource id instead of a class id. It loads
// the row, then its class, and applies requireClassOwnership's rule: the class
// is in the caller's school and the caller is an admin or teaches it (lead or
// co-teacher). A missing (or soft-deleted) row is a 404.
//
// On success req.class = { classId, school, teacherId } plus one of
// req.item = { itemId, classId }, req.topic = { topicId, classId },
// req.attachment = { attachmentId, itemId, kind, classId },
// req.quizAnswer = { answerId, attemptId, itemId, classId } (a quiz answer, by
// the item of its attempt).

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/classwork.queries');
const quizQueries = require('../queries/quiz.queries');

const NOT_AUTHORIZED = { status: 'failed', message: 'Not authorized for this class' };

const RESOURCES = {
  item: {
    param: 'itemId',
    sql: q.resourceItem,
    notFound: 'Item not found',
    attach: (req, row) => { req.item = { itemId: row.item_id, classId: row.class_id }; },
  },
  topic: {
    param: 'topicId',
    sql: q.resourceTopic,
    notFound: 'Topic not found',
    attach: (req, row) => { req.topic = { topicId: row.topic_id, classId: row.class_id }; },
  },
  attachment: {
    param: 'attachmentId',
    sql: q.resourceAttachment,
    notFound: 'Attachment not found',
    attach: (req, row) => {
      req.attachment = { attachmentId: row.attachment_id, itemId: row.item_id, kind: row.kind, classId: row.class_id };
    },
  },
  quizAnswer: {
    param: 'answerId',
    sql: quizQueries.resourceQuizAnswer,
    notFound: 'Answer not found',
    attach: (req, row) => {
      req.quizAnswer = { answerId: row.answer_id, attemptId: row.attempt_id, itemId: row.item_id, classId: row.class_id };
    },
  },
};

function requireClassroomResource(kind) {
  const spec = RESOURCES[kind];
  if (!spec) throw new Error(`Unknown classroom resource: ${kind}`);

  return async (req, res, next) => {
    try {
      const { rows } = await db.query(spec.sql, [req.params[spec.param], req.user.userId]);
      const row = rows[0];
      if (!row) return res.status(404).json({ status: 'failed', message: spec.notFound });

      if (row.school !== req.user.school) return res.status(403).json(NOT_AUTHORIZED);
      if (req.user.role === 'TEACHER') {
        if (row.teacher_id !== req.user.userId && !row.is_co_teacher) return res.status(403).json(NOT_AUTHORIZED);
      } else if (req.user.role !== 'ADMIN') {
        return res.status(403).json(NOT_AUTHORIZED);
      }

      req.class = { classId: row.class_id, school: row.school, teacherId: row.teacher_id };
      spec.attach(req, row);
      return next();
    } catch (error) {
      logger.error({ err: error, kind }, 'Error verifying classroom resource ownership');
      return res.status(500).json({ status: 'failed', message: 'Error checking access' });
    }
  };
}

module.exports = requireClassroomResource;
