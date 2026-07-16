// Generates random solver inputs that are FEASIBLE BY CONSTRUCTION:
// build a random valid timetable first (the witness), derive the course
// requirements and teacher constraints from it, then discard the witness.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

const SNAP = 5;
const DAY_START = 480; // 08:00
const DAY_END = 840; // 14:00
const LUNCH = { startMin: 630, endMin: 660 };
const DURATIONS = [30, 40, 45, 60];

function overlapsInterval(list, day, startMin, endMin) {
  return list.some((x) => x.day === day && startMin < x.endMin && x.startMin < endMin);
}

function randomSchool(seed) {
  const rng = mulberry32(seed);
  const numDays = randInt(rng, 3, 5);
  const numTeachers = randInt(rng, 5, 12);
  const numGroups = randInt(rng, 3, 8);
  const numRooms = randInt(rng, 1, 3);

  const days = [];
  for (let d = 1; d <= numDays; d++) {
    days.push({ day: d, fillableRanges: [{ startMin: DAY_START, endMin: DAY_END }] });
  }
  const fixedBlocks = days.map((d) => ({
    label: 'Lunch',
    day: d.day,
    startMin: LUNCH.startMin,
    endMin: LUNCH.endMin,
    scope: 'school',
  }));

  const teachers = [];
  for (let t = 0; t < numTeachers; t++) {
    teachers.push({
      teacherId: `t-${t}`,
      name: `Teacher ${t}`,
      fullTime: true,
      maxMinutesPerWeek: null, // tightened after witness construction
      allowedDays: days.map((d) => d.day),
      excludedWindows: [],
    });
  }
  const rooms = [];
  for (let r = 0; r < numRooms; r++) {
    rooms.push({ roomId: `r-${r}`, name: `Room ${r}` });
  }
  const classGroups = [];
  for (let g = 0; g < numGroups; g++) {
    classGroups.push({ classGroupId: `cg-${g}`, name: `Grade ${g + 1}` });
  }

  // --- Build the witness timetable ---
  const teacherBusy = teachers.map(() => []); // intervals {day, startMin, endMin}
  const roomBusy = rooms.map(() => []);
  const teacherUsed = teachers.map(() => 0);
  const witness = []; // {group, day, startMin, endMin, teacherIdx, roomIdx}

  for (let g = 0; g < numGroups; g++) {
    for (const d of days) {
      let cursor = DAY_START;
      while (cursor < DAY_END - 30) {
        if (cursor < LUNCH.endMin && cursor + 30 > LUNCH.startMin) {
          cursor = LUNCH.endMin; // skip over lunch
          continue;
        }
        if (rng() < 0.25) {
          cursor += SNAP * randInt(rng, 1, 4); // leave a gap
          continue;
        }
        const dur = pick(rng, DURATIONS);
        const endMin = cursor + dur;
        if (endMin > DAY_END || (cursor < LUNCH.endMin && endMin > LUNCH.startMin)) {
          cursor += SNAP;
          continue;
        }
        const freeTeachers = teachers
          .map((_, t) => t)
          .filter((t) => !overlapsInterval(teacherBusy[t], d.day, cursor, endMin));
        if (freeTeachers.length === 0) {
          cursor += SNAP;
          continue;
        }
        const teacherIdx = pick(rng, freeTeachers);
        let roomIdx = -1;
        if (rng() < 0.15) {
          const freeRooms = rooms
            .map((_, r) => r)
            .filter((r) => !overlapsInterval(roomBusy[r], d.day, cursor, endMin));
          if (freeRooms.length > 0) roomIdx = pick(rng, freeRooms);
        }
        witness.push({ group: g, day: d.day, startMin: cursor, endMin, teacherIdx, roomIdx });
        teacherBusy[teacherIdx].push({ day: d.day, startMin: cursor, endMin });
        teacherUsed[teacherIdx] += dur;
        if (roomIdx >= 0) roomBusy[roomIdx].push({ day: d.day, startMin: cursor, endMin });
        cursor = endMin;
      }
    }
  }

  // --- Derive courses from the witness: identity = (group, teacher, duration, room) ---
  const courseMap = new Map();
  for (const s of witness) {
    const dur = s.endMin - s.startMin;
    const key = `${s.group}:${s.teacherIdx}:${dur}:${s.roomIdx}`;
    if (!courseMap.has(key)) {
      courseMap.set(key, { group: s.group, teacherIdx: s.teacherIdx, dur, roomIdx: s.roomIdx, sessions: [] });
    }
    courseMap.get(key).sessions.push(s);
  }
  const courses = [];
  let courseNum = 0;
  const pinsPool = [];
  for (const c of courseMap.values()) {
    const perDay = new Map();
    for (const s of c.sessions) perDay.set(s.day, (perDay.get(s.day) || 0) + 1);
    const courseId = `c-${courseNum}`;
    const usePool = rng() < 0.1;
    courses.push({
      courseId,
      classGroupId: `cg-${c.group}`,
      name: `Course ${courseNum}`,
      sessionsPerWeek: c.sessions.length,
      durationMinutes: c.dur,
      teacherId: usePool ? null : `t-${c.teacherIdx}`,
      teacherCandidateIds: usePool ? [`t-${c.teacherIdx}`, pick(rng, teachers).teacherId] : null,
      roomId: c.roomIdx >= 0 ? `r-${c.roomIdx}` : null,
      maxPerDay: Math.max(...perDay.values()),
    });
    if (!usePool) {
      pinsPool.push({
        courseId,
        sessionIndex: 0,
        day: c.sessions[0].day,
        startMin: c.sessions[0].startMin,
        teacherId: `t-${c.teacherIdx}`,
        roomId: c.roomIdx >= 0 ? `r-${c.roomIdx}` : null,
      });
    }
    courseNum++;
  }

  // Tighten teachers using the witness as proof of feasibility.
  teachers.forEach((t, idx) => {
    if (rng() < 0.5 && teacherUsed[idx] > 0) {
      t.maxMinutesPerWeek = teacherUsed[idx] + SNAP * randInt(rng, 0, 12);
    }
    // Exclude a window carved from time this teacher never uses.
    if (rng() < 0.4) {
      const d = pick(rng, days).day;
      const winStart = DAY_START + SNAP * randInt(rng, 0, 20);
      const winEnd = winStart + SNAP * randInt(rng, 2, 6);
      if (!overlapsInterval(teacherBusy[idx], d, winStart, winEnd)) {
        t.excludedWindows.push({ day: d, startMin: winStart, endMin: Math.min(winEnd, DAY_END) });
      }
    }
  });

  // Pin a couple of witness sessions (guaranteed feasible).
  const pins = [];
  if (pinsPool.length > 0 && rng() < 0.7) {
    pins.push(pick(rng, pinsPool));
  }

  return {
    config: {
      snapMinutes: SNAP,
      defaultCourseDurationMinutes: 40,
      seed,
      candidateCount: 3,
      // Generous: most seeds solve in <100ms; the budget only matters for the
      // few hard seeds, and test environments run 2-3x slower than plain node.
      timeBudgetMs: 8000,
    },
    days,
    fixedBlocks,
    teachers,
    rooms,
    classGroups,
    courses,
    pins,
  };
}

module.exports = { randomSchool };
