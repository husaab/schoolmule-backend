/*
  controllers/studentEmailImport.controller.js
  Admin Panel → Student accounts → Import emails, for this school year's
  students (the active year only):

    POST /api/admin/student-accounts/emails/parse    multipart `file` (.csv/.xlsx), optional `sheet`
    POST /api/admin/student-accounts/emails/preview  { lines: [{ name, email, grade }] }
    POST /api/admin/student-accounts/emails          { items: [{ studentId, email }] }

  A row is matched to a student by name (and grade, when the file has one),
  never by email: the address is only ever what the admin puts on the row
  they confirm. Every address goes through the same checks as Edit email
  (services/classroom/emailProblems.js); blocking problems refuse that row
  only.
*/

const multer = require('multer');
const db = require('../config/database');
const logger = require('../logger');
const inviteQueries = require('../queries/studentInvite.queries');
const { GRADE_CODES } = require('../utils/gradeRank');
const { getSettings } = require('../services/classroom/classroomSettings');
const { checkStudentEmails } = require('../services/classroom/emailProblems');
const { normalizeEmail } = require('../services/classroom/studentAccounts');
const { buildCandidateIndex, resolveMatch, normalizeName } = require('../services/import/matching');
const { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, parseSpreadsheet } = require('../services/classroom/emailImport');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_ACTIVE_YEAR = "Imports go to this school year's students. Switch to the current school year to import.";

const ok = (res, data) => res.status(200).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } });

/** multer's single-file middleware with its errors as plain 400s. */
const receiveFile = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return failed(res, 400, 'This file is over 2 MB.');
  return failed(res, 400, "We couldn't read this upload. Try again.");
});

const ROSTER_SQL = `
  SELECT student_id, name, grade::text AS grade, student_email
  FROM students
  WHERE school = $1 AND school_year_id = $2 AND is_archived IS NOT TRUE`;

/** The active year's roster, or null (after answering) when the request isn't for it. */
async function activeRoster(req, res) {
  if (!req.schoolYear || !req.schoolYear.isActive) {
    failed(res, 409, NOT_ACTIVE_YEAR);
    return null;
  }
  const { rows } = await db.query(ROSTER_SQL, [req.user.school, req.schoolYear.schoolYearId]);
  return rows;
}

const problem = (code, message) => ({ code, blocking: true, message });

/**
 * Which roster rows a file row may be for: 'matched' (one student with that
 * exact name, and the same grade when the file gives one), 'check' (a close
 * name, a name shared by several students, or the right name in another
 * grade) or 'not_found'. Never by email.
 */
function matchRow(index, { name, grade }) {
  if (grade === null) {
    const sameName = index.byName.get(normalizeName(name)) || [];
    if (sameName.length === 1) return { kind: 'matched', matches: sameName };
    if (sameName.length > 1) return { kind: 'check', matches: sameName };
  }
  const { tier, matches } = resolveMatch(index, { name, grade }, (r) => r.name, (r) => r.grade);
  return { kind: tier === 'exact' ? 'matched' : tier === 'near' ? 'check' : 'not_found', matches };
}

/** A list body of 1..MAX_IMPORT_ROWS objects, or an error message. */
function listOf(body, key) {
  const list = body?.[key];
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_IMPORT_ROWS) {
    return { error: `Send between 1 and ${MAX_IMPORT_ROWS} rows` };
  }
  if (!list.every((x) => x && typeof x === 'object')) return { error: 'Each row must be an object' };
  return { list };
}

// POST /emails/parse (after receiveFile)
const parseUpload = async (req, res) => {
  if (!req.file) return failed(res, 400, 'Choose a file to upload');
  try {
    const sheet = typeof req.body?.sheet === 'string' ? req.body.sheet : undefined;
    return ok(res, await parseSpreadsheet(req.file.buffer, req.file.originalname, sheet));
  } catch (err) {
    if (err && err.status === 400) return failed(res, 400, err.message);
    logger.error({ err }, 'Failed to parse a student email file');
    return failed(res, 500, 'Error reading the file');
  }
};

// POST /emails/preview
const previewImport = async (req, res) => {
  const { list: lines, error } = listOf(req.body, 'lines');
  if (error) return failed(res, 400, error);

  try {
    const roster = await activeRoster(req, res);
    if (!roster) return undefined;
    const settings = await getSettings(req.user.school);
    const index = buildCandidateIndex(roster, (r) => r.name);

    const parsed = lines.map((line, i) => {
      const email = normalizeEmail(line.email) || '';
      const grade = GRADE_CODES.includes(line.grade) ? line.grade : null;
      const { kind, matches } = matchRow(index, { name: line.name, grade });
      return { index: i, email, kind, matches };
    });

    // Every (candidate, address) pair checked in one query.
    const pairs = parsed.flatMap((p) => p.matches.map((m) => ({ studentId: m.student_id, email: p.email })));
    const checked = await checkStudentEmails({ school: req.user.school, domains: settings.studentEmailDomains, items: pairs, forImport: true });

    // Within the file: one address on two rows, or two confident rows for one student.
    const emailCount = new Map();
    parsed.forEach((p) => { if (p.email) emailCount.set(p.email, (emailCount.get(p.email) || 0) + 1); });
    const matchedCount = new Map();
    parsed.filter((p) => p.kind === 'matched').forEach((p) => {
      const id = p.matches[0].student_id;
      matchedCount.set(id, (matchedCount.get(id) || 0) + 1);
    });

    let pair = 0;
    const out = parsed.map((p) => ({
      index: p.index,
      email: p.email,
      match: {
        kind: p.kind,
        candidates: p.matches.map((m) => {
          const result = checked.get(pair);
          pair += 1;
          const problems = [...(result?.problems || [])];
          if (emailCount.get(p.email) > 1) problems.unshift(problem('duplicate_in_list', 'This address is on more than one row.'));
          if (p.kind === 'matched' && matchedCount.get(m.student_id) > 1) {
            problems.unshift(problem('duplicate_in_list', `Two rows are for ${m.name}.`));
          }
          return { studentId: m.student_id, name: m.name, grade: m.grade, currentEmail: m.student_email ?? null, problems };
        }),
      },
    }));
    return ok(res, { lines: out });
  } catch (err) {
    logger.error({ err }, 'Failed to preview a student email import');
    return failed(res, 500, 'Error matching the rows');
  }
};

// POST /emails
const saveImport = async (req, res) => {
  const { list: items, error } = listOf(req.body, 'items');
  if (error) return failed(res, 400, error);
  if (!items.every((it) => typeof it.studentId === 'string' && UUID_RE.test(it.studentId))) {
    return failed(res, 400, 'Invalid student id');
  }

  try {
    const roster = await activeRoster(req, res);
    if (!roster) return undefined;
    const settings = await getSettings(req.user.school);
    const inYear = new Set(roster.map((r) => r.student_id));
    const nameOf = new Map(roster.map((r) => [r.student_id, r.name]));

    const normalized = items.map((it) => ({ studentId: it.studentId.toLowerCase(), email: normalizeEmail(it.email) || '' }));
    const checked = await checkStudentEmails({
      school: req.user.school, domains: settings.studentEmailDomains, items: normalized, forImport: true,
    });
    const emailCount = new Map();
    const studentCount = new Map();
    normalized.forEach((it) => {
      emailCount.set(it.email, (emailCount.get(it.email) || 0) + 1);
      studentCount.set(it.studentId, (studentCount.get(it.studentId) || 0) + 1);
    });

    const results = [];
    let saved = 0;
    for (let i = 0; i < normalized.length; i += 1) {
      const { studentId, email } = normalized[i];
      if (!inYear.has(studentId)) {
        results.push({ studentId, outcome: 'refused', problems: [problem('not_found', "This student isn't in this school year.")] });
        continue;
      }
      const problems = [...(checked.get(i)?.problems || [])];
      if (emailCount.get(email) > 1) problems.unshift(problem('duplicate_in_list', 'This address is on more than one row.'));
      if (studentCount.get(studentId) > 1) problems.unshift(problem('duplicate_in_list', `Two rows are for ${nameOf.get(studentId)}.`));
      if (problems.some((p) => p.blocking)) {
        results.push({ studentId, outcome: 'refused', problems: problems.filter((p) => p.blocking) });
        continue;
      }
      await db.query(inviteQueries.setEmailOnRowAndSuccessors, [studentId, req.user.school, email]);
      saved += 1;
      results.push({ studentId, outcome: 'saved', problems: [] });
    }
    return ok(res, { saved, results });
  } catch (err) {
    logger.error({ err }, 'Failed to save a student email import');
    return failed(res, 500, 'Error saving the addresses');
  }
};

module.exports = { receiveFile, parseUpload, previewImport, saveImport };
