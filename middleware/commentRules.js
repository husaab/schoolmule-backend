// middleware/commentRules.js
//
// Guards for the routes that write report card and progress report comments
// (services/reportComments/rules.js). They run after the route's access guard.
//
//   guardClassComments(kind, entriesOf)   grades 1-8: the class's lock, then
//                                         the school's maximum words
//   guardKindergartenComments(kinds, source)  JK and SK: the term's lock, for
//                                         a comment that would change
//
// A locked write is a 409 COMMENTS_LOCKED and a comment over the maximum a
// 400 COMMENT_TOO_LONG, so the web and the app can say why nothing saved.
// Holders of school_setup pass a lock (they review); the maximum applies to
// everyone.

const logger = require('../logger');
const { withAccess } = require('./access');
const { countWords } = require('../utils/wordCount');
const rules = require('../services/reportComments/rules');

const LOCKED_MESSAGE = {
  report_card: 'Report card comments are locked while the school reviews them, so this change was not saved.',
  progress_report: 'Progress report comments are locked while the school reviews them, so this change was not saved.',
};

const locked = (res, kind) => res.status(409).json({
  status: 'failed',
  code: 'COMMENTS_LOCKED',
  message: LOCKED_MESSAGE[kind],
});

const invalid = (res, message) => res.status(400).json({ status: 'failed', code: 'INVALID_COMMENT_ENTRY', message });

const failed = (res, err) => {
  logger.error({ err }, 'Error checking the comment rules');
  return res.status(500).json({ status: 'failed', message: 'Error checking the comment rules' });
};

/**
 * entriesOf(req) → [{ classId, studentId, comment }] for what the request
 * would write (comment undefined when it writes none, e.g. a delete).
 * Entries without a class are left to the controller's own validation.
 */
const guardClassComments = (kind, entriesOf) => withAccess(async (req, res, next) => {
  const entries = (entriesOf(req) || []).filter((e) => e && e.classId);
  if (entries.length === 0) return next();

  // A comment is text or nothing: anything else would be stored without ever being counted.
  if (entries.some((e) => e.comment !== undefined && e.comment !== null && typeof e.comment !== 'string')) {
    return invalid(res, 'A comment must be text.');
  }

  try {
    // One set of rules per entry, matched by position: the database reads the
    // class ids, so no spelling of an id can miss its class's rules.
    const found = await rules.classRules(entries.map((e) => e.classId), [kind]);
    // The access guard has already found every class, so an entry without
    // rules is one this guard failed to look up: refuse rather than let the
    // write through unchecked.
    if (found.some((cls) => !cls || !cls.rules[kind])) return invalid(res, 'Invalid class id.');
    const checked = entries.map((e, i) => ({ ...e, rule: found[i].rules[kind] }));

    if (!rules.canReview(req) && checked.some((e) => e.rule.locked)) return locked(res, kind);

    const over = checked.filter((e) => e.rule.maxWords != null && typeof e.comment === 'string' && countWords(e.comment) > e.rule.maxWords);
    if (over.length > 0) {
      // A comment that was already saved over the limit (it was written before
      // the limit, or by an older app) may be sent again unchanged, so a rating
      // can still be saved for that student. An entry with no student to look
      // up counts as changed.
      const known = over.filter((e) => e.studentId);
      const saved = await rules.savedComments(kind, known);
      const unchanged = new Set(known.filter((e, i) => saved[i] === e.comment));
      const changed = over.filter((e) => !unchanged.has(e));
      if (changed.length > 0) {
        const { maxWords } = changed[0].rule;
        return res.status(400).json({
          status: 'failed',
          code: 'COMMENT_TOO_LONG',
          message: `A comment can be at most ${maxWords} words. Shorten it to save.`,
          maxWords,
          studentIds: [...new Set(changed.map((e) => e.studentId).filter(Boolean))],
        });
      }
    }
    return next();
  } catch (err) {
    return failed(res, err);
  }
});

/**
 * JK and SK comment saves: body { entries: [{ studentId, term, comment, ... }] }.
 * `kinds` are the documents the comments print on (SK subject comments print
 * on both), `source` the kind of comment (queries KINDERGARTEN_COMMENTS).
 *
 * Their pages save a student's whole document, ratings and comments together,
 * so a save that only repeats the saved comments passes: the ratings beside
 * them still save. Only a comment that would change is refused.
 */
const guardKindergartenComments = (kinds, source) => withAccess(async (req, res, next) => {
  const entries = (Array.isArray(req.body && req.body.entries) ? req.body.entries : [])
    .filter((e) => e && e.studentId && typeof e.term === 'string');
  if (entries.length === 0 || rules.canReview(req)) return next();

  try {
    const lockedTerms = await rules.lockedTermNames(
      req.user.school,
      req.schoolYear && req.schoolYear.schoolYearId,
      entries.map((e) => e.term),
      kinds,
    );
    const inLockedTerms = entries.filter((e) => lockedTerms.has(e.term));
    if (inLockedTerms.length === 0) return next();
    return (await rules.kindergartenCommentsChange(source, inLockedTerms)) ? locked(res, kinds[0]) : next();
  } catch (err) {
    return failed(res, err);
  }
});

module.exports = { guardClassComments, guardKindergartenComments };
