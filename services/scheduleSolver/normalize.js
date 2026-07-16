// Validates the raw solver input and normalizes it into the internal model:
// integer indexes, snap-quantized slot grid, and base occupancy bitsets.
// All times are minutes-from-midnight ints; days are ISO weekday ints (1 = Monday).

const grid = require('./timeGrid');

class SolverInputError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'SolverInputError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new SolverInputError(code, message, details);
}

function clamp(value, min, max, fallback) {
  const n = Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeConfig(raw = {}) {
  const snap = clamp(raw.snapMinutes, 1, 60, 5);
  return {
    snap,
    defaultDur: clamp(raw.defaultCourseDurationMinutes, snap, 480, 40),
    candidateCount: clamp(raw.candidateCount, 1, 50, 20),
    timeBudgetMs: clamp(raw.timeBudgetMs, 500, 10000, 10000),
    seed: Number.isFinite(raw.seed) ? raw.seed : Date.now(),
  };
}

function normalizeDays(rawDays, snap) {
  if (!Array.isArray(rawDays) || rawDays.length === 0) {
    fail('NO_DAYS', 'At least one school day with fillable time ranges is required.');
  }
  const seen = new Set();
  const days = [];
  for (const rawDay of rawDays) {
    const iso = rawDay.day;
    if (!Number.isInteger(iso) || iso < 1 || iso > 7) {
      fail('INVALID_DAY', `Day of week must be an integer 1-7, got ${iso}.`);
    }
    if (seen.has(iso)) fail('DUPLICATE_DAY', `Day ${iso} appears more than once.`);
    seen.add(iso);
    if (!Array.isArray(rawDay.fillableRanges) || rawDay.fillableRanges.length === 0) {
      fail('NO_FILLABLE_RANGES', `Day ${iso} has no fillable time ranges.`);
    }
    const ranges = rawDay.fillableRanges.map((r) => {
      if (!Number.isInteger(r.startMin) || !Number.isInteger(r.endMin) || r.endMin <= r.startMin) {
        fail(
          'INVALID_RANGE',
          `Day ${iso} has an invalid fillable range (${r.startMin}-${r.endMin}).`
        );
      }
      const startMin = grid.snapUp(r.startMin, snap);
      const endMin = grid.snapDown(r.endMin, snap);
      if (endMin <= startMin) {
        fail(
          'INVALID_RANGE',
          `Day ${iso} fillable range (${r.startMin}-${r.endMin}) is shorter than the snap increment.`
        );
      }
      return { startMin, endMin };
    });
    days.push({ iso, ranges });
  }
  return days;
}

function indexById(items, idKey, kind) {
  const map = new Map();
  items.forEach((item, i) => {
    const id = item[idKey];
    if (!id) fail('MISSING_ID', `A ${kind} is missing its ${idKey}.`);
    if (map.has(id)) fail('DUPLICATE_ID', `Duplicate ${kind} id "${id}".`);
    map.set(id, i);
  });
  return map;
}

// Convert an absolute-minute window into a slot range on day d; null if empty.
function toSlotRange(startMin, endMin, dayStart, slotsInDay, snap) {
  const from = Math.max(0, Math.floor((grid.snapDown(startMin, snap) - dayStart) / snap));
  const to = Math.min(slotsInDay, Math.ceil((grid.snapUp(endMin, snap) - dayStart) / snap));
  if (to <= from) return null;
  return { start: from, len: to - from };
}

function validateAndNormalize(rawInput) {
  if (!rawInput || typeof rawInput !== 'object') {
    fail('INVALID_INPUT', 'Solver input must be an object.');
  }
  const config = normalizeConfig(rawInput.config);
  const { snap } = config;
  const days = normalizeDays(rawInput.days, snap);

  const numDays = days.length;
  const dayStartMin = new Int32Array(numDays);
  const slotsPerDay = new Int32Array(numDays);
  const dayIdxByIso = new Map();
  days.forEach((d, i) => {
    dayIdxByIso.set(d.iso, i);
    dayStartMin[i] = Math.min(...d.ranges.map((r) => r.startMin));
    const end = Math.max(...d.ranges.map((r) => r.endMin));
    slotsPerDay[i] = (end - dayStartMin[i]) / snap;
  });
  const W = grid.wordsForSlots(Math.max(...slotsPerDay));
  const totalWords = numDays * W;

  const teachers = rawInput.teachers || [];
  const rooms = rawInput.rooms || [];
  const classGroups = rawInput.classGroups || [];
  const courses = rawInput.courses || [];
  const teacherIndex = indexById(teachers, 'teacherId', 'teacher');
  const roomIndex = indexById(rooms, 'roomId', 'room');
  const classGroupIndex = indexById(classGroups, 'classGroupId', 'class group');
  if (teachers.length === 0) fail('NO_TEACHERS', 'At least one teacher is required.');
  if (classGroups.length === 0) fail('NO_CLASS_GROUPS', 'At least one class group is required.');
  if (courses.length === 0) fail('NO_COURSES', 'At least one course requirement is required.');

  // Base occupancy shared by every resource: everything outside fillable ranges blocked.
  const fillableBase = new Uint32Array(totalWords);
  for (let d = 0; d < numDays; d++) {
    for (let w = 0; w < W; w++) fillableBase[d * W + w] = 0xffffffff;
    for (const r of days[d].ranges) {
      const start = (r.startMin - dayStartMin[d]) / snap;
      grid.clearRange(fillableBase, d * W, start, (r.endMin - r.startMin) / snap);
    }
  }

  const applyWindow = (occ, dayIso, startMin, endMin) => {
    const d = dayIdxByIso.get(dayIso);
    if (d === undefined) return;
    const range = toSlotRange(startMin, endMin, dayStartMin[d], slotsPerDay[d], snap);
    if (range) grid.setRange(occ, d * W, range.start, range.len);
  };

  // Fixed blocks: school-wide ones block every resource; group-scoped only that class.
  const fixedBlocks = rawInput.fixedBlocks || [];
  for (const block of fixedBlocks) {
    if (block.scope === 'classGroup' && !classGroupIndex.has(block.classGroupId)) {
      fail(
        'UNKNOWN_CLASS_GROUP',
        `Fixed block "${block.label}" references unknown class group "${block.classGroupId}".`
      );
    }
    if (!Number.isInteger(block.startMin) || !Number.isInteger(block.endMin) || block.endMin <= block.startMin) {
      fail('INVALID_RANGE', `Fixed block "${block.label}" has an invalid time range.`);
    }
  }
  const schoolWideBase = new Uint32Array(fillableBase);
  for (const block of fixedBlocks) {
    if (block.scope !== 'classGroup') {
      applyWindow(schoolWideBase, block.day, block.startMin, block.endMin);
    }
  }

  const teacherBase = teachers.map((t) => {
    const occ = new Uint32Array(schoolWideBase);
    const allowed = new Set(t.allowedDays || [1, 2, 3, 4, 5, 6, 7]);
    for (let d = 0; d < numDays; d++) {
      if (!allowed.has(days[d].iso)) grid.setRange(occ, d * W, 0, slotsPerDay[d]);
    }
    for (const win of t.excludedWindows || []) {
      applyWindow(occ, win.day, win.startMin, win.endMin);
    }
    return occ;
  });

  const roomBase = rooms.map(() => new Uint32Array(schoolWideBase));

  const classBase = classGroups.map((g) => {
    const occ = new Uint32Array(schoolWideBase);
    for (const block of fixedBlocks) {
      if (block.scope === 'classGroup' && block.classGroupId === g.classGroupId) {
        applyWindow(occ, block.day, block.startMin, block.endMin);
      }
    }
    return occ;
  });

  const warnings = [];

  const normTeachers = teachers.map((t) => ({
    id: t.teacherId,
    name: t.name,
    fullTime: t.fullTime !== false,
    maxMin: Number.isFinite(t.maxMinutesPerWeek) ? t.maxMinutesPerWeek : Infinity,
  }));

  const normCourses = courses.map((c) => {
    const classIdx = classGroupIndex.get(c.classGroupId);
    if (classIdx === undefined) {
      fail('UNKNOWN_CLASS_GROUP', `Course "${c.name}" references unknown class group "${c.classGroupId}".`);
    }
    const hasAssigned = c.teacherId != null;
    const hasPool = Array.isArray(c.teacherCandidateIds) && c.teacherCandidateIds.length > 0;
    if (hasAssigned && hasPool) {
      fail(
        'AMBIGUOUS_TEACHER',
        `Course "${c.name}" has both an assigned teacher and a candidate pool — set exactly one.`
      );
    }
    if (!hasAssigned && !hasPool) {
      fail(
        'NO_TEACHER',
        `Course "${c.name}" has no assigned teacher and no candidate pool.`
      );
    }
    const candIds = hasAssigned ? [c.teacherId] : c.teacherCandidateIds;
    const teacherCands = new Int32Array(
      candIds.map((id) => {
        const idx = teacherIndex.get(id);
        if (idx === undefined) fail('UNKNOWN_TEACHER', `Course "${c.name}" references unknown teacher "${id}".`);
        return idx;
      })
    );
    let roomIdx = -1;
    if (c.roomId != null) {
      roomIdx = roomIndex.get(c.roomId);
      if (roomIdx === undefined) fail('UNKNOWN_ROOM', `Course "${c.name}" references unknown room "${c.roomId}".`);
    }
    if (!Number.isInteger(c.sessionsPerWeek) || c.sessionsPerWeek < 1) {
      fail('INVALID_SESSIONS', `Course "${c.name}" must have at least 1 session per week.`);
    }
    let durMin = Number.isFinite(c.durationMinutes) ? c.durationMinutes : config.defaultDur;
    const snapped = grid.snapUp(durMin, snap);
    if (snapped !== durMin) {
      warnings.push({
        code: 'DURATION_SNAPPED',
        message: `Course "${c.name}" duration ${durMin} min was rounded up to ${snapped} min to fit the ${snap}-minute grid.`,
      });
      durMin = snapped;
    }
    let maxPerDay = c.maxPerDay == null ? 1 : c.maxPerDay;
    if (!Number.isInteger(maxPerDay) || maxPerDay < 1) {
      fail('INVALID_MAX_PER_DAY', `Course "${c.name}" maxPerDay must be a positive integer.`);
    }
    return {
      id: c.courseId,
      name: c.name,
      classIdx,
      sessionsPerWeek: c.sessionsPerWeek,
      durMin,
      durSlots: durMin / snap,
      teacherCands,
      roomIdx,
      maxPerDay,
    };
  });
  const courseIndex = indexById(normCourses, 'id', 'course');

  // startDomain: bit set = legal start slot. Shared per (classIdx, durSlots).
  const domainCache = new Map();
  const startDomainFor = (classIdx, durSlots) => {
    const key = `${classIdx}:${durSlots}`;
    let dom = domainCache.get(key);
    if (dom) return dom;
    dom = new Uint32Array(totalWords);
    for (let d = 0; d < numDays; d++) {
      const last = slotsPerDay[d] - durSlots;
      for (let s = 0; s <= last; s++) {
        if (grid.rangeIsFree(classBase[classIdx], d * W, s, durSlots)) {
          grid.setRange(dom, d * W, s, 1);
        }
      }
    }
    domainCache.set(key, dom);
    return dom;
  };

  const sessions = [];
  normCourses.forEach((course, courseIdx) => {
    for (let k = 0; k < course.sessionsPerWeek; k++) {
      sessions.push({
        sIdx: sessions.length,
        courseIdx,
        sessionIndex: k,
        classIdx: course.classIdx,
        durSlots: course.durSlots,
        durMin: course.durMin,
        teacherCands: course.teacherCands,
        roomIdx: course.roomIdx,
        startDomain: startDomainFor(course.classIdx, course.durSlots),
        pin: null,
      });
    }
  });

  for (const pin of rawInput.pins || []) {
    const courseIdx = courseIndex.get(pin.courseId);
    if (courseIdx === undefined) {
      fail('UNKNOWN_PIN_COURSE', `Pin references unknown course "${pin.courseId}".`);
    }
    const course = normCourses[courseIdx];
    if (!Number.isInteger(pin.sessionIndex) || pin.sessionIndex < 0 || pin.sessionIndex >= course.sessionsPerWeek) {
      fail(
        'INVALID_PIN_SESSION',
        `Pin on course "${course.name}" has sessionIndex ${pin.sessionIndex}, but the course has ${course.sessionsPerWeek} sessions.`
      );
    }
    const dayIdx = dayIdxByIso.get(pin.day);
    if (dayIdx === undefined) fail('INVALID_PIN_DAY', `Pin on course "${course.name}" uses day ${pin.day}, which is not a school day.`);
    const rel = pin.startMin - dayStartMin[dayIdx];
    if (rel < 0 || rel % snap !== 0) {
      fail(
        'PIN_OFF_GRID',
        `Pin on course "${course.name}" starts at minute ${pin.startMin}, which is not on the ${snap}-minute grid.`
      );
    }
    const slot = rel / snap;
    if (slot + course.durSlots > slotsPerDay[dayIdx]) {
      fail('PIN_OFF_GRID', `Pin on course "${course.name}" does not fit inside the school day.`);
    }
    const teacherIdx = teacherIndex.get(pin.teacherId);
    if (teacherIdx === undefined) fail('UNKNOWN_TEACHER', `Pin on course "${course.name}" references unknown teacher "${pin.teacherId}".`);
    let roomIdx = course.roomIdx;
    if (pin.roomId != null) {
      roomIdx = roomIndex.get(pin.roomId);
      if (roomIdx === undefined) fail('UNKNOWN_ROOM', `Pin on course "${course.name}" references unknown room "${pin.roomId}".`);
    }
    const session = sessions.find(
      (s) => s.courseIdx === courseIdx && s.sessionIndex === pin.sessionIndex
    );
    if (session.pin) {
      fail('DUPLICATE_PIN', `Course "${course.name}" session ${pin.sessionIndex} is pinned twice.`);
    }
    session.pin = { dayIdx, slot, teacherIdx, roomIdx };
  }

  return {
    config,
    numDays,
    days: days.map((d) => d.iso),
    dayStartMin,
    slotsPerDay,
    W,
    totalWords,
    teachers: normTeachers,
    teacherIndex,
    rooms: rooms.map((r) => ({ id: r.roomId, name: r.name })),
    roomIndex,
    classGroups: classGroups.map((g) => ({ id: g.classGroupId, name: g.name })),
    classGroupIndex,
    teacherBase,
    roomBase,
    classBase,
    courses: normCourses,
    sessions,
    warnings,
  };
}

module.exports = { validateAndNormalize, SolverInputError };
