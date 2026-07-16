// Shared input builders for schedule-solver tests.
// Base school: one day (Mon) 08:00-10:00 (120 min, 24 slots at snap 5),
// one teacher, one class group, one course (Math 2x40, maxPerDay 2).

function teacher(overrides = {}) {
  return {
    teacherId: 't-1',
    name: 'Ms. X',
    fullTime: true,
    maxMinutesPerWeek: null,
    allowedDays: [1, 2, 3, 4, 5],
    excludedWindows: [],
    ...overrides,
  };
}

function course(overrides = {}) {
  return {
    courseId: 'c-1',
    classGroupId: 'cg-1',
    name: 'Math',
    sessionsPerWeek: 2,
    durationMinutes: 40,
    teacherId: 't-1',
    teacherCandidateIds: null,
    roomId: null,
    maxPerDay: 2,
    ...overrides,
  };
}

function day(iso, ranges = [{ startMin: 480, endMin: 600 }]) {
  return { day: iso, fillableRanges: ranges };
}

function baseInput(overrides = {}) {
  return {
    config: { snapMinutes: 5, defaultCourseDurationMinutes: 40 },
    days: [day(1)],
    fixedBlocks: [],
    teachers: [teacher()],
    rooms: [],
    classGroups: [{ classGroupId: 'cg-1', name: 'Grade 1' }],
    courses: [course()],
    pins: [],
    ...overrides,
  };
}

module.exports = { baseInput, teacher, course, day };
