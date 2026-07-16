const { validateAndNormalize, SolverInputError } = require('../../../../services/scheduleSolver/normalize');
const grid = require('../../../../services/scheduleSolver/timeGrid');

// Minimal valid input: one day (Mon), 08:00-10:00 fillable, snap 5 -> 24 slots.
function baseInput(overrides = {}) {
  return {
    config: { snapMinutes: 5, defaultCourseDurationMinutes: 40 },
    days: [{ day: 1, fillableRanges: [{ startMin: 480, endMin: 600 }] }],
    fixedBlocks: [],
    teachers: [
      {
        teacherId: 't-1',
        name: 'Ms. X',
        fullTime: true,
        maxMinutesPerWeek: null,
        allowedDays: [1, 2, 3, 4, 5],
        excludedWindows: [],
      },
    ],
    rooms: [],
    classGroups: [{ classGroupId: 'cg-1', name: 'Grade 1' }],
    courses: [
      {
        courseId: 'c-1',
        classGroupId: 'cg-1',
        name: 'Math',
        sessionsPerWeek: 2,
        durationMinutes: 40,
        teacherId: 't-1',
        teacherCandidateIds: null,
        roomId: null,
        maxPerDay: null,
      },
    ],
    pins: [],
    ...overrides,
  };
}

describe('config defaults and clamps', () => {
  it('applies defaults for missing config values', () => {
    const input = baseInput();
    delete input.config;
    const model = validateAndNormalize({ ...input, config: {} });
    expect(model.config.snap).toBe(5);
    expect(model.config.defaultDur).toBe(40);
    expect(model.config.candidateCount).toBe(20);
    expect(model.config.timeBudgetMs).toBe(10000);
    expect(typeof model.config.seed).toBe('number');
  });

  it('clamps candidateCount to [1, 50]', () => {
    expect(
      validateAndNormalize(baseInput({ config: { candidateCount: 99 } })).config.candidateCount
    ).toBe(50);
    expect(
      validateAndNormalize(baseInput({ config: { candidateCount: 0 } })).config.candidateCount
    ).toBe(1);
  });

  it('clamps timeBudgetMs to [500, 10000]', () => {
    expect(
      validateAndNormalize(baseInput({ config: { timeBudgetMs: 60000 } })).config.timeBudgetMs
    ).toBe(10000);
    expect(
      validateAndNormalize(baseInput({ config: { timeBudgetMs: 10 } })).config.timeBudgetMs
    ).toBe(500);
  });
});

describe('grid construction', () => {
  it('computes per-day slot counts from fillable ranges', () => {
    const model = validateAndNormalize(baseInput());
    expect(model.numDays).toBe(1);
    expect(model.dayStartMin[0]).toBe(480);
    expect(model.slotsPerDay[0]).toBe(24); // 120 min / 5
    expect(model.W).toBe(grid.wordsForSlots(24));
  });

  it('snaps fillable range edges inward to the grid', () => {
    const model = validateAndNormalize(
      baseInput({ days: [{ day: 1, fillableRanges: [{ startMin: 482, endMin: 598 }] }] })
    );
    expect(model.dayStartMin[0]).toBe(485);
    expect(model.slotsPerDay[0]).toBe(22); // 485..595 = 110 min
  });

  it('rejects duplicate days', () => {
    const days = [
      { day: 1, fillableRanges: [{ startMin: 480, endMin: 600 }] },
      { day: 1, fillableRanges: [{ startMin: 480, endMin: 600 }] },
    ];
    expect(() => validateAndNormalize(baseInput({ days }))).toThrow(SolverInputError);
  });

  it('rejects a fillable range with endMin <= startMin', () => {
    const days = [{ day: 1, fillableRanges: [{ startMin: 600, endMin: 480 }] }];
    expect(() => validateAndNormalize(baseInput({ days }))).toThrow(SolverInputError);
  });
});

describe('session expansion and durations', () => {
  it('expands each course into sessionsPerWeek session variables', () => {
    const model = validateAndNormalize(baseInput());
    expect(model.sessions).toHaveLength(2);
    expect(model.sessions[0].durSlots).toBe(8); // 40 / 5
    expect(model.sessions[0].durMin).toBe(40);
    expect(model.sessions[0].classIdx).toBe(0);
  });

  it('falls back to the default course duration when durationMinutes is null', () => {
    const input = baseInput();
    input.courses[0].durationMinutes = null;
    input.config.defaultCourseDurationMinutes = 60;
    const model = validateAndNormalize(input);
    expect(model.sessions[0].durMin).toBe(60);
    expect(model.sessions[0].durSlots).toBe(12);
  });

  it('snaps off-grid durations up and records a warning', () => {
    const input = baseInput();
    input.courses[0].durationMinutes = 42;
    const model = validateAndNormalize(input);
    expect(model.sessions[0].durMin).toBe(45);
    expect(model.warnings).toContainEqual(
      expect.objectContaining({ code: 'DURATION_SNAPPED' })
    );
  });

  it('defaults maxPerDay to 1', () => {
    const model = validateAndNormalize(baseInput());
    expect(model.courses[0].maxPerDay).toBe(1);
  });
});

describe('teacher base occupancy', () => {
  it('blocks all slots on non-allowed days', () => {
    const input = baseInput({
      days: [
        { day: 1, fillableRanges: [{ startMin: 480, endMin: 600 }] },
        { day: 2, fillableRanges: [{ startMin: 480, endMin: 600 }] },
      ],
    });
    input.teachers[0].allowedDays = [1];
    const model = validateAndNormalize(input);
    const occ = model.teacherBase[0];
    expect(grid.rangeIsFree(occ, 0 * model.W, 0, 24)).toBe(true); // Mon free
    expect(grid.countFreeSlots(occ, 1 * model.W, 24)).toBe(0); // Tue fully blocked
  });

  it('blocks excluded windows', () => {
    const input = baseInput();
    input.teachers[0].excludedWindows = [{ day: 1, startMin: 480, endMin: 500 }];
    const model = validateAndNormalize(input);
    const occ = model.teacherBase[0];
    expect(grid.rangeIsFree(occ, 0, 0, 4)).toBe(false); // 480-500 = slots 0..3
    expect(grid.rangeIsFree(occ, 0, 4, 20)).toBe(true);
  });

  it('blocks time outside fillable ranges', () => {
    const input = baseInput({
      days: [
        {
          day: 1,
          fillableRanges: [
            { startMin: 480, endMin: 510 },
            { startMin: 540, endMin: 600 },
          ],
        },
      ],
    });
    const model = validateAndNormalize(input);
    const occ = model.teacherBase[0];
    // Grid spans 480..600 = 24 slots; 510..540 (slots 6..11) is a gap
    expect(grid.rangeIsFree(occ, 0, 0, 6)).toBe(true);
    expect(grid.rangeIsFree(occ, 0, 6, 6)).toBe(false);
    expect(grid.rangeIsFree(occ, 0, 12, 12)).toBe(true);
  });
});

describe('class group base occupancy and fixed blocks', () => {
  it('applies school-wide fixed blocks to every class group', () => {
    const input = baseInput({
      classGroups: [
        { classGroupId: 'cg-1', name: 'Grade 1' },
        { classGroupId: 'cg-2', name: 'Grade 2' },
      ],
      fixedBlocks: [{ label: 'Lunch', day: 1, startMin: 520, endMin: 540, scope: 'school' }],
    });
    const model = validateAndNormalize(input);
    // 520-540 = slots 8..11
    expect(grid.rangeIsFree(model.classBase[0], 0, 8, 4)).toBe(false);
    expect(grid.rangeIsFree(model.classBase[1], 0, 8, 4)).toBe(false);
    // teachers and rooms also blocked during school-wide fixed blocks
    expect(grid.rangeIsFree(model.teacherBase[0], 0, 8, 4)).toBe(false);
  });

  it('applies classGroup-scoped fixed blocks only to that group', () => {
    const input = baseInput({
      classGroups: [
        { classGroupId: 'cg-1', name: 'Grade 1' },
        { classGroupId: 'cg-2', name: 'Grade 2' },
      ],
      fixedBlocks: [
        {
          label: 'Recess',
          day: 1,
          startMin: 520,
          endMin: 540,
          scope: 'classGroup',
          classGroupId: 'cg-2',
        },
      ],
    });
    const model = validateAndNormalize(input);
    expect(grid.rangeIsFree(model.classBase[0], 0, 8, 4)).toBe(true);
    expect(grid.rangeIsFree(model.classBase[1], 0, 8, 4)).toBe(false);
  });
});

describe('startDomain', () => {
  it('marks every legal start slot for the session duration', () => {
    const model = validateAndNormalize(baseInput());
    const dom = model.sessions[0].startDomain;
    // 24 slots, 8-slot duration -> starts 0..16 legal
    for (let s = 0; s <= 16; s++) {
      expect(grid.rangeIsFree(dom, 0, s, 1)).toBe(false); // bit SET = legal
    }
    expect(grid.rangeIsFree(dom, 0, 17, 7)).toBe(true); // 17..23 not legal starts
  });

  it('excludes starts that would span a fixed block', () => {
    const input = baseInput({
      fixedBlocks: [{ label: 'Recess', day: 1, startMin: 520, endMin: 540, scope: 'school' }],
    });
    const model = validateAndNormalize(input);
    const dom = model.sessions[0].startDomain;
    // busy slots 8..11; dur 8 slots. Legal starts: 0 (0..7) and 12..16.
    expect(grid.rangeIsFree(dom, 0, 0, 1)).toBe(false); // slot 0 legal
    expect(grid.rangeIsFree(dom, 0, 1, 11)).toBe(true); // 1..11 illegal
    for (let s = 12; s <= 16; s++) {
      expect(grid.rangeIsFree(dom, 0, s, 1)).toBe(false);
    }
  });
});

describe('teacher assignment validation', () => {
  it('resolves a candidate pool to teacher indexes', () => {
    const input = baseInput({
      teachers: [
        { teacherId: 't-1', name: 'A', allowedDays: [1], excludedWindows: [] },
        { teacherId: 't-2', name: 'B', allowedDays: [1], excludedWindows: [] },
      ],
    });
    input.courses[0].teacherId = null;
    input.courses[0].teacherCandidateIds = ['t-1', 't-2'];
    const model = validateAndNormalize(input);
    expect(Array.from(model.sessions[0].teacherCands)).toEqual([0, 1]);
  });

  it('rejects a course with both teacherId and a candidate pool', () => {
    const input = baseInput();
    input.courses[0].teacherCandidateIds = ['t-1'];
    expect(() => validateAndNormalize(input)).toThrow(SolverInputError);
  });

  it('rejects a course with neither teacherId nor a candidate pool', () => {
    const input = baseInput();
    input.courses[0].teacherId = null;
    input.courses[0].teacherCandidateIds = null;
    expect(() => validateAndNormalize(input)).toThrow(SolverInputError);
  });

  it('rejects references to unknown teachers, rooms, and class groups', () => {
    const badTeacher = baseInput();
    badTeacher.courses[0].teacherId = 't-999';
    expect(() => validateAndNormalize(badTeacher)).toThrow(/t-999/);

    const badRoom = baseInput();
    badRoom.courses[0].roomId = 'r-999';
    expect(() => validateAndNormalize(badRoom)).toThrow(/r-999/);

    const badGroup = baseInput();
    badGroup.courses[0].classGroupId = 'cg-999';
    expect(() => validateAndNormalize(badGroup)).toThrow(/cg-999/);
  });
});

describe('pins', () => {
  it('attaches a resolved pin to the right session', () => {
    const input = baseInput({
      pins: [{ courseId: 'c-1', sessionIndex: 1, day: 1, startMin: 480, teacherId: 't-1', roomId: null }],
    });
    const model = validateAndNormalize(input);
    expect(model.sessions[0].pin).toBeNull();
    expect(model.sessions[1].pin).toEqual({ dayIdx: 0, slot: 0, teacherIdx: 0, roomIdx: -1 });
  });

  it('rejects a pin whose start is off the snap grid', () => {
    const input = baseInput({
      pins: [{ courseId: 'c-1', sessionIndex: 0, day: 1, startMin: 483, teacherId: 't-1', roomId: null }],
    });
    expect(() => validateAndNormalize(input)).toThrow(SolverInputError);
  });

  it('rejects a pin referencing an unknown course or out-of-range sessionIndex', () => {
    const badCourse = baseInput({
      pins: [{ courseId: 'c-999', sessionIndex: 0, day: 1, startMin: 480, teacherId: 't-1', roomId: null }],
    });
    expect(() => validateAndNormalize(badCourse)).toThrow(SolverInputError);

    const badIdx = baseInput({
      pins: [{ courseId: 'c-1', sessionIndex: 5, day: 1, startMin: 480, teacherId: 't-1', roomId: null }],
    });
    expect(() => validateAndNormalize(badIdx)).toThrow(SolverInputError);
  });
});

describe('structural validation', () => {
  it('rejects empty days and empty courses', () => {
    expect(() => validateAndNormalize(baseInput({ days: [] }))).toThrow(SolverInputError);
    expect(() => validateAndNormalize(baseInput({ courses: [] }))).toThrow(SolverInputError);
  });
});
