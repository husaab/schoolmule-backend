// Schedule Planner: per-school config CRUD (settings, teachers, rooms,
// class groups, courses, day templates, fixed blocks). All writes take the
// school from req.user, never the request body.

const db = require('../config/database');
const q = require('../queries/schedulePlanner.queries');
const logger = require('../logger');
const { runSolverInWorker } = require('../services/scheduleSolver/run');
const { createPDFBuffer } = require('../utils/pdfGenerator');
const { buildScheduleHtml } = require('../templates/scheduleTemplate');

const UNIQUE_VIOLATION = '23505';

const mapTeacher = (row) => ({
  plannerTeacherId: row.planner_teacher_id,
  school: row.school,
  userId: row.user_id,
  staffId: row.staff_id,
  displayName: row.display_name,
  isFullTime: row.is_full_time,
  maxWeeklyMinutes: row.max_weekly_minutes,
  dailySpareMinutes: row.daily_spare_minutes,
  allowedDays: row.allowed_days,
  excludedWindows: row.excluded_windows,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapRoom = (row) => ({
  roomId: row.room_id,
  school: row.school,
  name: row.name,
  capacityNote: row.capacity_note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapClassGroup = (row) => ({
  classGroupId: row.class_group_id,
  school: row.school,
  name: row.name,
  grade: row.grade,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapCourse = (row) => ({
  courseId: row.course_id,
  classGroupId: row.class_group_id,
  name: row.name,
  sessionsPerWeek: row.sessions_per_week,
  durationMinutes: row.duration_minutes,
  maxPerDay: row.max_per_day,
  assignedTeacherId: row.assigned_teacher_id,
  candidateTeacherIds: row.candidate_teacher_ids,
  requiredRoomId: row.required_room_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapDayTemplate = (row) => ({
  dayTemplateId: row.day_template_id,
  dayOfWeek: row.day_of_week,
  fillableRanges: row.fillable_ranges,
});

const mapFixedBlock = (row) => ({
  fixedBlockId: row.fixed_block_id,
  classGroupIds: row.class_group_ids,
  label: row.label,
  dayOfWeek: row.day_of_week,
  startMin: row.start_min,
  endMin: row.end_min,
});

const mapSettings = (row) => ({
  defaultDurationMinutes: row.default_duration_minutes,
  snapMinutes: row.snap_minutes,
});

const DEFAULT_SETTINGS = { defaultDurationMinutes: 40, snapMinutes: 5 };

async function resolveSchoolId(school) {
  const { rows } = await db.query('SELECT school_id FROM schools WHERE school_code = $1', [school]);
  return rows[0]?.school_id || null;
}

const fail = (res, status, message) => res.status(status).json({ status: 'failed', message });
const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

const handleError = (res, error, action) => {
  if (error.code === UNIQUE_VIOLATION) {
    return fail(res, 409, 'A record with that name already exists');
  }
  logger.error({ err: error }, `Error ${action}`);
  return fail(res, 500, `Error ${action}`);
};

const isValidWindow = (w) =>
  Number.isInteger(w.startMin) &&
  Number.isInteger(w.endMin) &&
  w.startMin >= 0 &&
  w.endMin > w.startMin &&
  w.endMin <= 1440 &&
  Number.isInteger(w.day) &&
  w.day >= 1 &&
  w.day <= 7;

// ─── Settings ────────────────────────────────────────────────────────────

const getSettings = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectSettings, [req.user.school]);
    return ok(res, rows.length ? mapSettings(rows[0]) : DEFAULT_SETTINGS);
  } catch (error) {
    return handleError(res, error, 'fetching planner settings');
  }
};

const updateSettings = async (req, res) => {
  const { defaultDurationMinutes, snapMinutes } = req.body;
  try {
    const { rows: existing } = await db.query(q.selectSettings, [req.user.school]);
    const current = existing.length ? mapSettings(existing[0]) : DEFAULT_SETTINGS;
    const schoolId = await resolveSchoolId(req.user.school);
    const { rows } = await db.query(q.upsertSettings, [
      req.user.school,
      schoolId,
      defaultDurationMinutes ?? current.defaultDurationMinutes,
      snapMinutes ?? current.snapMinutes,
    ]);
    return ok(res, mapSettings(rows[0]));
  } catch (error) {
    return handleError(res, error, 'updating planner settings');
  }
};

// ─── Teachers ────────────────────────────────────────────────────────────

const listTeachers = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectTeachersBySchool, [req.user.school]);
    return ok(res, rows.map(mapTeacher));
  } catch (error) {
    return handleError(res, error, 'fetching planner teachers');
  }
};

const createTeacher = async (req, res) => {
  const {
    userId, staffId, displayName, isFullTime, maxWeeklyMinutes,
    dailySpareMinutes, allowedDays, excludedWindows, notes,
  } = req.body;
  if (!displayName || typeof displayName !== 'string') {
    return fail(res, 400, 'displayName is required');
  }
  if (excludedWindows && !excludedWindows.every(isValidWindow)) {
    return fail(res, 400, 'excludedWindows entries need day (1-7), startMin and endMin (endMin > startMin)');
  }
  try {
    const schoolId = await resolveSchoolId(req.user.school);
    const { rows } = await db.query(q.insertTeacher, [
      req.user.school,
      schoolId,
      userId || null,
      staffId || null,
      displayName,
      isFullTime !== false,
      maxWeeklyMinutes ?? null,
      dailySpareMinutes ?? null,
      JSON.stringify(allowedDays ?? [1, 2, 3, 4, 5]),
      JSON.stringify(excludedWindows ?? []),
      notes || null,
    ]);
    return ok(res, mapTeacher(rows[0]), 201);
  } catch (error) {
    return handleError(res, error, 'creating planner teacher');
  }
};

const updateTeacher = async (req, res) => {
  const { teacherId } = req.params;
  const body = req.body;
  if (body.excludedWindows && !body.excludedWindows.every(isValidWindow)) {
    return fail(res, 400, 'excludedWindows entries need day (1-7), startMin and endMin (endMin > startMin)');
  }
  try {
    const { rows: existingRows } = await db.query(q.selectTeacherById, [teacherId, req.user.school]);
    if (existingRows.length === 0) return fail(res, 404, 'Teacher not found');
    const existing = existingRows[0];
    const { rows } = await db.query(q.updateTeacher, [
      body.userId !== undefined ? body.userId : existing.user_id,
      body.staffId !== undefined ? body.staffId : existing.staff_id,
      body.displayName ?? existing.display_name,
      body.isFullTime !== undefined ? body.isFullTime === true : existing.is_full_time,
      body.maxWeeklyMinutes !== undefined ? body.maxWeeklyMinutes : existing.max_weekly_minutes,
      body.dailySpareMinutes !== undefined ? body.dailySpareMinutes : existing.daily_spare_minutes,
      JSON.stringify(body.allowedDays ?? existing.allowed_days),
      JSON.stringify(body.excludedWindows ?? existing.excluded_windows),
      body.notes !== undefined ? body.notes : existing.notes,
      teacherId,
      req.user.school,
    ]);
    return ok(res, mapTeacher(rows[0]));
  } catch (error) {
    return handleError(res, error, 'updating planner teacher');
  }
};

const deleteTeacher = async (req, res) => {
  try {
    const { rows } = await db.query(q.deleteTeacher, [req.params.teacherId, req.user.school]);
    if (rows.length === 0) return fail(res, 404, 'Teacher not found');
    return ok(res, mapTeacher(rows[0]));
  } catch (error) {
    return handleError(res, error, 'deleting planner teacher');
  }
};

// ─── Rooms ───────────────────────────────────────────────────────────────

const listRooms = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectRoomsBySchool, [req.user.school]);
    return ok(res, rows.map(mapRoom));
  } catch (error) {
    return handleError(res, error, 'fetching planner rooms');
  }
};

const createRoom = async (req, res) => {
  const { name, capacityNote } = req.body;
  if (!name || typeof name !== 'string') return fail(res, 400, 'name is required');
  try {
    const schoolId = await resolveSchoolId(req.user.school);
    const { rows } = await db.query(q.insertRoom, [req.user.school, schoolId, name, capacityNote || null]);
    return ok(res, mapRoom(rows[0]), 201);
  } catch (error) {
    return handleError(res, error, 'creating planner room');
  }
};

const updateRoom = async (req, res) => {
  const { roomId } = req.params;
  try {
    const { rows: existingRows } = await db.query(q.selectRoomById, [roomId, req.user.school]);
    if (existingRows.length === 0) return fail(res, 404, 'Room not found');
    const existing = existingRows[0];
    const { rows } = await db.query(q.updateRoom, [
      req.body.name ?? existing.name,
      req.body.capacityNote !== undefined ? req.body.capacityNote : existing.capacity_note,
      roomId,
      req.user.school,
    ]);
    return ok(res, mapRoom(rows[0]));
  } catch (error) {
    return handleError(res, error, 'updating planner room');
  }
};

const deleteRoom = async (req, res) => {
  try {
    const { rows } = await db.query(q.deleteRoom, [req.params.roomId, req.user.school]);
    if (rows.length === 0) return fail(res, 404, 'Room not found');
    return ok(res, mapRoom(rows[0]));
  } catch (error) {
    return handleError(res, error, 'deleting planner room');
  }
};

// ─── Class groups ────────────────────────────────────────────────────────

const listClassGroups = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectClassGroupsBySchool, [req.user.school]);
    return ok(res, rows.map(mapClassGroup));
  } catch (error) {
    return handleError(res, error, 'fetching class groups');
  }
};

const createClassGroup = async (req, res) => {
  const { name, grade, sortOrder } = req.body;
  if (!name || typeof name !== 'string') return fail(res, 400, 'name is required');
  try {
    const schoolId = await resolveSchoolId(req.user.school);
    const { rows } = await db.query(q.insertClassGroup, [
      req.user.school, schoolId, name, grade || null, sortOrder ?? 0,
    ]);
    return ok(res, mapClassGroup(rows[0]), 201);
  } catch (error) {
    return handleError(res, error, 'creating class group');
  }
};

const updateClassGroup = async (req, res) => {
  const { classGroupId } = req.params;
  try {
    const { rows: existingRows } = await db.query(q.selectClassGroupById, [classGroupId, req.user.school]);
    if (existingRows.length === 0) return fail(res, 404, 'Class group not found');
    const existing = existingRows[0];
    const { rows } = await db.query(q.updateClassGroup, [
      req.body.name ?? existing.name,
      req.body.grade !== undefined ? req.body.grade : existing.grade,
      req.body.sortOrder ?? existing.sort_order,
      classGroupId,
      req.user.school,
    ]);
    return ok(res, mapClassGroup(rows[0]));
  } catch (error) {
    return handleError(res, error, 'updating class group');
  }
};

const deleteClassGroup = async (req, res) => {
  try {
    const { rows } = await db.query(q.deleteClassGroup, [req.params.classGroupId, req.user.school]);
    if (rows.length === 0) return fail(res, 404, 'Class group not found');
    return ok(res, mapClassGroup(rows[0]));
  } catch (error) {
    return handleError(res, error, 'deleting class group');
  }
};

// ─── Courses ─────────────────────────────────────────────────────────────

const validateCourseTeachers = (assignedTeacherId, candidateTeacherIds) => {
  const hasAssigned = assignedTeacherId != null;
  const hasPool = Array.isArray(candidateTeacherIds) && candidateTeacherIds.length > 0;
  if (hasAssigned && hasPool) return 'Set either an assigned teacher or a candidate pool, not both';
  if (!hasAssigned && !hasPool) return 'A course needs an assigned teacher or a candidate pool';
  return null;
};

const createCourse = async (req, res) => {
  const { classGroupId } = req.params;
  const {
    name, sessionsPerWeek, durationMinutes, maxPerDay,
    assignedTeacherId, candidateTeacherIds, requiredRoomId,
  } = req.body;
  if (!name || !Number.isInteger(sessionsPerWeek) || sessionsPerWeek < 1) {
    return fail(res, 400, 'name and sessionsPerWeek (>= 1) are required');
  }
  const teacherError = validateCourseTeachers(assignedTeacherId, candidateTeacherIds);
  if (teacherError) return fail(res, 400, teacherError);
  try {
    const { rows: groupRows } = await db.query(q.selectClassGroupById, [classGroupId, req.user.school]);
    if (groupRows.length === 0) return fail(res, 404, 'Class group not found');
    const schoolId = await resolveSchoolId(req.user.school);
    const { rows } = await db.query(q.insertCourse, [
      req.user.school,
      schoolId,
      classGroupId,
      name,
      sessionsPerWeek,
      durationMinutes ?? null,
      maxPerDay ?? 1,
      assignedTeacherId || null,
      JSON.stringify(candidateTeacherIds ?? []),
      requiredRoomId || null,
    ]);
    return ok(res, mapCourse(rows[0]), 201);
  } catch (error) {
    return handleError(res, error, 'creating course requirement');
  }
};

const updateCourse = async (req, res) => {
  const { courseId } = req.params;
  const body = req.body;
  try {
    const { rows: existingRows } = await db.query(q.selectCourseById, [courseId, req.user.school]);
    if (existingRows.length === 0) return fail(res, 404, 'Course not found');
    const existing = existingRows[0];
    const assignedTeacherId =
      body.assignedTeacherId !== undefined ? body.assignedTeacherId : existing.assigned_teacher_id;
    const candidateTeacherIds =
      body.candidateTeacherIds !== undefined ? body.candidateTeacherIds : existing.candidate_teacher_ids;
    const teacherError = validateCourseTeachers(assignedTeacherId, candidateTeacherIds);
    if (teacherError) return fail(res, 400, teacherError);
    const { rows } = await db.query(q.updateCourse, [
      body.name ?? existing.name,
      body.sessionsPerWeek ?? existing.sessions_per_week,
      body.durationMinutes !== undefined ? body.durationMinutes : existing.duration_minutes,
      body.maxPerDay ?? existing.max_per_day,
      assignedTeacherId || null,
      JSON.stringify(candidateTeacherIds ?? []),
      body.requiredRoomId !== undefined ? body.requiredRoomId : existing.required_room_id,
      courseId,
      req.user.school,
    ]);
    return ok(res, mapCourse(rows[0]));
  } catch (error) {
    return handleError(res, error, 'updating course requirement');
  }
};

const deleteCourse = async (req, res) => {
  try {
    const { rows } = await db.query(q.deleteCourse, [req.params.courseId, req.user.school]);
    if (rows.length === 0) return fail(res, 404, 'Course not found');
    return ok(res, mapCourse(rows[0]));
  } catch (error) {
    return handleError(res, error, 'deleting course requirement');
  }
};

// ─── Day templates ───────────────────────────────────────────────────────

const listDayTemplates = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectDayTemplatesBySchool, [req.user.school]);
    return ok(res, rows.map(mapDayTemplate));
  } catch (error) {
    return handleError(res, error, 'fetching day templates');
  }
};

const replaceDayTemplates = async (req, res) => {
  const { days } = req.body;
  if (!Array.isArray(days)) return fail(res, 400, 'days array is required');
  for (const day of days) {
    if (!Number.isInteger(day.dayOfWeek) || day.dayOfWeek < 1 || day.dayOfWeek > 7) {
      return fail(res, 400, 'Each day needs dayOfWeek between 1 and 7');
    }
    if (!Array.isArray(day.fillableRanges) || !day.fillableRanges.every((r) => isValidWindow({ ...r, day: day.dayOfWeek }))) {
      return fail(res, 400, 'Each fillable range needs startMin and endMin (endMin > startMin)');
    }
  }
  const client = await db.connect();
  try {
    const schoolId = await resolveSchoolId(req.user.school);
    await client.query('BEGIN');
    await client.query(q.deleteDayTemplatesBySchool, [req.user.school]);
    const rows = [];
    for (const day of days) {
      const { rows: inserted } = await client.query(q.insertDayTemplate, [
        req.user.school,
        schoolId,
        day.dayOfWeek,
        JSON.stringify(day.fillableRanges),
      ]);
      rows.push(inserted[0]);
    }
    await client.query('COMMIT');
    return ok(res, rows.map(mapDayTemplate));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return handleError(res, error, 'saving day templates');
  } finally {
    client.release();
  }
};

// ─── Fixed blocks ────────────────────────────────────────────────────────

const listFixedBlocks = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectFixedBlocksBySchool, [req.user.school]);
    return ok(res, rows.map(mapFixedBlock));
  } catch (error) {
    return handleError(res, error, 'fetching fixed blocks');
  }
};

const createFixedBlock = async (req, res) => {
  const { classGroupIds, label, dayOfWeek, startMin, endMin } = req.body;
  if (!label || !isValidWindow({ day: dayOfWeek, startMin, endMin })) {
    return fail(res, 400, 'label, dayOfWeek (1-7), startMin and endMin (endMin > startMin) are required');
  }
  if (classGroupIds !== undefined && !Array.isArray(classGroupIds)) {
    return fail(res, 400, 'classGroupIds must be an array (empty = whole school)');
  }
  try {
    const schoolId = await resolveSchoolId(req.user.school);
    const { rows } = await db.query(q.insertFixedBlock, [
      req.user.school, schoolId, JSON.stringify(classGroupIds ?? []), label, dayOfWeek, startMin, endMin,
    ]);
    return ok(res, mapFixedBlock(rows[0]), 201);
  } catch (error) {
    return handleError(res, error, 'creating fixed block');
  }
};

const updateFixedBlock = async (req, res) => {
  const { fixedBlockId } = req.params;
  const body = req.body;
  try {
    const { rows: existingRows } = await db.query(q.selectFixedBlockById, [fixedBlockId, req.user.school]);
    if (existingRows.length === 0) return fail(res, 404, 'Fixed block not found');
    const existing = existingRows[0];
    const next = {
      classGroupIds: body.classGroupIds !== undefined ? body.classGroupIds : existing.class_group_ids,
      label: body.label ?? existing.label,
      dayOfWeek: body.dayOfWeek ?? existing.day_of_week,
      startMin: body.startMin ?? existing.start_min,
      endMin: body.endMin ?? existing.end_min,
    };
    if (!isValidWindow({ day: next.dayOfWeek, startMin: next.startMin, endMin: next.endMin })) {
      return fail(res, 400, 'dayOfWeek (1-7), startMin and endMin (endMin > startMin) must be valid');
    }
    if (!Array.isArray(next.classGroupIds)) {
      return fail(res, 400, 'classGroupIds must be an array (empty = whole school)');
    }
    const { rows } = await db.query(q.updateFixedBlock, [
      JSON.stringify(next.classGroupIds), next.label, next.dayOfWeek, next.startMin, next.endMin,
      fixedBlockId, req.user.school,
    ]);
    return ok(res, mapFixedBlock(rows[0]));
  } catch (error) {
    return handleError(res, error, 'updating fixed block');
  }
};

const deleteFixedBlock = async (req, res) => {
  try {
    const { rows } = await db.query(q.deleteFixedBlock, [req.params.fixedBlockId, req.user.school]);
    if (rows.length === 0) return fail(res, 404, 'Fixed block not found');
    return ok(res, mapFixedBlock(rows[0]));
  } catch (error) {
    return handleError(res, error, 'deleting fixed block');
  }
};

// ─── Config (everything for the setup UI in one call) ───────────────────

const getConfig = async (req, res) => {
  try {
    const school = req.user.school;
    const [settings, teachers, rooms, groups, courses, dayTemplates, fixedBlocks] =
      await Promise.all([
        db.query(q.selectSettings, [school]),
        db.query(q.selectTeachersBySchool, [school]),
        db.query(q.selectRoomsBySchool, [school]),
        db.query(q.selectClassGroupsBySchool, [school]),
        db.query(q.selectCoursesBySchool, [school]),
        db.query(q.selectDayTemplatesBySchool, [school]),
        db.query(q.selectFixedBlocksBySchool, [school]),
      ]);
    const coursesByGroup = new Map();
    for (const row of courses.rows) {
      if (!coursesByGroup.has(row.class_group_id)) coursesByGroup.set(row.class_group_id, []);
      coursesByGroup.get(row.class_group_id).push(mapCourse(row));
    }
    return ok(res, {
      settings: settings.rows.length ? mapSettings(settings.rows[0]) : DEFAULT_SETTINGS,
      teachers: teachers.rows.map(mapTeacher),
      rooms: rooms.rows.map(mapRoom),
      classGroups: groups.rows.map((g) => ({
        ...mapClassGroup(g),
        courses: coursesByGroup.get(g.class_group_id) || [],
      })),
      dayTemplates: dayTemplates.rows.map(mapDayTemplate),
      fixedBlocks: fixedBlocks.rows.map(mapFixedBlock),
    });
  } catch (error) {
    return handleError(res, error, 'fetching planner config');
  }
};

// ─── Generate ────────────────────────────────────────────────────────────

const mapScheduleSummary = (row) => ({
  scheduleId: row.schedule_id,
  school: row.school,
  name: row.name,
  status: row.status,
  shareToken: row.share_token,
  publishedAt: row.published_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapSchedule = (row) => ({
  ...mapScheduleSummary(row),
  sessions: row.sessions,
  diagnostics: row.diagnostics,
  configSnapshot: row.config_snapshot,
});

// Loads the school's planner config and builds the solver input JSON.
async function assembleSolverInput(school, body = {}) {
  const [settingsQ, teachersQ, roomsQ, groupsQ, coursesQ, daysQ, blocksQ] = await Promise.all([
    db.query(q.selectSettings, [school]),
    db.query(q.selectTeachersBySchool, [school]),
    db.query(q.selectRoomsBySchool, [school]),
    db.query(q.selectClassGroupsBySchool, [school]),
    db.query(q.selectCoursesBySchool, [school]),
    db.query(q.selectDayTemplatesBySchool, [school]),
    db.query(q.selectFixedBlocksBySchool, [school]),
  ]);
  const settings = settingsQ.rows.length ? mapSettings(settingsQ.rows[0]) : DEFAULT_SETTINGS;
  // JSONB id arrays are not FK-enforced — drop references to deleted rows
  // so a stale pool/block entry can't fail the whole generate call.
  const knownGroupIds = new Set(groupsQ.rows.map((r) => r.class_group_id));
  const knownTeacherIds = new Set(teachersQ.rows.map((r) => r.planner_teacher_id));
  return {
    config: {
      snapMinutes: settings.snapMinutes,
      defaultCourseDurationMinutes: settings.defaultDurationMinutes,
      candidateCount: body.numCandidates ?? 20,
      timeBudgetMs: body.timeBudgetMs ?? 10000,
      seed: body.seed,
    },
    days: daysQ.rows
      .filter((r) => Array.isArray(r.fillable_ranges) && r.fillable_ranges.length > 0)
      .map((r) => ({ day: r.day_of_week, fillableRanges: r.fillable_ranges })),
    fixedBlocks: blocksQ.rows
      .map((r) => ({
        label: r.label,
        day: r.day_of_week,
        startMin: r.start_min,
        endMin: r.end_min,
        classGroupIds: (r.class_group_ids || []).filter((id) => knownGroupIds.has(id)),
        wasScoped: (r.class_group_ids || []).length > 0,
      }))
      // A scoped block whose groups were all deleted must not silently
      // become school-wide — drop it instead.
      .filter((b) => !b.wasScoped || b.classGroupIds.length > 0)
      .map(({ wasScoped, ...block }) => block), // eslint-disable-line no-unused-vars
    teachers: teachersQ.rows.map((r) => ({
      teacherId: r.planner_teacher_id,
      name: r.display_name,
      fullTime: r.is_full_time,
      maxMinutesPerWeek: r.max_weekly_minutes,
      dailySpareMinutes: r.daily_spare_minutes,
      allowedDays: r.allowed_days,
      excludedWindows: r.excluded_windows,
    })),
    rooms: roomsQ.rows.map((r) => ({ roomId: r.room_id, name: r.name })),
    classGroups: groupsQ.rows.map((r) => ({ classGroupId: r.class_group_id, name: r.name })),
    courses: coursesQ.rows.map((r) => ({
      courseId: r.course_id,
      classGroupId: r.class_group_id,
      name: r.name,
      sessionsPerWeek: r.sessions_per_week,
      durationMinutes: r.duration_minutes,
      teacherId: r.assigned_teacher_id,
      teacherCandidateIds: (() => {
        const pool = (Array.isArray(r.candidate_teacher_ids) ? r.candidate_teacher_ids : []).filter(
          (id) => knownTeacherIds.has(id)
        );
        return pool.length > 0 ? pool : null;
      })(),
      roomId: r.required_room_id,
      maxPerDay: r.max_per_day,
    })),
    pins: Array.isArray(body.pinnedSessions) ? body.pinnedSessions : [],
  };
}

const generateSchedule = async (req, res) => {
  try {
    const input = await assembleSolverInput(req.user.school, req.body || {});
    if (input.days.length === 0) {
      return fail(res, 400, 'Set up day templates (school hours) before generating');
    }
    if (input.teachers.length === 0) {
      return fail(res, 400, 'Add at least one teacher before generating');
    }
    if (input.courses.length === 0) {
      return fail(res, 400, 'Add at least one course requirement before generating');
    }

    const result = await runSolverInWorker(input);
    if (result.ok) {
      return ok(res, { candidates: result.candidates, meta: result.meta });
    }
    if (result.phase === 'input') {
      return fail(res, 400, result.diagnostics[0]?.message || 'Invalid planner configuration');
    }
    return res.status(422).json({
      status: 'failed',
      message: result.diagnostics[0]?.message || 'No valid schedule exists for these constraints',
      data: {
        phase: result.phase,
        diagnostics: result.diagnostics,
        partial: result.partial,
        meta: result.meta,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error generating schedules');
    return fail(res, 500, 'Error generating schedules');
  }
};

// ─── Schedule drafts ─────────────────────────────────────────────────────

const listSchedules = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectSchedulesBySchool, [req.user.school]);
    return ok(res, rows.map(mapScheduleSummary));
  } catch (error) {
    return handleError(res, error, 'fetching schedules');
  }
};

const getSchedule = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectScheduleById, [req.params.scheduleId, req.user.school]);
    if (rows.length === 0) return fail(res, 404, 'Schedule not found');
    return ok(res, mapSchedule(rows[0]));
  } catch (error) {
    return handleError(res, error, 'fetching schedule');
  }
};

const createSchedule = async (req, res) => {
  const { name, sessions, diagnostics, configSnapshot } = req.body;
  if (!name || !Array.isArray(sessions) || sessions.length === 0) {
    return fail(res, 400, 'name and a non-empty sessions array are required');
  }
  try {
    const schoolId = await resolveSchoolId(req.user.school);
    const { rows } = await db.query(q.insertSchedule, [
      req.user.school,
      schoolId,
      name,
      JSON.stringify(sessions),
      diagnostics ? JSON.stringify(diagnostics) : null,
      configSnapshot ? JSON.stringify(configSnapshot) : null,
    ]);
    return ok(res, mapSchedule(rows[0]), 201);
  } catch (error) {
    return handleError(res, error, 'saving schedule draft');
  }
};

const updateSchedule = async (req, res) => {
  const { scheduleId } = req.params;
  const body = req.body;
  try {
    const { rows: existingRows } = await db.query(q.selectScheduleById, [scheduleId, req.user.school]);
    if (existingRows.length === 0) return fail(res, 404, 'Schedule not found');
    const existing = existingRows[0];
    const sessions = body.sessions !== undefined ? body.sessions : existing.sessions;
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return fail(res, 400, 'sessions must be a non-empty array');
    }
    const diagnostics = body.diagnostics !== undefined ? body.diagnostics : existing.diagnostics;
    const { rows } = await db.query(q.updateSchedule, [
      body.name ?? existing.name,
      JSON.stringify(sessions),
      diagnostics ? JSON.stringify(diagnostics) : null,
      scheduleId,
      req.user.school,
    ]);
    return ok(res, mapSchedule(rows[0]));
  } catch (error) {
    return handleError(res, error, 'updating schedule');
  }
};

const mapMaterializedSession = (row) => ({
  sessionId: row.session_id,
  scheduleId: row.schedule_id,
  classGroupId: row.class_group_id,
  classGroupName: row.class_group_name,
  courseName: row.course_name,
  plannerTeacherId: row.planner_teacher_id,
  teacherUserId: row.teacher_user_id,
  teacherName: row.teacher_name,
  roomName: row.room_name,
  dayOfWeek: row.day_of_week,
  startMin: row.start_min,
  endMin: row.end_min,
});

// POST /schedules/:scheduleId/publish — one transaction: demote the current
// published schedule, promote this one, rebuild the materialized session rows
// (resolving teacher user links and display names from the planner config).
const publishSchedule = async (req, res) => {
  const { scheduleId } = req.params;
  const school = req.user.school;
  const client = await db.connect();
  try {
    const { rows: scheduleRows } = await client.query(q.selectScheduleById, [scheduleId, school]);
    if (scheduleRows.length === 0) {
      client.release();
      return fail(res, 404, 'Schedule not found');
    }
    const schedule = scheduleRows[0];
    const sessions = schedule.sessions || [];
    if (sessions.length === 0) {
      client.release();
      return fail(res, 400, 'Cannot publish an empty schedule');
    }

    const [teachersQ, groupsQ, roomsQ] = await Promise.all([
      client.query(q.selectTeachersBySchool, [school]),
      client.query(q.selectClassGroupsBySchool, [school]),
      client.query(q.selectRoomsBySchool, [school]),
    ]);
    const teacherById = new Map(teachersQ.rows.map((r) => [r.planner_teacher_id, r]));
    const groupById = new Map(groupsQ.rows.map((r) => [r.class_group_id, r]));
    const roomById = new Map(roomsQ.rows.map((r) => [r.room_id, r]));
    const schoolId = await resolveSchoolId(school);

    await client.query('BEGIN');
    const { rows: demoted } = await client.query(q.demotePublishedSchedules, [school]);
    for (const row of demoted) {
      await client.query(q.deleteSessionsForSchedule, [row.schedule_id]);
    }
    const { rows: published } = await client.query(q.markSchedulePublished, [scheduleId, school]);
    await client.query(q.deleteSessionsForSchedule, [scheduleId]);
    for (const s of sessions) {
      const teacher = teacherById.get(s.teacherId);
      const group = groupById.get(s.classGroupId);
      const room = s.roomId ? roomById.get(s.roomId) : null;
      await client.query(q.insertScheduleSession, [
        scheduleId,
        school,
        schoolId,
        group ? s.classGroupId : null,
        group?.name || 'Unknown class',
        s.courseName || 'Course',
        teacher ? s.teacherId : null,
        teacher?.user_id || null,
        teacher?.display_name || 'Unknown teacher',
        room?.name || null,
        s.day,
        s.startMin,
        s.endMin,
      ]);
    }
    await client.query('COMMIT');
    return ok(res, mapSchedule(published[0]));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return handleError(res, error, 'publishing schedule');
  } finally {
    client.release();
  }
};

// GET /schedules/:scheduleId/pdf?classGroupId=&view=classGroup|teacher
const getSchedulePdf = async (req, res) => {
  const { scheduleId } = req.params;
  const { classGroupId, view } = req.query;
  const school = req.user.school;
  try {
    const { rows: scheduleRows } = await db.query(q.selectScheduleById, [scheduleId, school]);
    if (scheduleRows.length === 0) return fail(res, 404, 'Schedule not found');
    const schedule = scheduleRows[0];
    const sessions = schedule.sessions || [];
    if (sessions.length === 0) return fail(res, 400, 'Schedule has no sessions');

    const [teachersQ, groupsQ, roomsQ, daysQ, schoolQ] = await Promise.all([
      db.query(q.selectTeachersBySchool, [school]),
      db.query(q.selectClassGroupsBySchool, [school]),
      db.query(q.selectRoomsBySchool, [school]),
      db.query(q.selectDayTemplatesBySchool, [school]),
      db.query('SELECT name FROM schools WHERE school_code = $1', [school]),
    ]);
    const teacherById = new Map(teachersQ.rows.map((r) => [r.planner_teacher_id, r]));
    const groupById = new Map(groupsQ.rows.map((r) => [r.class_group_id, r]));
    const roomById = new Map(roomsQ.rows.map((r) => [r.room_id, r]));

    // Vertical time window: from day templates when set, else from sessions.
    const allRanges = daysQ.rows.flatMap((r) => r.fillable_ranges || []);
    const rangeStartMin = allRanges.length
      ? Math.min(...allRanges.map((r) => r.startMin))
      : Math.min(...sessions.map((s) => s.startMin));
    const rangeEndMin = allRanges.length
      ? Math.max(...allRanges.map((r) => r.endMin))
      : Math.max(...sessions.map((s) => s.endMin));
    const days = [...new Set(sessions.map((s) => s.day))].sort((a, b) => a - b);

    const teacherName = (id) => teacherById.get(id)?.display_name || 'Unknown teacher';
    const groupName = (id) => groupById.get(id)?.name || 'Unknown class';
    const roomName = (id) => (id ? roomById.get(id)?.name || null : null);

    let pages;
    if (view === 'teacher') {
      const byTeacher = new Map();
      for (const s of sessions) {
        if (!byTeacher.has(s.teacherId)) byTeacher.set(s.teacherId, []);
        byTeacher.get(s.teacherId).push(s);
      }
      pages = [...byTeacher.entries()]
        .map(([id, own]) => ({
          title: teacherName(id),
          sessions: own.map((s) => ({
            day: s.day,
            startMin: s.startMin,
            endMin: s.endMin,
            primaryLabel: s.courseName,
            secondaryLabel: groupName(s.classGroupId),
            roomName: roomName(s.roomId),
          })),
        }))
        .sort((a, b) => a.title.localeCompare(b.title));
    } else {
      const groupsInSchedule = [...new Set(sessions.map((s) => s.classGroupId))].filter(
        (id) => !classGroupId || id === classGroupId
      );
      if (groupsInSchedule.length === 0) return fail(res, 404, 'Class group not in this schedule');
      pages = groupsInSchedule
        .map((id) => ({
          title: groupName(id),
          sessions: sessions
            .filter((s) => s.classGroupId === id)
            .map((s) => ({
              day: s.day,
              startMin: s.startMin,
              endMin: s.endMin,
              primaryLabel: s.courseName,
              secondaryLabel: teacherName(s.teacherId),
              roomName: roomName(s.roomId),
            })),
        }))
        .sort((a, b) => a.title.localeCompare(b.title));
    }

    const html = buildScheduleHtml({
      schoolName: schoolQ.rows[0]?.name || school,
      scheduleName: schedule.name,
      pages,
      days,
      rangeStartMin,
      rangeEndMin,
    });
    const buffer = await createPDFBuffer(html, {
      format: 'Letter',
      landscape: true,
      preferCSSPageSize: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      `inline; filename="${schedule.name.replace(/[^\w.-]+/g, '_')}.pdf"`
    );
    return res.send(buffer);
  } catch (error) {
    return handleError(res, error, 'exporting schedule PDF');
  }
};

// GET /my-schedule — any verified user; published sessions linked to them.
const getMySchedule = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectMySessions, [req.user.userId, req.user.school]);
    return ok(res, { sessions: rows.map(mapMaterializedSession) });
  } catch (error) {
    return handleError(res, error, 'fetching my schedule');
  }
};

const deleteSchedule = async (req, res) => {
  try {
    const { rows } = await db.query(q.deleteSchedule, [req.params.scheduleId, req.user.school]);
    if (rows.length === 0) return fail(res, 404, 'Schedule not found');
    return ok(res, mapScheduleSummary(rows[0]));
  } catch (error) {
    return handleError(res, error, 'deleting schedule');
  }
};

module.exports = {
  getSettings,
  updateSettings,
  listTeachers,
  createTeacher,
  updateTeacher,
  deleteTeacher,
  listRooms,
  createRoom,
  updateRoom,
  deleteRoom,
  listClassGroups,
  createClassGroup,
  updateClassGroup,
  deleteClassGroup,
  createCourse,
  updateCourse,
  deleteCourse,
  listDayTemplates,
  replaceDayTemplates,
  listFixedBlocks,
  createFixedBlock,
  updateFixedBlock,
  deleteFixedBlock,
  getConfig,
  generateSchedule,
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  publishSchedule,
  getMySchedule,
  getSchedulePdf,
  mapMaterializedSession,
};
