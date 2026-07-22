// baseSessions: warm-starting generation from a saved schedule's sessions.

const { generateSchedules } = require('../../../../services/scheduleSolver');
const { validateCandidate } = require('../../../../services/scheduleSolver/validator');
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

// Roomy 2-teacher school: plenty of slack so many distinct schedules exist.
function school(overrides = {}) {
  return baseInput({
    config: cfg(),
    days: [day(1), day(2), day(3)],
    teachers: [teacher(), teacher({ teacherId: 't-2', name: 'Mr. Y' })],
    classGroups: [
      { classGroupId: 'cg-1', name: 'Grade 1' },
      { classGroupId: 'cg-2', name: 'Grade 2' },
    ],
    courses: [
      course({ sessionsPerWeek: 2, maxPerDay: 1 }),
      course({ courseId: 'c-2', name: 'Science', teacherId: 't-2', sessionsPerWeek: 2, maxPerDay: 1 }),
      course({ courseId: 'c-3', classGroupId: 'cg-2', name: 'English', teacherId: 't-2', sessionsPerWeek: 1 }),
      course({ courseId: 'c-4', classGroupId: 'cg-2', name: 'Art', teacherId: 't-1', sessionsPerWeek: 1 }),
    ],
    ...overrides,
  });
}

// Course-level placement signature matching the engine's diversity semantics
// (sessions of a course are interchangeable, so sessionIndex is excluded).
function sigOf(sessions) {
  return sessions.map((s) => `${s.courseId}:${s.day}:${s.startMin}`).sort();
}

function similarity(a, b) {
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      shared++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return shared / Math.max(a.length, b.length, 1);
}

function firstCandidateSessions(input) {
  const result = generateSchedules({ ...input, config: { ...input.config, candidateCount: 1 } });
  expect(result.ok).toBe(true);
  return result.candidates[0].sessions;
}

describe('generateSchedules — baseSessions warm start', () => {
  it('produces valid candidates that all differ from the base schedule', () => {
    const input = school();
    const base = firstCandidateSessions(input);

    const result = generateSchedules({ ...input, baseSessions: base });
    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);

    const baseSig = sigOf(base);
    for (const cand of result.candidates) {
      expect(validateCandidate(input, cand)).toEqual([]);
      expect(similarity(sigOf(cand.sessions), baseSig)).toBeLessThanOrEqual(0.9);
    }
  });

  it('is deterministic for the same seed and base', () => {
    const input = school();
    const base = firstCandidateSessions(input);
    const a = generateSchedules({ ...input, baseSessions: base });
    const b = generateSchedules({ ...input, baseSessions: base });
    expect(a.candidates).toEqual(b.candidates);
  });

  it('drops base sessions that no longer match the config and warns', () => {
    const input = school();
    const base = firstCandidateSessions(input);
    const stale = [
      { ...base[0], courseId: 'c-deleted' }, // course no longer exists
      { ...base[1], day: 6 }, // day not in templates
      { ...base[2], teacherId: 't-gone' }, // teacher no longer exists
      ...base.slice(3),
    ];

    const result = generateSchedules({ ...input, baseSessions: stale });
    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    for (const cand of result.candidates) {
      expect(validateCandidate(input, cand)).toEqual([]);
    }
    const codes = result.meta.warnings.map((w) => w.code);
    expect(codes).toContain('BASE_SCHEDULE_PARTIAL');
  });

  it('degrades to fresh generation when no base session maps', () => {
    const input = school();
    const garbage = [
      { courseId: 'nope', sessionIndex: 0, day: 1, startMin: 480, endMin: 520, teacherId: 't-1', roomId: null },
    ];
    const result = generateSchedules({ ...input, baseSessions: garbage });
    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    const codes = result.meta.warnings.map((w) => w.code);
    expect(codes).toContain('BASE_SCHEDULE_PARTIAL');
  });

  it('drops a base session whose duration no longer matches the course', () => {
    const input = school();
    const base = firstCandidateSessions(input);
    const wrongDur = base.map((s, i) => (i === 0 ? { ...s, endMin: s.startMin + 999 } : s));

    const result = generateSchedules({ ...input, baseSessions: wrongDur });
    expect(result.ok).toBe(true);
    const codes = result.meta.warnings.map((w) => w.code);
    expect(codes).toContain('BASE_SCHEDULE_PARTIAL');
  });

  it('reports SCHEDULE_SPACE_TIGHT (not UNPLACEABLE) when only near-copies of the base exist', () => {
    // Exactly one schedule exists up to signature: one course fills the whole
    // day, and same-course sessions are interchangeable. Seeding that unique
    // schedule as the base means every solve is a duplicate.
    const input = baseInput({
      config: cfg({ timeBudgetMs: 1000, candidateCount: 3 }),
      days: [day(1, [{ startMin: 480, endMin: 560 }])], // exactly 80 fillable minutes
      courses: [course({ sessionsPerWeek: 2, maxPerDay: 2 })],
    });
    const base = firstCandidateSessions(input);

    const result = generateSchedules({ ...input, baseSessions: base });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('search');
    expect(result.diagnostics[0].code).toBe('SCHEDULE_SPACE_TIGHT');
  });

  it('composes with pins: pinned placement appears in every candidate', () => {
    const input = school();
    const base = firstCandidateSessions(input);
    const pin = { courseId: 'c-1', sessionIndex: 0, day: 1, startMin: 480, teacherId: 't-1', roomId: null };

    const result = generateSchedules({ ...input, pins: [pin], baseSessions: base });
    expect(result.ok).toBe(true);
    for (const cand of result.candidates) {
      const pinned = cand.sessions.find(
        (s) => s.courseId === 'c-1' && s.day === 1 && s.startMin === 480 && s.teacherId === 't-1'
      );
      expect(pinned).toBeDefined();
      expect(pinned.pinned).toBe(true);
    }
  });
});
