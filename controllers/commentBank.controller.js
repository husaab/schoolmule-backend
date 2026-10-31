// controllers/commentBank.controller.js
//
// A class's standard progress comments: one sentence per Core Standards level
// and per Work Habits rating, and the mark cut-offs that suggest a level. The
// Progress Comments tab builds a student's comment from them; a class with
// nothing saved uses SchoolMule's starter set (the web's src/lib/commentBank.ts).
//
//   GET    /api/comment-banks/class/:classId   the saved bank, or null
//   PUT    /api/comment-banks/class/:classId   { coreStandards, workHabits, cutoffs }
//   DELETE /api/comment-banks/class/:classId   back to the starter set
//   GET    /api/comment-banks/mine             the caller's classes with a saved
//                                              bank in the selected school year

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/commentBank.queries');

const CORE_STANDARDS_KEYS = ['exceeding', 'meeting', 'workingTowards', 'notMeeting'];
const WORK_HABIT_KEYS = ['E', 'G', 'S', 'N'];
const CUTOFF_KEYS = ['exceeding', 'meeting', 'workingTowards'];
const SENTENCE_MAX = 600;

const MESSAGES = {
  empty: 'Every standard comment needs text.',
  tooLong: `Each standard comment can be up to ${SENTENCE_MAX} characters.`,
  cutoffs: 'Cut-offs must go Exceeding, then Meeting, then Working towards, from high to low, between 0 and 100.',
};

/** The trimmed sentences for `keys` out of `source`, or the reason they can't be saved. */
function readSentences(source, keys) {
  const out = {};
  for (const key of keys) {
    const value = source && typeof source[key] === 'string' ? source[key].trim() : '';
    if (!value) return { error: MESSAGES.empty };
    if (value.length > SENTENCE_MAX) return { error: MESSAGES.tooLong };
    out[key] = value;
  }
  return { value: out };
}

/** The bank to store (only its known keys), or the message explaining why it can't be. */
function validateBank(body) {
  const coreStandards = readSentences(body && body.coreStandards, CORE_STANDARDS_KEYS);
  if (coreStandards.error) return { error: coreStandards.error };
  const workHabits = readSentences(body && body.workHabits, WORK_HABIT_KEYS);
  if (workHabits.error) return { error: workHabits.error };

  const raw = (body && body.cutoffs) || {};
  const cutoffs = {};
  for (const key of CUTOFF_KEYS) {
    const n = raw[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) return { error: MESSAGES.cutoffs };
    cutoffs[key] = n;
  }
  if (!(cutoffs.exceeding > cutoffs.meeting && cutoffs.meeting > cutoffs.workingTowards)) return { error: MESSAGES.cutoffs };

  return { value: { coreStandards: coreStandards.value, workHabits: workHabits.value, cutoffs } };
}

const toBank = (row) => ({ coreStandards: row.core_standards, workHabits: row.work_habits, cutoffs: row.cutoffs });

const getForClass = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectForClass, [req.params.classId]);
    return res.status(200).json({ status: 'success', data: rows[0] ? toBank(rows[0]) : null });
  } catch (error) {
    logger.error({ err: error }, 'Error loading comment bank');
    return res.status(500).json({ status: 'failed', message: "The standard comments couldn't be loaded" });
  }
};

const putForClass = async (req, res) => {
  const { value, error } = validateBank(req.body);
  if (error) return res.status(400).json({ status: 'failed', message: error });
  try {
    const { rows } = await db.query(q.upsert, [
      req.params.classId,
      JSON.stringify(value.coreStandards),
      JSON.stringify(value.workHabits),
      JSON.stringify(value.cutoffs),
      req.user.userId,
    ]);
    return res.status(200).json({ status: 'success', data: toBank(rows[0]) });
  } catch (err) {
    logger.error({ err }, 'Error saving comment bank');
    return res.status(500).json({ status: 'failed', message: "The standard comments couldn't be saved" });
  }
};

const deleteForClass = async (req, res) => {
  try {
    await db.query(q.deleteForClass, [req.params.classId]);
    return res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error({ err: error }, 'Error resetting comment bank');
    return res.status(500).json({ status: 'failed', message: "The standard comments couldn't be reset" });
  }
};

const listMine = async (req, res) => {
  const schoolYearId = req.schoolYear && req.schoolYear.schoolYearId;
  if (!schoolYearId) return res.status(200).json({ status: 'success', data: [] });
  try {
    const { rows } = await db.query(q.selectMine, [req.user.userId, schoolYearId]);
    return res.status(200).json({
      status: 'success',
      data: rows.map((r) => ({ classId: r.class_id, grade: r.grade, subject: r.subject, termName: r.term_name })),
    });
  } catch (error) {
    logger.error({ err: error }, 'Error listing comment banks');
    return res.status(500).json({ status: 'failed', message: "Your classes' standard comments couldn't be loaded" });
  }
};

module.exports = { getForClass, putForClass, deleteForClass, listMine, validateBank };
