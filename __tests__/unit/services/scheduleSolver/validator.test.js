const { validateCandidate } = require('../../../../services/scheduleSolver/validator');

// Two days (Mon/Tue) 08:00-10:00, two teachers, one room, two class groups.
function input(overrides = {}) {
  return {
    config: { snapMinutes: 5, defaultCourseDurationMinutes: 40 },
    days: [
      { day: 1, fillableRanges: [{ startMin: 480, endMin: 600 }] },
      { day: 2, fillableRanges: [{ startMin: 480, endMin: 600 }] },
    ],
    fixedBlocks: [],
    teachers: [
      { teacherId: 't-1', name: 'Ms. X', maxMinutesPerWeek: null, allowedDays: [1, 2], excludedWindows: [] },
      { teacherId: 't-2', name: 'Mr. Y', maxMinutesPerWeek: null, allowedDays: [1, 2], excludedWindows: [] },
    ],
    rooms: [{ roomId: 'r-1', name: 'Gym' }],
    classGroups: [
      { classGroupId: 'cg-1', name: 'Grade 1' },
      { classGroupId: 'cg-2', name: 'Grade 2' },
    ],
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
        maxPerDay: 1,
      },
    ],
    pins: [],
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    courseId: 'c-1',
    sessionIndex: 0,
    classGroupId: 'cg-1',
    courseName: 'Math',
    day: 1,
    startMin: 480,
    endMin: 520,
    teacherId: 't-1',
    roomId: null,
    pinned: false,
    ...overrides,
  };
}

function goodCandidate() {
  return {
    sessions: [session(), session({ sessionIndex: 1, day: 2 })],
  };
}

function codes(violations) {
  return violations.map((v) => v.code);
}

describe('validateCandidate', () => {
  it('returns no violations for a valid candidate', () => {
    expect(validateCandidate(input(), goodCandidate())).toEqual([]);
  });

  it('detects a teacher double-booking across class groups', () => {
    const raw = input();
    raw.courses.push({
      courseId: 'c-2',
      classGroupId: 'cg-2',
      name: 'Science',
      sessionsPerWeek: 1,
      durationMinutes: 40,
      teacherId: 't-1',
      teacherCandidateIds: null,
      roomId: null,
      maxPerDay: 1,
    });
    const cand = goodCandidate();
    cand.sessions.push(
      session({ courseId: 'c-2', classGroupId: 'cg-2', courseName: 'Science', startMin: 500, endMin: 540 })
    );
    expect(codes(validateCandidate(raw, cand))).toContain('TEACHER_OVERLAP');
  });

  it('detects a room double-booking', () => {
    const raw = input();
    raw.courses[0].roomId = 'r-1';
    raw.courses.push({
      courseId: 'c-2',
      classGroupId: 'cg-2',
      name: 'Gym Class',
      sessionsPerWeek: 1,
      durationMinutes: 40,
      teacherId: 't-2',
      teacherCandidateIds: null,
      roomId: 'r-1',
      maxPerDay: 1,
    });
    const cand = {
      sessions: [
        session({ roomId: 'r-1' }),
        session({ sessionIndex: 1, day: 2, roomId: 'r-1' }),
        session({
          courseId: 'c-2',
          classGroupId: 'cg-2',
          courseName: 'Gym Class',
          teacherId: 't-2',
          roomId: 'r-1',
          startMin: 500,
          endMin: 540,
        }),
      ],
    };
    expect(codes(validateCandidate(raw, cand))).toContain('ROOM_OVERLAP');
  });

  it('detects a class group double-booking', () => {
    const raw = input();
    raw.courses.push({
      courseId: 'c-2',
      classGroupId: 'cg-1',
      name: 'English',
      sessionsPerWeek: 1,
      durationMinutes: 40,
      teacherId: 't-2',
      teacherCandidateIds: null,
      roomId: null,
      maxPerDay: 1,
    });
    const cand = goodCandidate();
    cand.sessions.push(
      session({ courseId: 'c-2', courseName: 'English', teacherId: 't-2', startMin: 510, endMin: 550 })
    );
    expect(codes(validateCandidate(raw, cand))).toContain('CLASS_OVERLAP');
  });

  it('detects a session outside fillable ranges', () => {
    const cand = goodCandidate();
    cand.sessions[0].startMin = 590;
    cand.sessions[0].endMin = 630; // ends past 600
    expect(codes(validateCandidate(input(), cand))).toContain('OUTSIDE_FILLABLE');
  });

  it('detects an intrusion into a school-wide fixed block', () => {
    const raw = input({
      fixedBlocks: [{ label: 'Assembly', day: 1, startMin: 500, endMin: 530, classGroupIds: [] }],
    });
    expect(codes(validateCandidate(raw, goodCandidate()))).toContain('FIXED_BLOCK_INTRUSION');
  });

  it("ignores a group-scoped fixed block that doesn't list the session's group", () => {
    const raw = input({
      fixedBlocks: [
        { label: 'Recess', day: 1, startMin: 500, endMin: 530, classGroupIds: ['cg-2'] },
      ],
    });
    expect(validateCandidate(raw, goodCandidate())).toEqual([]);
  });

  it('detects an intrusion into a multi-group fixed block listing the session group', () => {
    const raw = input({
      fixedBlocks: [
        { label: 'Snack 2', day: 1, startMin: 500, endMin: 530, classGroupIds: ['cg-1', 'cg-2'] },
      ],
    });
    expect(codes(validateCandidate(raw, goodCandidate()))).toContain('FIXED_BLOCK_INTRUSION');
  });

  it('detects a breach of a teacher excluded window', () => {
    const raw = input();
    raw.teachers[0].excludedWindows = [{ day: 1, startMin: 490, endMin: 510 }];
    expect(codes(validateCandidate(raw, goodCandidate()))).toContain('EXCLUSION_BREACH');
  });

  it('detects teaching on a non-allowed day', () => {
    const raw = input();
    raw.teachers[0].allowedDays = [1];
    expect(codes(validateCandidate(raw, goodCandidate()))).toContain('EXCLUSION_BREACH');
  });

  it('detects an off-snap start time', () => {
    const cand = goodCandidate();
    cand.sessions[0].startMin = 483;
    cand.sessions[0].endMin = 523;
    expect(codes(validateCandidate(input(), cand))).toContain('OFF_SNAP');
  });

  it('detects a wrong session count for a course', () => {
    const cand = { sessions: [session()] }; // course requires 2
    expect(codes(validateCandidate(input(), cand))).toContain('WRONG_SESSION_COUNT');
  });

  it('detects a wrong session duration', () => {
    const cand = goodCandidate();
    cand.sessions[0].endMin = 540; // 60 min instead of 40
    expect(codes(validateCandidate(input(), cand))).toContain('WRONG_DURATION');
  });

  it('detects a teacher over their weekly max minutes', () => {
    const raw = input();
    raw.teachers[0].maxMinutesPerWeek = 60; // needs 80
    expect(codes(validateCandidate(raw, goodCandidate()))).toContain('TEACHER_OVER_MAX');
  });

  it('detects a teacher not in the course teacher set', () => {
    const cand = goodCandidate();
    cand.sessions[0].teacherId = 't-2';
    expect(codes(validateCandidate(input(), cand))).toContain('INVALID_TEACHER');
  });

  it('accepts any pool member for a pooled course', () => {
    const raw = input();
    raw.courses[0].teacherId = null;
    raw.courses[0].teacherCandidateIds = ['t-1', 't-2'];
    const cand = goodCandidate();
    cand.sessions[0].teacherId = 't-2';
    expect(validateCandidate(raw, cand)).toEqual([]);
  });

  it('detects exceeding maxPerDay', () => {
    const cand = {
      sessions: [session(), session({ sessionIndex: 1, startMin: 540, endMin: 580 })], // both Mon
    };
    expect(codes(validateCandidate(input(), cand))).toContain('MAX_PER_DAY_EXCEEDED');
  });

  it('detects a missing daily spare (no contiguous free window on a teaching day)', () => {
    const raw = input();
    raw.teachers[0].dailySpareMinutes = 45;
    // Day 1 fillable is 480-600 (120 min). Fill 480-520 and 530-600 with
    // Ms. X's sessions: her largest free window that day is 10 minutes.
    raw.courses[0].sessionsPerWeek = 2;
    raw.courses[0].maxPerDay = 2;
    raw.courses.push({
      courseId: 'c-2',
      classGroupId: 'cg-2',
      name: 'Long Science',
      sessionsPerWeek: 1,
      durationMinutes: 70,
      teacherId: 't-1',
      teacherCandidateIds: null,
      roomId: null,
      maxPerDay: 1,
    });
    const cand = {
      sessions: [
        session(),
        session({ sessionIndex: 1, day: 2 }),
        session({
          courseId: 'c-2',
          classGroupId: 'cg-2',
          courseName: 'Long Science',
          startMin: 530,
          endMin: 600,
        }),
      ],
    };
    const violations = validateCandidate(raw, cand);
    expect(codes(violations)).toContain('SPARE_VIOLATION');
    // Day 2 has only one 40-min session -> 80-min window exists, no violation there
    expect(violations.filter((v) => v.code === 'SPARE_VIOLATION')).toHaveLength(1);
  });

  it('counts a window bounded by a group-scoped block as spare time', () => {
    const raw = input();
    raw.teachers[0].dailySpareMinutes = 45;
    // Ms. X teaches 480-520; 520-600 is free for her (80 min) -> satisfied.
    raw.courses[0].sessionsPerWeek = 1;
    const cand = { sessions: [session()] };
    expect(validateCandidate(raw, cand)).toEqual([]);
  });

  it('does NOT count school-wide blocked time toward the spare', () => {
    const raw = input({
      // 520-600 blocked school-wide: only 480-520 is schedulable on day 1.
      fixedBlocks: [{ label: 'Event', day: 1, startMin: 520, endMin: 600, classGroupIds: [] }],
    });
    raw.teachers[0].dailySpareMinutes = 45;
    raw.courses[0].sessionsPerWeek = 1;
    const cand = { sessions: [session()] }; // teaches 480-520, zero free schedulable time
    expect(codes(validateCandidate(raw, cand))).toContain('SPARE_VIOLATION');
  });

  it('detects a moved pin', () => {
    const raw = input({
      pins: [{ courseId: 'c-1', sessionIndex: 0, day: 1, startMin: 480, teacherId: 't-1', roomId: null }],
    });
    const cand = goodCandidate();
    cand.sessions[0].startMin = 485;
    cand.sessions[0].endMin = 525;
    expect(codes(validateCandidate(raw, cand))).toContain('PIN_MOVED');
  });
});
