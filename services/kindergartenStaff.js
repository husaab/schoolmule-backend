/**
 * Who a JK/SK document names, and whose signatures it prints.
 *
 *   teacher    the student's homeroom teacher, else the teacher of the
 *              grade's Kindergarten class that year (most JK/SK students
 *              have no homeroom). Never an Arabic/French/Quran teacher.
 *              With one Kindergarten class per term, the one set to the
 *              document's term.
 *   assistant  a co-teacher (Class → Settings → Teachers) of that
 *              Kindergarten class. By default the class's only co-teacher
 *              (none when it has several or none); a teacher can pick
 *              another co-teacher, or no assistant, per student per term
 *              (jk_/sk_teacher_assistants). A pick who has since left the
 *              class falls back to the default.
 *
 * One answer for every surface: the four JK/SK documents (report engine and
 * legacy templates, via services/kindergartenProgressReport.js) and the
 * teacher-assistant picker in the JK/SK gradebook (controllers/
 * kindergartenAssistant.controller.js).
 */

const q = require('../queries/kindergartenStaff.queries');
const { signedSignatureUrls } = require('./profile/signatures');

const KINDERGARTEN = new Set(['JK', 'SK']);
const gradeOf = (value) => String(value ?? '').trim().toUpperCase();

/** A staff member as the documents and the picker see them (no storage path). */
const person = (p) => (p ? { userId: p.userId, name: p.name } : null);

/**
 * @param {{ query: Function }} client  a pg pool or client
 * @param {object} student  a row of studentQueries.selectStudentById
 * @param {object} opts
 * @param {string|null} opts.term          e.g. "Term 1" (null: no saved choice is read)
 * @param {string|null} opts.schoolYearId  the year the document belongs to (null: any)
 * @param {string} [opts.grade]            'JK' | 'SK' (default: the student's grade)
 * @returns {Promise<{
 *   grade: string|null,
 *   teacher: { userId: string|null, name: string, signaturePath: string|null } | null,
 *   classId: string|null,
 *   classMemberIds: string[],
 *   coTeachers: Array<{ userId: string, name: string, signaturePath: string|null }>,
 *   defaultAssistant: object|null,
 *   selection: 'default' | 'none' | { userId: string },
 *   assistant: object|null,
 * }>}
 */
async function resolveKindergartenStaff(client, student, { term = null, schoolYearId = null, grade } = {}) {
  const g = gradeOf(grade || student.grade);
  const empty = {
    grade: null, teacher: null, classId: null, classMemberIds: [], coTeachers: [],
    defaultAssistant: null, selection: 'default', assistant: null,
  };
  if (!KINDERGARTEN.has(g)) return empty;

  let teacher = null;
  if (student.homeroom_teacher_id) {
    const { rows } = await client.query(q.selectStaffMember, [student.homeroom_teacher_id]);
    if (rows[0]?.name) teacher = { userId: rows[0].user_id, name: rows[0].name, signaturePath: rows[0].signature_path || null };
  }

  const { rows: classRows } = await client.query(q.selectKindergartenClass, [
    student.student_id, g, schoolYearId || null, student.school, student.homeroom_teacher_id || null, term || null,
  ]);
  const kClass = classRows[0] || null;
  if (!teacher && kClass) {
    teacher = {
      userId: kClass.teacher_id || null,
      name: kClass.teacher_name,
      signaturePath: kClass.teacher_id ? kClass.teacher_signature_path || null : null,
    };
  }

  let coTeachers = [];
  const classMemberIds = [];
  if (kClass) {
    if (kClass.teacher_id) classMemberIds.push(kClass.teacher_id);
    const { rows } = await client.query(q.selectCoTeachers, [kClass.class_id]);
    for (const r of rows) classMemberIds.push(r.user_id);
    // The teacher the document names is never also its assistant.
    coTeachers = rows
      .filter((r) => r.name && r.user_id !== teacher?.userId)
      .map((r) => ({ userId: r.user_id, name: r.name, signaturePath: r.signature_path || null }));
  }
  const defaultAssistant = coTeachers.length === 1 ? coTeachers[0] : null;

  let selection = 'default';
  let assistant = defaultAssistant;
  if (term) {
    const { rows } = await client.query(q.selectAssistantChoice(q.ASSISTANT_TABLES[g]), [student.student_id, term]);
    const choice = rows[0];
    if (choice?.no_assistant) {
      selection = 'none';
      assistant = null;
    } else if (choice?.teacher_assistant_user_id) {
      const picked = coTeachers.find((c) => c.userId === choice.teacher_assistant_user_id);
      if (picked) {
        selection = { userId: picked.userId };
        assistant = picked;
      }
    }
  }

  return {
    grade: g, teacher, classId: kClass?.class_id || null, classMemberIds, coTeachers, defaultAssistant, selection, assistant,
  };
}

/**
 * Signed URLs of the teacher's and the assistant's saved signatures (null
 * when they saved none, or it can't be signed). Never throws.
 * @returns {Promise<{ teacher: string|null, assistant: string|null }>}
 */
async function staffSignatureUrls(staff) {
  const teacherPath = staff?.teacher?.signaturePath;
  const assistantPath = staff?.assistant?.signaturePath;
  const urls = await signedSignatureUrls([teacherPath, assistantPath]);
  return { teacher: urls.get(teacherPath) || null, assistant: urls.get(assistantPath) || null };
}

/**
 * The picker's view of a resolved staff: who prints now, and the choices.
 * @param {object} staff  resolveKindergartenStaff's result
 * @param {{ canManageClass: boolean }} opts
 */
function assistantInfo(staff, { canManageClass = false } = {}) {
  return {
    teacher: person(staff.teacher),
    classId: staff.classId,
    choices: staff.coTeachers.map(person),
    defaultUserId: staff.defaultAssistant?.userId || null,
    selection: staff.selection,
    effective: person(staff.assistant),
    canManageClass: Boolean(staff.classId) && canManageClass,
  };
}

const MODES = new Set(['default', 'none', 'user']);

/**
 * A POST body as a choice: { mode, userId }, null for an old client that
 * still sends only a typed name (left alone: it must not wipe a choice), or
 * { error } for a 400.
 */
function parseAssistantChoice(body) {
  const mode = body?.mode;
  if (mode === undefined || mode === null) return null;
  if (!MODES.has(mode)) return { error: "mode must be 'default', 'none' or 'user'" };
  if (mode !== 'user') return { mode, userId: null };
  const userId = typeof body.assistantUserId === 'string' ? body.assistantUserId : '';
  if (!userId) return { error: 'Choose the teacher assistant' };
  return { mode, userId };
}

/**
 * Saves a choice for (student, term). A 'user' choice must be a co-teacher
 * of the student's Kindergarten class (from `staff`).
 * @returns {Promise<{ error?: string }>}
 */
async function saveAssistantChoice(client, { staff, studentId, term, school, choice }) {
  const table = q.ASSISTANT_TABLES[staff.grade];
  if (!table) return { error: 'Not a JK or SK student' };
  if (choice.mode === 'user' && !staff.coTeachers.some((c) => c.userId === choice.userId)) {
    return { error: "Choose one of the Kindergarten class's other teachers" };
  }
  await client.query(q.upsertAssistantChoice(table), [
    studentId, term, school, choice.mode === 'user' ? choice.userId : null, choice.mode === 'none',
  ]);
  return {};
}

module.exports = {
  resolveKindergartenStaff,
  staffSignatureUrls,
  assistantInfo,
  parseAssistantChoice,
  saveAssistantChoice,
};
