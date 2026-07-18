// Period rules: teach-rules (a class's sessions in a daily window belong to a
// teacher on >= N days), free-rules (a teacher keeps >= N period-slots free in
// a window across the week), and maxDaysPerWeek (distinct working days cap).

const { generateSchedules } = require('../../../../services/scheduleSolver');
const { validateAndNormalize, SolverInputError } = require('../../../../services/scheduleSolver/normalize');
const { validateCandidate } = require('../../../../services/scheduleSolver/validator');
const { preSolveCheck } = require('../../../../services/scheduleSolver/feasibility');
const { baseInput, teacher, course, day } = require('./fixtures');

function cfg(overrides = {}) {
  return {
    snapMinutes: 5,
    defaultCourseDurationMinutes: 40,
    seed: 42,
    candidateCount: 4,
    timeBudgetMs: 2000,
    ...overrides,
  };
}

// Two teachers, two class groups, 2 days 08:00-10:00 (3 x 40-min slots/day).
function school(overrides = {}) {
  return baseInput({
    config: cfg(),
    days: [day(1), day(2)],
    teachers: [teacher(), teacher({ teacherId: 't-2', name: 'Mr. Y' })],
    classGroups: [
      { classGroupId: 'cg-1', name: 'Grade 1' },
      { classGroupId: 'cg-2', name: 'Grade 2' },
    ],
    courses: [
      course({ sessionsPerWeek: 2, maxPerDay: 1 }), // Math, t-1, cg-1
      course({ courseId: 'c-2', name: 'English', teacherId: 't-2', sessionsPerWeek: 2, maxPerDay: 1 }),
      course({ courseId: 'c-3', classGroupId: 'cg-2', name: 'Science', teacherId: 't-2', sessionsPerWeek: 2, maxPerDay: 1 }),
      course({ courseId: 'c-4', classGroupId: 'cg-2', name: 'Art', teacherId: 't-1', sessionsPerWeek: 2, maxPerDay: 1 }),
    ],
    ...overrides,
  });
}

describe('normalize — period rules and maxDaysPerWeek', () => {
  it('normalizes rules and rejects unknown references', () => {
    const input = school({
      periodRules: [
        { teacherId: 't-1', classGroupId: 'cg-1', startMin: 480, endMin: 520, minPerWeek: 2, kind: 'teach' },
        { teacherId: 't-2', startMin: 480, endMin: 560, minPerWeek: 1, kind: 'free' },
      ],
    });
    const model = validateAndNormalize(input);
    expect(model.periodRules).toHaveLength(2);
    expect(model.periodRules[0].kind).toBe('teach');
    expect(model.periodRules[1].classIdx).toBe(-1);

    const bad = school({
      periodRules: [{ teacherId: 't-999', startMin: 480, endMin: 520, minPerWeek: 1, kind: 'free' }],
    });
    expect(() => validateAndNormalize(bad)).toThrow(SolverInputError);
  });

  it('normalizes maxDaysPerWeek on teachers', () => {
    const input = school();
    input.teachers[0].maxDaysPerWeek = 1;
    const model = validateAndNormalize(input);
    expect(model.teachers[0].maxDays).toBe(1);
    expect(model.teachers[1].maxDays).toBe(7); // unset = unlimited
  });
});

describe('validator — period rules', () => {
  const goodSessions = [
    // day 1: cg-1 Math(t-1)@480, English(t-2)@520 ; cg-2 Science(t-2)@480... conflict t-2!
  ];

  function sessionsFor(assignments) {
    // assignments: [courseId, name, group, day, startMin, teacherId]
    return assignments.map(([courseId, courseName, classGroupId, d, startMin, teacherId], i) => ({
      courseId,
      sessionIndex: assignments.slice(0, i).filter((a) => a[0] === courseId).length,
      classGroupId,
      courseName,
      day: d,
      startMin,
      endMin: startMin + 40,
      teacherId,
      roomId: null,
      pinned: false,
    }));
  }

  it('flags a teach-rule violated on too many days', () => {
    const raw = school({
      periodRules: [
        // t-1 must teach cg-1's first slot (480-520) on both days
        { teacherId: 't-1', classGroupId: 'cg-1', startMin: 480, endMin: 520, minPerWeek: 2, kind: 'teach' },
      ],
    });
    const cand = {
      sessions: sessionsFor([
        ['c-1', 'Math', 'cg-1', 1, 480, 't-1'],    // day 1 first slot: t-1 ✓
        ['c-2', 'English', 'cg-1', 1, 520, 't-2'],
        ['c-1', 'Math', 'cg-1', 2, 520, 't-1'],
        ['c-2', 'English', 'cg-1', 2, 480, 't-2'], // day 2 first slot: t-2 ✗
        ['c-3', 'Science', 'cg-2', 1, 560, 't-2'],
        ['c-3', 'Science', 'cg-2', 2, 560, 't-2'],
        ['c-4', 'Art', 'cg-2', 1, 520, 't-1'],
        ['c-4', 'Art', 'cg-2', 2, 480, 't-1'],
      ]),
    };
    const codes = validateCandidate(raw, cand).map((v) => v.code);
    expect(codes).toContain('PERIOD_RULE_VIOLATION');
  });

  it('passes when the teach-rule is satisfied on enough days', () => {
    const raw = school({
      periodRules: [
        { teacherId: 't-1', classGroupId: 'cg-1', startMin: 480, endMin: 520, minPerWeek: 2, kind: 'teach' },
      ],
    });
    const cand = {
      sessions: sessionsFor([
        ['c-1', 'Math', 'cg-1', 1, 480, 't-1'],
        ['c-2', 'English', 'cg-1', 1, 520, 't-2'],
        ['c-1', 'Math', 'cg-1', 2, 480, 't-1'],
        ['c-2', 'English', 'cg-1', 2, 520, 't-2'],
        ['c-3', 'Science', 'cg-2', 1, 480, 't-2'],
        ['c-3', 'Science', 'cg-2', 2, 480, 't-2'],
        ['c-4', 'Art', 'cg-2', 1, 560, 't-1'],
        ['c-4', 'Art', 'cg-2', 2, 560, 't-1'],
      ]),
    };
    expect(validateCandidate(raw, cand)).toEqual([]);
  });

  it('flags a free-rule when the teacher has too few free window slots', () => {
    const raw = school({
      periodRules: [
        // t-2 needs >= 2 free 40-min slots within 480-560 across the week
        { teacherId: 't-2', startMin: 480, endMin: 560, minPerWeek: 2, kind: 'free' },
      ],
    });
    // t-2 teaches 480 and 520 on BOTH days -> zero free window slots
    const cand = {
      sessions: sessionsFor([
        ['c-2', 'English', 'cg-1', 1, 480, 't-2'],
        ['c-3', 'Science', 'cg-2', 1, 520, 't-2'],
        ['c-2', 'English', 'cg-1', 2, 480, 't-2'],
        ['c-3', 'Science', 'cg-2', 2, 520, 't-2'],
        ['c-1', 'Math', 'cg-1', 1, 520, 't-1'],
        ['c-1', 'Math', 'cg-1', 2, 520, 't-1'],
        ['c-4', 'Art', 'cg-2', 1, 480, 't-1'],
        ['c-4', 'Art', 'cg-2', 2, 480, 't-1'],
      ]),
    };
    const codes = validateCandidate(raw, cand).map((v) => v.code);
    expect(codes).toContain('PERIOD_RULE_VIOLATION');
  });

  it('flags exceeding maxDaysPerWeek', () => {
    const raw = school();
    raw.teachers[0].maxDaysPerWeek = 1;
    const cand = {
      sessions: sessionsFor([
        ['c-1', 'Math', 'cg-1', 1, 480, 't-1'],
        ['c-1', 'Math', 'cg-1', 2, 480, 't-1'], // t-1 on 2 distinct days
        ['c-2', 'English', 'cg-1', 1, 520, 't-2'],
        ['c-2', 'English', 'cg-1', 2, 520, 't-2'],
        ['c-3', 'Science', 'cg-2', 1, 480, 't-2'],
        ['c-3', 'Science', 'cg-2', 2, 480, 't-2'],
        ['c-4', 'Art', 'cg-2', 1, 520, 't-1'],
        ['c-4', 'Art', 'cg-2', 2, 520, 't-1'],
      ]),
    };
    const codes = validateCandidate(raw, cand).map((v) => v.code);
    expect(codes).toContain('MAX_DAYS_EXCEEDED');
  });
});

describe('validator — multi-period window uses at-least-one semantics', () => {
  it('qualifies a day when the teacher has ONE session in a two-period window', () => {
    // Rule: t-1 with cg-1 somewhere in 480-560 (two periods) on both days.
    // t-1 teaches only ONE of the two window sessions each day — that counts.
    const raw = school({
      periodRules: [
        { teacherId: 't-1', classGroupId: 'cg-1', startMin: 480, endMin: 560, minPerWeek: 2, kind: 'teach' },
      ],
    });
    const cand = {
      sessions: [
        { courseId: 'c-1', sessionIndex: 0, classGroupId: 'cg-1', courseName: 'Math', day: 1, startMin: 480, endMin: 520, teacherId: 't-1', roomId: null, pinned: false },
        { courseId: 'c-2', sessionIndex: 0, classGroupId: 'cg-1', courseName: 'English', day: 1, startMin: 520, endMin: 560, teacherId: 't-2', roomId: null, pinned: false },
        { courseId: 'c-1', sessionIndex: 1, classGroupId: 'cg-1', courseName: 'Math', day: 2, startMin: 520, endMin: 560, teacherId: 't-1', roomId: null, pinned: false },
        { courseId: 'c-2', sessionIndex: 1, classGroupId: 'cg-1', courseName: 'English', day: 2, startMin: 480, endMin: 520, teacherId: 't-2', roomId: null, pinned: false },
        { courseId: 'c-3', sessionIndex: 0, classGroupId: 'cg-2', courseName: 'Science', day: 1, startMin: 480, endMin: 520, teacherId: 't-2', roomId: null, pinned: false },
        { courseId: 'c-3', sessionIndex: 1, classGroupId: 'cg-2', courseName: 'Science', day: 2, startMin: 560, endMin: 600, teacherId: 't-2', roomId: null, pinned: false },
        { courseId: 'c-4', sessionIndex: 0, classGroupId: 'cg-2', courseName: 'Art', day: 1, startMin: 560, endMin: 600, teacherId: 't-1', roomId: null, pinned: false },
        { courseId: 'c-4', sessionIndex: 1, classGroupId: 'cg-2', courseName: 'Art', day: 2, startMin: 480, endMin: 520, teacherId: 't-1', roomId: null, pinned: false },
      ],
    };
    expect(validateCandidate(raw, cand)).toEqual([]);
  });
});

describe('solver — period rules enforcement', () => {
  it('honors a teach-rule in every candidate', () => {
    const input = school({
      periodRules: [
        { teacherId: 't-1', classGroupId: 'cg-1', startMin: 480, endMin: 520, minPerWeek: 2, kind: 'teach' },
      ],
    });
    const result = generateSchedules(input);
    expect(result.ok).toBe(true);
    for (const cand of result.candidates) {
      expect(validateCandidate(input, cand)).toEqual([]);
      // first slot of cg-1 must be t-1 on both days
      const firstSlots = cand.sessions.filter(
        (s) => s.classGroupId === 'cg-1' && s.startMin < 520
      );
      expect(firstSlots.every((s) => s.teacherId === 't-1')).toBe(true);
    }
  });

  it('honors a free-rule in every candidate', () => {
    const input = school({
      periodRules: [
        { teacherId: 't-2', startMin: 480, endMin: 560, minPerWeek: 2, kind: 'free' },
      ],
    });
    const result = generateSchedules(input);
    expect(result.ok).toBe(true);
    for (const cand of result.candidates) {
      expect(validateCandidate(input, cand)).toEqual([]);
    }
  });

  it('honors maxDaysPerWeek in every candidate', () => {
    const input = school();
    input.teachers[0].maxDaysPerWeek = 1; // t-1's 4 sessions must share one day... impossible (2 courses x maxPerDay 1 x 2 groups = 2/day max is 2 sessions? c-1 2/wk + c-4 2/wk with maxPerDay 1 each -> max 2 sessions/day -> needs 2 days) -> infeasible
    const result = generateSchedules(input);
    expect(result.ok).toBe(false);

    input.teachers[0].maxDaysPerWeek = 2;
    const result2 = generateSchedules(input);
    expect(result2.ok).toBe(true);
    for (const cand of result2.candidates) {
      const days = new Set(cand.sessions.filter((s) => s.teacherId === 't-1').map((s) => s.day));
      expect(days.size).toBeLessThanOrEqual(2);
      expect(validateCandidate(input, cand)).toEqual([]);
    }
  });
});

describe('feasibility — period rules pre-checks', () => {
  it('rejects a teach-rule whose teacher lacks enough allowed days', () => {
    const input = school({
      periodRules: [
        { teacherId: 't-1', classGroupId: 'cg-1', startMin: 480, endMin: 520, minPerWeek: 2, kind: 'teach' },
      ],
    });
    input.teachers[0].allowedDays = [1]; // needs 2 days but only works 1
    const result = preSolveCheck(validateAndNormalize(input));
    expect(result.errors.map((e) => e.code)).toContain('PERIOD_RULE_IMPOSSIBLE');
  });

  it('rejects a free-rule that cannot fit next to the teaching load', () => {
    // t-2 teaches 4 sessions; grid has 3 slots/day x 2 days = 6 per teacher.
    // Window 480-560 holds 2 slots/day = 4/week; teaching demand inside the
    // window can leave at most... require 5 free slots -> impossible.
    const input = school({
      periodRules: [{ teacherId: 't-2', startMin: 480, endMin: 560, minPerWeek: 5, kind: 'free' }],
    });
    const result = preSolveCheck(validateAndNormalize(input));
    expect(result.errors.map((e) => e.code)).toContain('PERIOD_RULE_IMPOSSIBLE');
  });
});
