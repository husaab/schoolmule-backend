const { validateAndNormalize } = require('../../../../services/scheduleSolver/normalize');
const { preSolveCheck } = require('../../../../services/scheduleSolver/feasibility');
const { baseInput, teacher, course, day } = require('./fixtures');

function check(input) {
  return preSolveCheck(validateAndNormalize(input));
}

function codes(result) {
  return result.errors.map((e) => e.code);
}

describe('preSolveCheck', () => {
  it('passes a healthy school', () => {
    const result = check(baseInput());
    expect(result.feasible).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports all applicable errors at once, not fail-fast', () => {
    // Teacher over max AND class group overflow in the same input.
    const input = baseInput({
      teachers: [teacher({ maxMinutesPerWeek: 60 })],
      courses: [
        course({ sessionsPerWeek: 4 }), // 160 min in a 120-min day, 160 > 60 max
      ],
    });
    const result = check(input);
    expect(result.feasible).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining(['TEACHER_OVER_MAX_HOURS', 'CLASS_GROUP_OVERFLOW'])
    );
  });

  it('detects TEACHER_OVER_MAX_HOURS with an hours-based message', () => {
    const input = baseInput({
      teachers: [teacher({ maxMinutesPerWeek: 60 })],
      courses: [course({ sessionsPerWeek: 3, maxPerDay: 3 })], // 120 min > 60
    });
    const result = check(input);
    const err = result.errors.find((e) => e.code === 'TEACHER_OVER_MAX_HOURS');
    expect(err).toBeDefined();
    expect(err.message).toContain('Ms. X');
    expect(err.message).toContain('2.0h');
    expect(err.message).toContain('1.0h');
  });

  it('detects TEACHER_INSUFFICIENT_AVAILABILITY', () => {
    const input = baseInput({
      teachers: [teacher({ excludedWindows: [{ day: 1, startMin: 480, endMin: 560 }] })],
      // teacher has 40 free minutes; course needs 80
    });
    const result = check(input);
    expect(codes(result)).toContain('TEACHER_INSUFFICIENT_AVAILABILITY');
  });

  it('detects CLASS_GROUP_OVERFLOW', () => {
    const input = baseInput({
      teachers: [teacher(), teacher({ teacherId: 't-2', name: 'Mr. Y' })],
      courses: [
        course(),
        course({ courseId: 'c-2', name: 'English', teacherId: 't-2' }),
      ], // 160 min required in a 120-min class-group week
    });
    const result = check(input);
    expect(codes(result)).toContain('CLASS_GROUP_OVERFLOW');
    const err = result.errors.find((e) => e.code === 'CLASS_GROUP_OVERFLOW');
    expect(err.message).toContain('Grade 1');
  });

  it('detects ROOM_OVERBOOKED', () => {
    const input = baseInput({
      rooms: [{ roomId: 'r-gym', name: 'Gym' }],
      teachers: [teacher(), teacher({ teacherId: 't-2', name: 'Mr. Y' })],
      classGroups: [
        { classGroupId: 'cg-1', name: 'Grade 1' },
        { classGroupId: 'cg-2', name: 'Grade 2' },
      ],
      courses: [
        course({ roomId: 'r-gym' }),
        course({ courseId: 'c-2', classGroupId: 'cg-2', teacherId: 't-2', roomId: 'r-gym' }),
      ], // gym needed 160 min, open 120
    });
    const result = check(input);
    expect(codes(result)).toContain('ROOM_OVERBOOKED');
    const err = result.errors.find((e) => e.code === 'ROOM_OVERBOOKED');
    expect(err.message).toContain('Gym');
  });

  it('detects SESSION_DOES_NOT_FIT for a duration longer than any window', () => {
    const input = baseInput({
      courses: [course({ sessionsPerWeek: 1, durationMinutes: 130 })],
    });
    const result = check(input);
    expect(codes(result)).toContain('SESSION_DOES_NOT_FIT');
    const err = result.errors.find((e) => e.code === 'SESSION_DOES_NOT_FIT');
    expect(err.message).toContain('Math');
  });

  it('detects NO_TEACHER_AVAILABLE when teacher and class free times never align', () => {
    const input = baseInput({
      days: [day(1), day(2)],
      teachers: [teacher({ allowedDays: [2] })],
      fixedBlocks: [
        // Grade 1's entire day 2 is blocked, so Math can only run day 1 —
        // but the teacher only works day 2.
        { label: 'Trip', day: 2, startMin: 480, endMin: 600, classGroupIds: ['cg-1'] },
      ],
      courses: [course({ sessionsPerWeek: 1 })],
    });
    const result = check(input);
    expect(codes(result)).toContain('NO_TEACHER_AVAILABLE');
  });

  it('detects SESSIONS_EXCEED_DAYS', () => {
    const input = baseInput({
      courses: [course({ sessionsPerWeek: 2, maxPerDay: 1 })], // 2 sessions, 1 day
    });
    const result = check(input);
    expect(codes(result)).toContain('SESSIONS_EXCEED_DAYS');
  });

  it('detects PIN_CONFLICT for two pins sharing a teacher at the same time', () => {
    const input = baseInput({
      classGroups: [
        { classGroupId: 'cg-1', name: 'Grade 1' },
        { classGroupId: 'cg-2', name: 'Grade 2' },
      ],
      courses: [
        course({ sessionsPerWeek: 1 }),
        course({ courseId: 'c-2', classGroupId: 'cg-2', name: 'Science', sessionsPerWeek: 1 }),
      ],
      pins: [
        { courseId: 'c-1', sessionIndex: 0, day: 1, startMin: 480, teacherId: 't-1', roomId: null },
        { courseId: 'c-2', sessionIndex: 0, day: 1, startMin: 500, teacherId: 't-1', roomId: null },
      ],
    });
    const result = check(input);
    expect(codes(result)).toContain('PIN_CONFLICT');
  });

  it('detects PIN_CONFLICT for a pin on a blocked slot', () => {
    const input = baseInput({
      fixedBlocks: [{ label: 'Lunch', day: 1, startMin: 480, endMin: 520, classGroupIds: [] }],
      courses: [course({ sessionsPerWeek: 1 })],
      pins: [{ courseId: 'c-1', sessionIndex: 0, day: 1, startMin: 490, teacherId: 't-1', roomId: null }],
    });
    const result = check(input);
    expect(codes(result)).toContain('PIN_CONFLICT');
  });

  it('detects POOL_CAPACITY_SHORT across a shared candidate pool', () => {
    const input = baseInput({
      days: [day(1), day(2)],
      teachers: [
        teacher({ maxMinutesPerWeek: 40 }),
        teacher({ teacherId: 't-2', name: 'Mr. Y', maxMinutesPerWeek: 40 }),
        teacher({ teacherId: 't-3', name: 'Mx. Z' }), // spare capacity, not in pool
      ],
      classGroups: [
        { classGroupId: 'cg-1', name: 'Grade 1' },
        { classGroupId: 'cg-2', name: 'Grade 2' },
        { classGroupId: 'cg-3', name: 'Grade 3' },
      ],
      courses: [
        course({ sessionsPerWeek: 1, teacherId: null, teacherCandidateIds: ['t-1', 't-2'] }),
        course({ courseId: 'c-2', classGroupId: 'cg-2', sessionsPerWeek: 1, teacherId: null, teacherCandidateIds: ['t-1', 't-2'] }),
        course({ courseId: 'c-3', classGroupId: 'cg-3', sessionsPerWeek: 1, teacherId: null, teacherCandidateIds: ['t-1', 't-2'] }),
      ], // pool {t-1,t-2} capacity 80 min, demand 120 min
    });
    const result = check(input);
    expect(codes(result)).toContain('POOL_CAPACITY_SHORT');
  });

  it('detects TOTAL_TEACHER_CAPACITY exhaustion', () => {
    const input = baseInput({
      teachers: [teacher({ maxMinutesPerWeek: 40 })],
      courses: [course({ sessionsPerWeek: 3, maxPerDay: 3 })], // 120 min vs 40 capacity
    });
    const result = check(input);
    expect(codes(result)).toContain('TOTAL_TEACHER_CAPACITY');
  });

  it('detects TEACHER_SPARE_IMPOSSIBLE when no day has a window big enough', () => {
    const input = baseInput({
      // Day is 480-600 with 480-520 blocked school-wide: max possible free
      // run for anyone is 80 min; teacher needs a 90-min spare.
      fixedBlocks: [{ label: 'Assembly', day: 1, startMin: 480, endMin: 520, classGroupIds: [] }],
      teachers: [teacher({ dailySpareMinutes: 90 })],
      courses: [course({ sessionsPerWeek: 1 })],
    });
    const result = check(input);
    expect(codes(result)).toContain('TEACHER_SPARE_IMPOSSIBLE');
    const err = result.errors.find((e) => e.code === 'TEACHER_SPARE_IMPOSSIBLE');
    expect(err.message).toContain('Ms. X');
  });

  it('passes when the spare fits alongside the teaching load', () => {
    const input = baseInput({
      teachers: [teacher({ dailySpareMinutes: 45 })],
      courses: [course({ sessionsPerWeek: 1 })], // 40 min class in a 120-min day
    });
    const result = check(input);
    expect(result.feasible).toBe(true);
  });

  it('emits a tightness warning above 90% utilization while staying feasible', () => {
    const input = baseInput({
      courses: [course({ sessionsPerWeek: 3, maxPerDay: 3 })], // 120/120 class-group minutes
    });
    const result = check(input);
    expect(result.feasible).toBe(true);
    expect(result.warnings.some((w) => w.code.endsWith('_TIGHT'))).toBe(true);
  });
});
