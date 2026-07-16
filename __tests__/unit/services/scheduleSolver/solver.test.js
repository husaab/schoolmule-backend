const { generateSchedules } = require('../../../../services/scheduleSolver');
const { validateCandidate } = require('../../../../services/scheduleSolver/validator');
const { SolverInputError } = require('../../../../services/scheduleSolver/normalize');
const { baseInput, teacher, course, day } = require('./fixtures');

function cfg(overrides = {}) {
  return {
    snapMinutes: 5,
    defaultCourseDurationMinutes: 40,
    seed: 42,
    candidateCount: 5,
    timeBudgetMs: 2000,
    ...overrides,
  };
}

// A comfortably-solvable school: 2 days, 2 teachers, 2 class groups, 4 courses.
function smallSchool(overrides = {}) {
  return baseInput({
    config: cfg(),
    days: [day(1), day(2)],
    teachers: [teacher(), teacher({ teacherId: 't-2', name: 'Mr. Y' })],
    rooms: [{ roomId: 'r-gym', name: 'Gym' }],
    classGroups: [
      { classGroupId: 'cg-1', name: 'Grade 1' },
      { classGroupId: 'cg-2', name: 'Grade 2' },
    ],
    courses: [
      course({ sessionsPerWeek: 2, maxPerDay: 1 }),
      course({ courseId: 'c-2', name: 'Gym Class', teacherId: 't-2', roomId: 'r-gym', sessionsPerWeek: 1 }),
      course({ courseId: 'c-3', classGroupId: 'cg-2', name: 'English', teacherId: 't-2', sessionsPerWeek: 2, maxPerDay: 1 }),
      course({ courseId: 'c-4', classGroupId: 'cg-2', name: 'Art', teacherId: 't-1', sessionsPerWeek: 1 }),
    ],
    ...overrides,
  });
}

describe('generateSchedules — happy path', () => {
  it('solves a small school and every candidate passes the independent validator', () => {
    const input = smallSchool();
    const result = generateSchedules(input);
    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    for (const cand of result.candidates) {
      expect(validateCandidate(input, cand)).toEqual([]);
    }
  });

  it('includes meta with seed, counts, and timing', () => {
    const result = generateSchedules(smallSchool());
    expect(result.meta.requested).toBe(5);
    expect(result.meta.returned).toBe(result.candidates.length);
    expect(result.meta.seed).toBe(42);
    expect(typeof result.meta.elapsedMs).toBe('number');
  });

  it('is deterministic for the same seed', () => {
    const a = generateSchedules(smallSchool());
    const b = generateSchedules(smallSchool());
    expect(a.candidates).toEqual(b.candidates);
  });

  it('returns no two identical candidates', () => {
    const result = generateSchedules(smallSchool());
    const sigs = result.candidates.map((c) =>
      c.sessions
        .map((s) => `${s.courseId}:${s.day}:${s.startMin}`)
        .sort()
        .join('|')
    );
    expect(new Set(sigs).size).toBe(sigs.length);
  });
});

describe('generateSchedules — constraints', () => {
  it('honors pins verbatim in every candidate', () => {
    const input = smallSchool({
      pins: [{ courseId: 'c-1', sessionIndex: 0, day: 1, startMin: 480, teacherId: 't-1', roomId: null }],
    });
    const result = generateSchedules(input);
    expect(result.ok).toBe(true);
    for (const cand of result.candidates) {
      const pinned = cand.sessions.find(
        (s) => s.courseId === 'c-1' && s.day === 1 && s.startMin === 480 && s.teacherId === 't-1'
      );
      expect(pinned).toBeDefined();
      expect(pinned.pinned).toBe(true);
    }
  });

  it('picks an available teacher from a candidate pool', () => {
    const input = smallSchool();
    // Pool course: t-1 is off both days, so only t-2 can take it.
    input.teachers[0].allowedDays = [3];
    input.courses = [
      course({
        sessionsPerWeek: 1,
        teacherId: null,
        teacherCandidateIds: ['t-1', 't-2'],
      }),
    ];
    const result = generateSchedules(input);
    expect(result.ok).toBe(true);
    for (const cand of result.candidates) {
      expect(cand.sessions[0].teacherId).toBe('t-2');
    }
  });

  it('spreads sessions across days per maxPerDay', () => {
    const input = baseInput({
      config: cfg(),
      days: [day(1), day(2), day(3), day(4), day(5)],
      courses: [course({ sessionsPerWeek: 5, maxPerDay: 1 })],
    });
    const result = generateSchedules(input);
    expect(result.ok).toBe(true);
    for (const cand of result.candidates) {
      const days = cand.sessions.map((s) => s.day);
      expect(new Set(days).size).toBe(5);
    }
  });
});

describe('generateSchedules — tight and infeasible instances', () => {
  it('returns a single candidate plus a tight warning when only one schedule exists', () => {
    const input = baseInput({
      config: cfg({ timeBudgetMs: 500 }),
      days: [day(1, [{ startMin: 480, endMin: 560 }])], // exactly 80 fillable minutes
      courses: [course({ sessionsPerWeek: 2, maxPerDay: 2 })],
    });
    const result = generateSchedules(input);
    expect(result.ok).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.meta.warnings.some((w) => w.code === 'SCHEDULE_SPACE_TIGHT')).toBe(true);
  });

  it('reports UNPLACEABLE_SESSION with partial results when pre-solve passes but search fails', () => {
    // One day 480-600. "Long" (80 min, t-1) can only run 520-600 because t-1
    // is excluded 480-520. "Short" (40 min, t-2) also can only run after 520
    // (same exclusion for t-2) — but Long fills 520-600. No schedule exists,
    // yet every arithmetic pre-check passes.
    const input = baseInput({
      config: cfg({ timeBudgetMs: 500 }),
      teachers: [
        teacher({ excludedWindows: [{ day: 1, startMin: 480, endMin: 520 }] }),
        teacher({
          teacherId: 't-2',
          name: 'Mr. Y',
          excludedWindows: [{ day: 1, startMin: 480, endMin: 520 }],
        }),
      ],
      courses: [
        course({ courseId: 'c-long', name: 'Long', sessionsPerWeek: 1, durationMinutes: 80 }),
        course({ courseId: 'c-short', name: 'Short', sessionsPerWeek: 1, durationMinutes: 40, teacherId: 't-2' }),
      ],
    });
    const result = generateSchedules(input);
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('search');
    expect(result.diagnostics[0].code).toBe('UNPLACEABLE_SESSION');
    expect(result.partial).not.toBeNull();
    expect(result.partial.placedSessions.length + result.partial.unplaced.length).toBe(2);
    expect(result.partial.unplaced.length).toBeGreaterThanOrEqual(1);
  });

  it('returns preSolve diagnostics for arithmetically infeasible input', () => {
    const input = baseInput({
      config: cfg(),
      teachers: [teacher({ maxMinutesPerWeek: 40 })],
      courses: [course({ sessionsPerWeek: 3, maxPerDay: 3 })],
    });
    const result = generateSchedules(input);
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('preSolve');
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  });

  it('throws SolverInputError for malformed input', () => {
    expect(() => generateSchedules({ config: {}, days: [] })).toThrow(SolverInputError);
  });
});
