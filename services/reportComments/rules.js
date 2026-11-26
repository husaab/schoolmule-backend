// Report comment rules: the word limits a school sets for the comments on its
// report cards and progress reports, and the review lock.
//
// Limits (grades 1-8): a comment over the maximum is refused when it is saved
// (unless it is the saved comment sent again); a comment under the minimum
// saves, and counts as not finished. Blank is always allowed.
//
// Lock: the whole term for a document, with a class's exception either way.
// While locked, only holders of school_setup can change the comments. JK and
// SK comments are not stored by class, so they follow the term's lock.

const db = require('../../config/database');
const queries = require('../../queries/reportComments.queries');
const { can } = require('../access/access');

const KINDS = ['report_card', 'progress_report'];
// A kind as the API's JSON spells it.
const KEY = { report_card: 'reportCard', progress_report: 'progressReport' };
const KIND_LABEL = { report_card: 'Report card', progress_report: 'Progress report' };
const MAX_WORDS_CEILING = 2000;

const isKind = (kind) => KINDS.includes(kind);
const isKindergarten = (grade) => grade === 'JK' || grade === 'SK';

/** Who may set the rules, lock and unlock, and change comments while they are locked. */
const canReview = (req) => can(req, 'school_setup');

const NO_LIMITS = () => ({ minWords: null, maxWords: null });

/** The school's limits: { reportCard: { minWords, maxWords }, progressReport: { ... } } (null = no limit). */
async function getLimits(school) {
  const { rows } = await db.query(queries.selectLimits, [school]);
  const limits = { reportCard: NO_LIMITS(), progressReport: NO_LIMITS() };
  for (const row of rows) {
    if (KEY[row.kind]) limits[KEY[row.kind]] = { minWords: row.min_words, maxWords: row.max_words };
  }
  return limits;
}

const readWords = (value) => {
  if (value === null || value === undefined || value === '') return { value: null };
  if (!Number.isInteger(value) || value < 1 || value > MAX_WORDS_CEILING) return { error: true };
  return { value };
};

/**
 * A PUT /limits body, checked: { value } in the shape getLimits returns, or
 * { error }. Each end is a whole number of words from 1 to 2000, or null for
 * no limit, and a minimum can't be above its maximum.
 */
function validateLimits(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Send the limits for reportCard and progressReport.' };
  }
  const value = {};
  for (const kind of KINDS) {
    const key = KEY[kind];
    const sent = body[key];
    if (typeof sent !== 'object' || sent === null || Array.isArray(sent)) {
      return { error: `Send the limits for ${key}.` };
    }
    const min = readWords(sent.minWords);
    const max = readWords(sent.maxWords);
    if (min.error || max.error) {
      return { error: `${KIND_LABEL[kind]} limits must be whole numbers of words from 1 to ${MAX_WORDS_CEILING}, or left blank.` };
    }
    if (min.value !== null && max.value !== null && min.value > max.value) {
      return { error: `${KIND_LABEL[kind]} comments: the minimum can't be more than the maximum.` };
    }
    value[key] = { minWords: min.value, maxWords: max.value };
  }
  return { value };
}

async function saveLimits(school, value, userId) {
  for (const kind of KINDS) {
    const { minWords, maxWords } = value[KEY[kind]];
    await db.query(queries.upsertLimit, [school, kind, minWords, maxWords, userId]);
  }
  return getLimits(school);
}

/**
 * The rules of each class id for the given documents, in the order the ids
 * were given: [{ school, grade, kindergarten, termId, rules: Record<kind,
 * { locked, lockScope, minWords, maxWords }> } | null]. Null where the id
 * names no class. Matched by position: the database alone reads the ids.
 */
async function classRules(classIds, kinds = KINDS) {
  const found = classIds.map(() => null);
  if (classIds.length === 0) return found;
  const { rows } = await db.query(queries.selectClassRules, [classIds, kinds]);
  for (const row of rows) {
    const at = row.ord - 1;
    if (at < 0 || at >= found.length) continue;
    if (!found[at]) {
      found[at] = { school: row.school, grade: row.grade, kindergarten: isKindergarten(row.grade), termId: row.term_id, rules: {} };
    }
    const cls = found[at];
    // JK and SK comments are not limited.
    cls.rules[row.kind] = {
      locked: Boolean(row.locked),
      lockScope: row.lock_scope || null,
      minWords: cls.kindergarten ? null : row.min_words,
      maxWords: cls.kindergarten ? null : row.max_words,
    };
  }
  return found;
}

/**
 * The comment saved for each (student, class) pair, in the order given: the
 * text, or null when nothing is saved (or the comment is blank).
 */
async function savedComments(kind, pairs) {
  const saved = pairs.map(() => null);
  if (pairs.length === 0) return saved;
  const { rows } = await db.query(queries.selectSavedComments(kind), [
    pairs.map((p) => p.studentId),
    pairs.map((p) => p.classId),
  ]);
  for (const row of rows) {
    if (row.ord >= 1 && row.ord <= saved.length) saved[row.ord - 1] = row.comment || null;
  }
  return saved;
}

/** The terms, of these names, that are locked for any of the documents in this school and year. (JK and SK.) */
async function lockedTermNames(school, schoolYearId, termNames, kinds) {
  const names = [...new Set(termNames.filter((n) => typeof n === 'string' && n))];
  if (names.length === 0) return new Set();
  const { rows } = await db.query(queries.selectLockedTermNames, [school, schoolYearId || null, names, kinds]);
  return new Set(rows.map((r) => r.name));
}

/**
 * Would these JK or SK entries change a comment that is saved? `source` names
 * the kind of comment (queries.KINDERGARTEN_COMMENTS). Blank and missing are
 * the same comment. Their pages save a student's whole document, so an entry
 * that only repeats what is saved changes nothing.
 */
async function kindergartenCommentsChange(source, entries) {
  const { field } = queries.KINDERGARTEN_COMMENTS[source];
  const keyOf = (studentId, term, item) => `${studentId}|${term}|${item}`;
  const { rows } = await db.query(queries.selectKindergartenComments(source), [
    [...new Set(entries.map((e) => e.studentId))],
    [...new Set(entries.map((e) => e.term))],
  ]);
  const saved = new Map(rows.map((r) => [keyOf(r.student_id, r.term, r.item), r.comment || '']));
  return entries.some((e) => (saved.get(keyOf(e.studentId, e.term, e[field])) || '') !== (e.comment || ''));
}

const termOf = (row) => ({ termId: row.term_id, name: row.name, isActive: Boolean(row.is_active) });

/** The school's term with this id, or the one a review opens on when no id is given. Null when there is none. */
async function findTerm(school, schoolYearId, termId) {
  const { rows } = termId
    ? await db.query(queries.selectTerm, [termId, school])
    : await db.query(queries.selectDefaultTerm, [school, schoolYearId || null]);
  return rows[0] ? termOf(rows[0]) : null;
}

const personName = (row) => [row.first_name, row.last_name].filter(Boolean).join(' ') || null;

/**
 * The review page: the limits, the term's lock for each document, and every
 * class of the term with its lock and how its comments stand.
 */
async function overview(school, term) {
  const limits = await getLimits(school);
  const termLocks = { reportCard: { locked: false, lockedAt: null, lockedBy: null }, progressReport: { locked: false, lockedAt: null, lockedBy: null } };
  if (!term) return { limits, term: null, termLocks, classes: [] };

  const { rows: lockRows } = await db.query(queries.selectTermLocks, [term.termId]);
  for (const row of lockRows) {
    if (KEY[row.kind]) termLocks[KEY[row.kind]] = { locked: true, lockedAt: row.locked_at, lockedBy: personName(row) };
  }

  const classes = new Map();
  for (const kind of KINDS) {
    const key = KEY[kind];
    const { minWords, maxWords } = limits[key];
    const { rows } = await db.query(queries.selectTermClasses(kind), [term.termId, kind, minWords, maxWords]);
    for (const row of rows) {
      let cls = classes.get(row.class_id);
      if (!cls) {
        cls = {
          classId: row.class_id,
          subject: row.subject,
          grade: row.grade,
          teacherName: row.teacher_name || null,
          kindergarten: isKindergarten(row.grade),
        };
        classes.set(row.class_id, cls);
      }
      const termLocked = termLocks[key].locked;
      if (cls.kindergarten) {
        // Not stored by class: no exception and nothing to count here.
        cls[key] = { locked: termLocked, exception: null, students: row.students, written: null, tooShort: null, tooLong: null };
      } else {
        const exception = row.class_locked === null || row.class_locked === undefined ? null : row.class_locked ? 'locked' : 'open';
        cls[key] = {
          locked: exception ? exception === 'locked' : termLocked,
          exception,
          students: row.students,
          written: row.written,
          tooShort: row.too_short,
          tooLong: row.too_long,
        };
      }
    }
  }
  return { limits, term, termLocks, classes: [...classes.values()] };
}

/** Lock or reopen the whole term for a document; the term's class exceptions are cleared. */
async function setTermLock(termId, kind, locked, userId) {
  if (locked) await db.query(queries.lockTerm, [termId, kind, userId]);
  else await db.query(queries.unlockTerm, [termId, kind]);
}

/**
 * Lock or reopen one class for a document. Matching the term again removes
 * the exception. Returns 'not_found' for a class outside the school and
 * 'kindergarten' for a JK or SK class (they follow the term), else 'ok'.
 */
async function setClassLock(school, classId, kind, locked, userId) {
  const { rows } = await db.query(queries.selectClassForLock, [classId, kind]);
  const cls = rows[0];
  if (!cls || cls.school !== school) return 'not_found';
  if (isKindergarten(cls.grade)) return 'kindergarten';
  if (Boolean(cls.term_locked) === locked) await db.query(queries.deleteClassLock, [classId, kind]);
  else await db.query(queries.upsertClassLock, [classId, kind, locked, userId]);
  return 'ok';
}

module.exports = {
  KINDS,
  KEY,
  MAX_WORDS_CEILING,
  isKind,
  canReview,
  getLimits,
  validateLimits,
  saveLimits,
  classRules,
  savedComments,
  lockedTermNames,
  kindergartenCommentsChange,
  findTerm,
  overview,
  setTermLock,
  setClassLock,
};
