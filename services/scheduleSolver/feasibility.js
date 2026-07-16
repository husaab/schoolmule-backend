// Cheap arithmetic feasibility checks run before search. Every check runs
// (not fail-fast) so the UI can show a complete punch list. Ratios above
// TIGHT_RATIO that are not outright errors become non-blocking warnings.

const grid = require('./timeGrid');
const { CODES, hours, diag } = require('./diagnostics');

const TIGHT_RATIO = 0.9;

function freeMinutes(model, occ) {
  let slots = 0;
  for (let d = 0; d < model.numDays; d++) {
    slots += grid.countFreeSlots(occ, d * model.W, model.slotsPerDay[d]);
  }
  return slots * model.config.snap;
}

function legalStartsPerDay(model, dom) {
  const perDay = [];
  for (let d = 0; d < model.numDays; d++) {
    perDay.push(model.slotsPerDay[d] - grid.countFreeSlots(dom, d * model.W, model.slotsPerDay[d]));
  }
  return perDay;
}

function courseMinutes(course) {
  return course.sessionsPerWeek * course.durMin;
}

function preSolveCheck(model) {
  const errors = [];
  const warnings = [];

  const ratioCheck = (code, ratio, tightMessage) => {
    if (ratio > TIGHT_RATIO && ratio <= 1) {
      warnings.push(diag(`${code}_TIGHT`, tightMessage));
    }
  };

  const teacherFree = model.teachers.map((_, t) => freeMinutes(model, model.teacherBase[t]));
  const teacherCap = model.teachers.map((teacher, t) => Math.min(teacherFree[t], teacher.maxMin));

  // Per-teacher pre-assigned load vs max hours and vs actual availability.
  const assignedMin = model.teachers.map(() => 0);
  for (const course of model.courses) {
    if (course.teacherCands.length === 1) {
      assignedMin[course.teacherCands[0]] += courseMinutes(course);
    }
  }
  model.teachers.forEach((teacher, t) => {
    if (assignedMin[t] > teacher.maxMin) {
      errors.push(
        diag(
          CODES.TEACHER_OVER_MAX_HOURS,
          `${teacher.name} is assigned ${hours(assignedMin[t])}/week of classes but their weekly maximum is ${hours(teacher.maxMin)}.`,
          { teacherId: teacher.id, assignedMin: assignedMin[t], maxMin: teacher.maxMin }
        )
      );
    } else if (Number.isFinite(teacher.maxMin)) {
      ratioCheck(
        CODES.TEACHER_OVER_MAX_HOURS,
        assignedMin[t] / teacher.maxMin,
        `${teacher.name} is assigned ${hours(assignedMin[t])} of their ${hours(teacher.maxMin)} weekly maximum.`
      );
    }
    if (assignedMin[t] > teacherFree[t]) {
      errors.push(
        diag(
          CODES.TEACHER_INSUFFICIENT_AVAILABILITY,
          `${teacher.name} needs ${hours(assignedMin[t])} of teaching time but is only available ${hours(teacherFree[t])} after their excluded times and days off.`,
          { teacherId: teacher.id, assignedMin: assignedMin[t], freeMin: teacherFree[t] }
        )
      );
    } else if (teacherFree[t] > 0) {
      ratioCheck(
        CODES.TEACHER_INSUFFICIENT_AVAILABILITY,
        assignedMin[t] / teacherFree[t],
        `${teacher.name}'s schedule is nearly full: ${hours(assignedMin[t])} assigned of ${hours(teacherFree[t])} available.`
      );
    }
  });

  // Class-group demand vs fillable time.
  model.classGroups.forEach((group, g) => {
    const need = model.courses
      .filter((c) => c.classIdx === g)
      .reduce((sum, c) => sum + courseMinutes(c), 0);
    const free = freeMinutes(model, model.classBase[g]);
    if (need > free) {
      errors.push(
        diag(
          CODES.CLASS_GROUP_OVERFLOW,
          `${group.name} needs ${need} min/week of classes but its timetable only has ${free} fillable minutes.`,
          { classGroupId: group.id, needMin: need, freeMin: free }
        )
      );
    } else if (free > 0) {
      ratioCheck(
        CODES.CLASS_GROUP_OVERFLOW,
        need / free,
        `${group.name}'s timetable is nearly full: ${need} of ${free} fillable minutes used.`
      );
    }
  });

  // Room demand vs open time.
  model.rooms.forEach((room, r) => {
    const need = model.courses
      .filter((c) => c.roomIdx === r)
      .reduce((sum, c) => sum + courseMinutes(c), 0);
    const free = freeMinutes(model, model.roomBase[r]);
    if (need > free) {
      errors.push(
        diag(
          CODES.ROOM_OVERBOOKED,
          `${room.name} is required for ${need} min/week but is only open ${free} min/week.`,
          { roomId: room.id, needMin: need, freeMin: free }
        )
      );
    } else if (free > 0) {
      ratioCheck(
        CODES.ROOM_OVERBOOKED,
        need / free,
        `${room.name} is nearly fully booked: ${need} of ${free} open minutes required.`
      );
    }
  });

  // Per-course placement structure.
  model.courses.forEach((course, courseIdx) => {
    const dom = model.sessions.find((s) => s.courseIdx === courseIdx).startDomain;
    const perDay = legalStartsPerDay(model, dom);
    const totalLegal = perDay.reduce((a, b) => a + b, 0);
    const group = model.classGroups[course.classIdx];

    if (totalLegal === 0) {
      errors.push(
        diag(
          CODES.SESSION_DOES_NOT_FIT,
          `${course.name} (${course.durMin} min) for ${group.name} doesn't fit inside any of ${group.name}'s daily time windows.`,
          { courseId: course.id, durMin: course.durMin }
        )
      );
      return; // downstream checks for this course are meaningless
    }

    // Some teacher in the candidate set must align with some legal start.
    let teacherAligned = false;
    outer: for (const t of course.teacherCands) {
      for (let d = 0; d < model.numDays; d++) {
        const last = model.slotsPerDay[d] - course.durSlots;
        for (let s = 0; s <= last; s++) {
          if (!grid.rangeIsFree(dom, d * model.W, s, 1)) {
            // bit set = legal start
            if (grid.rangeIsFree(model.teacherBase[t], d * model.W, s, course.durSlots)) {
              teacherAligned = true;
              break outer;
            }
          }
        }
      }
    }
    if (!teacherAligned) {
      errors.push(
        diag(
          CODES.NO_TEACHER_AVAILABLE,
          `No teacher can take ${course.name} (${group.name}): all ${course.teacherCands.length} candidate(s) are excluded or off during ${group.name}'s open times.`,
          { courseId: course.id }
        )
      );
    }

    const daysWithLegal = perDay.filter((n) => n > 0).length;
    if (course.sessionsPerWeek > course.maxPerDay * daysWithLegal) {
      errors.push(
        diag(
          CODES.SESSIONS_EXCEED_DAYS,
          `${course.name} (${group.name}) has ${course.sessionsPerWeek} sessions/week at max ${course.maxPerDay}/day, but only ${daysWithLegal} day(s) can host it.`,
          { courseId: course.id, daysWithLegal }
        )
      );
    }
  });

  // Pins: blocked slots and pairwise resource clashes.
  const pinned = model.sessions.filter((s) => s.pin);
  for (const s of pinned) {
    const { dayIdx, slot, teacherIdx, roomIdx } = s.pin;
    const course = model.courses[s.courseIdx];
    const off = dayIdx * model.W;
    const legal = !grid.rangeIsFree(s.startDomain, off, slot, 1);
    const teacherOk =
      course.teacherCands.includes(teacherIdx) &&
      grid.rangeIsFree(model.teacherBase[teacherIdx], off, slot, s.durSlots);
    const roomOk = roomIdx < 0 || grid.rangeIsFree(model.roomBase[roomIdx], off, slot, s.durSlots);
    if (!legal || !teacherOk || !roomOk) {
      errors.push(
        diag(
          CODES.PIN_CONFLICT,
          `Pinned ${course.name} (${model.classGroups[s.classIdx].name}, day ${model.days[dayIdx]}) lands on a blocked or unavailable time.`,
          { courseId: course.id, sessionIndex: s.sessionIndex }
        )
      );
    }
  }
  for (let i = 0; i < pinned.length; i++) {
    for (let j = i + 1; j < pinned.length; j++) {
      const a = pinned[i];
      const b = pinned[j];
      if (a.pin.dayIdx !== b.pin.dayIdx) continue;
      const overlap = a.pin.slot < b.pin.slot + b.durSlots && b.pin.slot < a.pin.slot + a.durSlots;
      if (!overlap) continue;
      const sharedTeacher = a.pin.teacherIdx === b.pin.teacherIdx;
      const sharedRoom = a.pin.roomIdx >= 0 && a.pin.roomIdx === b.pin.roomIdx;
      const sharedClass = a.classIdx === b.classIdx;
      if (sharedTeacher || sharedRoom || sharedClass) {
        const nameA = model.courses[a.courseIdx].name;
        const nameB = model.courses[b.courseIdx].name;
        const what = sharedTeacher
          ? `both use ${model.teachers[a.pin.teacherIdx].name}`
          : sharedRoom
            ? `both use ${model.rooms[a.pin.roomIdx].name}`
            : `both belong to ${model.classGroups[a.classIdx].name}`;
        errors.push(
          diag(CODES.PIN_CONFLICT, `Pinned ${nameA} overlaps pinned ${nameB} — ${what}.`, {
            courseIds: [model.courses[a.courseIdx].id, model.courses[b.courseIdx].id],
          })
        );
      }
    }
  }

  // Hall-style lower bound on candidate pools that actually occur (size > 1).
  const pools = new Map();
  for (const course of model.courses) {
    if (course.teacherCands.length > 1) {
      const key = Array.from(course.teacherCands).sort((a, b) => a - b).join(',');
      if (!pools.has(key)) pools.set(key, Array.from(course.teacherCands));
    }
  }
  for (const pool of pools.values()) {
    const poolSet = new Set(pool);
    const demand = model.courses
      .filter((c) => Array.from(c.teacherCands).every((t) => poolSet.has(t)))
      .reduce((sum, c) => sum + courseMinutes(c), 0);
    const capacity = pool.reduce((sum, t) => sum + teacherCap[t], 0);
    if (demand > capacity) {
      const names = pool.map((t) => model.teachers[t].name).join(' + ');
      errors.push(
        diag(
          CODES.POOL_CAPACITY_SHORT,
          `Teachers ${names} together have ${hours(capacity)} free but their courses need ${hours(demand)}.`,
          { teacherIds: pool.map((t) => model.teachers[t].id), demandMin: demand, capacityMin: capacity }
        )
      );
    }
  }

  // Whole-school capacity.
  const totalDemand = model.courses.reduce((sum, c) => sum + courseMinutes(c), 0);
  const totalCap = teacherCap.reduce((a, b) => a + b, 0);
  if (totalDemand > totalCap) {
    errors.push(
      diag(
        CODES.TOTAL_TEACHER_CAPACITY,
        `All courses total ${hours(totalDemand)}/week but teachers have only ${hours(totalCap)} of capacity.`,
        { demandMin: totalDemand, capacityMin: totalCap }
      )
    );
  } else if (totalCap > 0) {
    ratioCheck(
      CODES.TOTAL_TEACHER_CAPACITY,
      totalDemand / totalCap,
      `Teacher capacity is nearly exhausted: ${hours(totalDemand)} required of ${hours(totalCap)} available.`
    );
  }

  return { feasible: errors.length === 0, errors, warnings };
}

module.exports = { preSolveCheck };
