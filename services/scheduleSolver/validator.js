// Independent candidate checker: re-derives every constraint from the RAW
// solver input using plain interval arithmetic (no bitsets, nothing shared
// with the search). Used as the test oracle and as a final safety net.

function overlaps(a, b) {
  return a.day === b.day && a.startMin < b.endMin && b.startMin < a.endMin;
}

function violation(code, message) {
  return { code, message };
}

function overlapTotal(intervals, from, to) {
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cursor = from;
  for (const [a, b] of clipped) {
    if (b > cursor) {
      total += b - Math.max(a, cursor);
      cursor = Math.max(cursor, b);
    }
  }
  return total;
}

// Spares are counted in PERIOD SLOTS, not minutes. A school day is a fixed
// number of teaching periods; a spare is a period in which the teacher has no
// class. Lunch, snack and prayer sit between periods and are never spares --
// supervising your class at lunch is work, not free time.
//
// Every empty period counts, including a free first or last one: a teacher whose
// first class is at 9:55 has a spare at 8:55. `lateStartExempt` waives that for
// teachers whose hours genuinely begin later.
//
// A period is unavailable to a teacher (so neither taught nor spare) when her own
// excluded windows cover it in every class group's variant of that period.
// Exported so the JS solver can reject candidates the validator would reject.
function periodGridByDay(rawInput) {
  const snap = rawInput.config?.snapMinutes ?? 5;
  const defaultDur = rawInput.config?.defaultCourseDurationMinutes ?? 40;
  const grids = new Map(); // day -> Map(classGroupId -> [ {startMin,endMin} ])
  for (const day of rawInput.days) {
    const perGroup = new Map();
    for (const group of rawInput.classGroups) {
      const blocks = (rawInput.fixedBlocks || []).filter(
        (b) =>
          b.day === day.day &&
          (!Array.isArray(b.classGroupIds) ||
            b.classGroupIds.length === 0 ||
            b.classGroupIds.includes(group.classGroupId))
      );
      const slots = [];
      for (const range of day.fillableRanges) {
        let cursor = Math.ceil(range.startMin / snap) * snap;
        while (cursor + defaultDur <= range.endMin) {
          const end = cursor + defaultDur;
          const clash = blocks.some((b) => cursor < b.endMin && b.startMin < end);
          if (!clash) {
            slots.push({ startMin: cursor, endMin: end });
            cursor = end;                     // greedy: take it, move past it
          } else {
            cursor += snap;
          }
        }
      }
      perGroup.set(group.classGroupId, slots);
    }
    grids.set(day.day, perGroup);
  }
  return grids;
}

function spareCapViolations(rawInput, sessions) {
  const out = [];
  const grids = periodGridByDay(rawInput);

  for (const teacher of rawInput.teachers) {
    const rawCap = teacher.maxSparesPerDay;
    const rawMin = teacher.minSparesPerDay;
    const hasCap = Number.isInteger(rawCap) && rawCap >= 0;
    const hasMin = Number.isInteger(rawMin) && rawMin > 0;
    if (!hasCap && !hasMin) continue;
    const cap = hasCap ? rawCap : Number.POSITIVE_INFINITY;
    const min = hasMin ? rawMin : 0;

    const own = sessions.filter((s) => s.teacherId === teacher.teacherId);
    for (const dayIso of [...new Set(own.map((s) => s.day))]) {
      const daySessions = own.filter((s) => s.day === dayIso);
      const perGroup = grids.get(dayIso);
      if (!perGroup) continue;
      // Reference grid = the fullest day any group has. Taking an arbitrary
      // group's would let a short-day group (JK/SK, open only a period or two)
      // collapse every teacher's period count and silently disable the rule.
      let slots = [];
      for (const v of perGroup.values()) if (v.length > slots.length) slots = v;

      // A period is available unless her exclusions cover it in EVERY group's
      // variant of that period (different grades break at different times).
      const exclusions = (teacher.excludedWindows || []).filter((w) => w.day === dayIso);
      let available = 0;
      for (let i = 0; i < slots.length; i++) {
        const variants = [...perGroup.values()].map((v) => v[i]).filter(Boolean);
        const usable = variants.some(
          (v) => !exclusions.some((w) => v.startMin < w.endMin && w.startMin < v.endMin)
        );
        if (usable) available++;
      }

      let taught = daySessions.length;
      if (teacher.lateStartExempt) {
        // Periods before her first class are hers, so drop them from the count.
        const firstStart = Math.min(...daySessions.map((s) => s.startMin));
        const before = slots.filter((v) => v.endMin <= firstStart).length;
        available -= before;
      }
      const spares = Math.max(0, available - taught);

      if (spares > cap) {
        out.push(
          violation(
            'SPARE_CAP_VIOLATION',
            `${teacher.name} has ${spares} free period(s) on day ${dayIso} (teaches ${taught} of ${available}); the limit is ${cap}.`
          )
        );
      } else if (spares < min) {
        out.push(
          violation(
            'SPARE_MIN_VIOLATION',
            `${teacher.name} has only ${spares} free period(s) on day ${dayIso} (teaches ${taught} of ${available}); at least ${min} required.`
          )
        );
      }
    }
  }
  return out;
}

// maxRepeatDays caps how many DAYS may hold a repeat, where maxPerDay caps how
// many sessions land on one day. A course of 5 sessions whose teacher works only
// 4 days must double up somewhere; this is what stops it doubling up on two
// separate days instead of concentrating the repeat on one.
// Exported so the JS solver can reject candidates the validator would reject.
function repeatDayViolations(rawInput, sessions) {
  const out = [];
  for (const course of rawInput.courses || []) {
    const cap = course.maxRepeatDays;
    if (!Number.isInteger(cap) || cap < 0) continue;
    const byDay = new Map();
    for (const s of sessions) {
      if (s.courseId !== course.courseId) continue;
      byDay.set(s.day, (byDay.get(s.day) || 0) + 1);
    }
    const repeatDays = [...byDay.entries()].filter(([, count]) => count >= 2);
    if (repeatDays.length > cap) {
      out.push(
        violation(
          'MAX_REPEAT_DAYS_EXCEEDED',
          `"${course.name}" repeats on ${repeatDays.length} day(s) (${repeatDays
            .map(([day, count]) => `day ${day}: ${count}`)
            .join(', ')}); at most ${cap} day(s) may hold a repeat.`
        )
      );
    }
  }
  return out;
}

function validateCandidate(rawInput, candidate) {
  const violations = [];
  const snap = rawInput.config?.snapMinutes ?? 5;
  const defaultDur = rawInput.config?.defaultCourseDurationMinutes ?? 40;
  const sessions = candidate.sessions || [];

  const courseById = new Map(rawInput.courses.map((c) => [c.courseId, c]));
  const teacherById = new Map(rawInput.teachers.map((t) => [t.teacherId, t]));
  const daysByIso = new Map(rawInput.days.map((d) => [d.day, d]));

  // Pairwise resource conflicts.
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i];
      const b = sessions[j];
      if (!overlaps(a, b)) continue;
      if (a.teacherId && a.teacherId === b.teacherId) {
        violations.push(
          violation(
            'TEACHER_OVERLAP',
            `${a.teacherId} is double-booked on day ${a.day}: "${a.courseName}" and "${b.courseName}" overlap.`
          )
        );
      }
      if (a.roomId && a.roomId === b.roomId) {
        violations.push(
          violation(
            'ROOM_OVERLAP',
            `Room ${a.roomId} is double-booked on day ${a.day}: "${a.courseName}" and "${b.courseName}" overlap.`
          )
        );
      }
      if (a.classGroupId === b.classGroupId) {
        violations.push(
          violation(
            'CLASS_OVERLAP',
            `Class group ${a.classGroupId} is double-booked on day ${a.day}: "${a.courseName}" and "${b.courseName}" overlap.`
          )
        );
      }
    }
  }

  for (const s of sessions) {
    const course = courseById.get(s.courseId);
    if (!course) {
      violations.push(violation('UNKNOWN_COURSE', `Session references unknown course "${s.courseId}".`));
      continue;
    }

    if (s.startMin % snap !== 0) {
      violations.push(
        violation('OFF_SNAP', `"${s.courseName}" starts at minute ${s.startMin}, off the ${snap}-minute grid.`)
      );
    }

    const expectedDur = course.durationMinutes ?? defaultDur;
    if (s.endMin - s.startMin !== expectedDur) {
      violations.push(
        violation(
          'WRONG_DURATION',
          `"${s.courseName}" runs ${s.endMin - s.startMin} min but should run ${expectedDur} min.`
        )
      );
    }

    const day = daysByIso.get(s.day);
    const insideFillable =
      day && day.fillableRanges.some((r) => s.startMin >= r.startMin && s.endMin <= r.endMin);
    if (!insideFillable) {
      violations.push(
        violation(
          'OUTSIDE_FILLABLE',
          `"${s.courseName}" (day ${s.day} ${s.startMin}-${s.endMin}) is outside the fillable time ranges.`
        )
      );
    }

    for (const block of rawInput.fixedBlocks || []) {
      const groupIds = Array.isArray(block.classGroupIds) ? block.classGroupIds : [];
      const applies = groupIds.length === 0 || groupIds.includes(s.classGroupId);
      if (applies && overlaps(s, { day: block.day, startMin: block.startMin, endMin: block.endMin })) {
        violations.push(
          violation(
            'FIXED_BLOCK_INTRUSION',
            `"${s.courseName}" overlaps the fixed block "${block.label}" on day ${s.day}.`
          )
        );
      }
    }

    const allowedTeachers = course.teacherId ? [course.teacherId] : course.teacherCandidateIds || [];
    if (!allowedTeachers.includes(s.teacherId)) {
      violations.push(
        violation('INVALID_TEACHER', `"${s.courseName}" is taught by ${s.teacherId}, who is not assigned or in the pool.`)
      );
    }

    const teacher = teacherById.get(s.teacherId);
    if (teacher) {
      const allowedDays = teacher.allowedDays || [1, 2, 3, 4, 5, 6, 7];
      if (!allowedDays.includes(s.day)) {
        violations.push(
          violation('EXCLUSION_BREACH', `${teacher.name} teaches "${s.courseName}" on day ${s.day}, not an allowed day.`)
        );
      }
      for (const win of teacher.excludedWindows || []) {
        if (overlaps(s, { day: win.day, startMin: win.startMin, endMin: win.endMin })) {
          violations.push(
            violation('EXCLUSION_BREACH', `"${s.courseName}" overlaps ${teacher.name}'s excluded time on day ${s.day}.`)
          );
        }
      }
    }
  }

  // Per-course session counts and maxPerDay.
  for (const course of rawInput.courses) {
    const own = sessions.filter((s) => s.courseId === course.courseId);
    if (own.length !== course.sessionsPerWeek) {
      violations.push(
        violation(
          'WRONG_SESSION_COUNT',
          `"${course.name}" has ${own.length} scheduled sessions but requires ${course.sessionsPerWeek}.`
        )
      );
    }
    const maxPerDay = course.maxPerDay == null ? 1 : course.maxPerDay;
    const byDay = new Map();
    for (const s of own) byDay.set(s.day, (byDay.get(s.day) || 0) + 1);
    for (const [day, count] of byDay) {
      if (count > maxPerDay) {
        violations.push(
          violation('MAX_PER_DAY_EXCEEDED', `"${course.name}" has ${count} sessions on day ${day} (max ${maxPerDay}).`)
        );
      }
    }
  }

  // Teacher weekly max minutes.
  for (const teacher of rawInput.teachers) {
    if (!Number.isFinite(teacher.maxMinutesPerWeek)) continue;
    const total = sessions
      .filter((s) => s.teacherId === teacher.teacherId)
      .reduce((sum, s) => sum + (s.endMin - s.startMin), 0);
    if (total > teacher.maxMinutesPerWeek) {
      violations.push(
        violation(
          'TEACHER_OVER_MAX',
          `${teacher.name} is scheduled ${total} min/week, over their ${teacher.maxMinutesPerWeek} min maximum.`
        )
      );
    }
  }

  // Daily spare: on every day a teacher teaches, one contiguous free window
  // of >= dailySpareMinutes must remain within SCHEDULABLE time (fillable
  // ranges minus school-wide blocks, their exclusions, and their sessions —
  // group-scoped blocks still count as spare time since the teacher could
  // have been teaching another group then).
  for (const teacher of rawInput.teachers) {
    const spare = teacher.dailySpareMinutes;
    if (!Number.isFinite(spare) || spare <= 0) continue;
    const own = sessions.filter((s) => s.teacherId === teacher.teacherId);
    const teachingDays = [...new Set(own.map((s) => s.day))];
    for (const dayIso of teachingDays) {
      const day = daysByIso.get(dayIso);
      if (!day) continue;
      const busy = [
        ...own.filter((s) => s.day === dayIso).map((s) => [s.startMin, s.endMin]),
        ...(teacher.excludedWindows || [])
          .filter((w) => w.day === dayIso)
          .map((w) => [w.startMin, w.endMin]),
        ...(rawInput.fixedBlocks || [])
          .filter(
            (b) =>
              b.day === dayIso &&
              (!Array.isArray(b.classGroupIds) || b.classGroupIds.length === 0)
          )
          .map((b) => [b.startMin, b.endMin]),
      ];
      let maxRun = 0;
      for (const range of day.fillableRanges) {
        // Walk the range and measure the longest stretch not covered by busy.
        let cursor = range.startMin;
        const inRange = busy
          .map(([from, to]) => [Math.max(from, range.startMin), Math.min(to, range.endMin)])
          .filter(([from, to]) => to > from)
          .sort((a, b) => a[0] - b[0]);
        for (const [from, to] of inRange) {
          if (from > cursor) maxRun = Math.max(maxRun, from - cursor);
          cursor = Math.max(cursor, to);
        }
        if (range.endMin > cursor) maxRun = Math.max(maxRun, range.endMin - cursor);
      }
      if (maxRun < spare) {
        violations.push(
          violation(
            'SPARE_VIOLATION',
            `${teacher.name} has no free ${spare}-minute spare on day ${dayIso} (largest free window: ${maxRun} min).`
          )
        );
      }
    }
  }

  // Period rules: teach ("class's window sessions belong to teacher T on
  // >= N days") and free ("teacher keeps >= N period-slots free in window").
  for (const rule of rawInput.periodRules || []) {
    if (rule.kind === 'teach') {
      let qualifying = 0;
      for (const dayDef of rawInput.days) {
        const inWindow = sessions.filter(
          (s) =>
            s.classGroupId === rule.classGroupId &&
            s.day === dayDef.day &&
            s.startMin < rule.endMin &&
            rule.startMin < s.endMin
        );
        if (inWindow.some((s) => s.teacherId === rule.teacherId)) {
          qualifying++;
        }
      }
      if (qualifying < rule.minPerWeek) {
        const teacher = teacherById.get(rule.teacherId);
        violations.push(
          violation(
            'PERIOD_RULE_VIOLATION',
            `${teacher?.name || rule.teacherId} teaches the ${rule.startMin}-${rule.endMin} window of class ${rule.classGroupId} on only ${qualifying} day(s); the rule requires ${rule.minPerWeek}.`
          )
        );
      }
    } else {
      const teacher = teacherById.get(rule.teacherId);
      const allowedDays = teacher?.allowedDays || [1, 2, 3, 4, 5, 6, 7];
      let freeMin = 0;
      for (const dayDef of rawInput.days) {
        if (!allowedDays.includes(dayDef.day)) continue;
        const busy = [
          ...sessions
            .filter((s) => s.teacherId === rule.teacherId && s.day === dayDef.day)
            .map((s) => [s.startMin, s.endMin]),
          ...(teacher?.excludedWindows || [])
            .filter((w) => w.day === dayDef.day)
            .map((w) => [w.startMin, w.endMin]),
          ...(rawInput.fixedBlocks || [])
            .filter(
              (b) =>
                b.day === dayDef.day &&
                (!Array.isArray(b.classGroupIds) || b.classGroupIds.length === 0)
            )
            .map((b) => [b.startMin, b.endMin]),
        ];
        for (const range of dayDef.fillableRanges) {
          const from = Math.max(range.startMin, rule.startMin);
          const to = Math.min(range.endMin, rule.endMin);
          if (to <= from) continue;
          freeMin += to - from - overlapTotal(busy, from, to);
        }
      }
      const required = rule.minPerWeek * defaultDur;
      if (freeMin < required) {
        violations.push(
          violation(
            'PERIOD_RULE_VIOLATION',
            `${teacher?.name || rule.teacherId} has only ${freeMin} free minutes in the ${rule.startMin}-${rule.endMin} window this week; the rule requires ${required} (${rule.minPerWeek} x ${defaultDur} min).`
          )
        );
      }
    }
  }

  violations.push(...spareCapViolations(rawInput, sessions));
  violations.push(...repeatDayViolations(rawInput, sessions));

  // Max distinct working days per week.
  for (const teacher of rawInput.teachers) {
    if (!Number.isInteger(teacher.maxDaysPerWeek) || teacher.maxDaysPerWeek < 1) continue;
    const daysUsed = new Set(
      sessions.filter((s) => s.teacherId === teacher.teacherId).map((s) => s.day)
    );
    if (daysUsed.size > teacher.maxDaysPerWeek) {
      violations.push(
        violation(
          'MAX_DAYS_EXCEEDED',
          `${teacher.name} teaches on ${daysUsed.size} days but is capped at ${teacher.maxDaysPerWeek}.`
        )
      );
    }
  }

  // Pins must be honored verbatim.
  for (const pin of rawInput.pins || []) {
    const match = sessions.find(
      (s) =>
        s.courseId === pin.courseId &&
        s.day === pin.day &&
        s.startMin === pin.startMin &&
        s.teacherId === pin.teacherId
    );
    if (!match) {
      violations.push(
        violation(
          'PIN_MOVED',
          `Pinned session of course "${pin.courseId}" (day ${pin.day}, minute ${pin.startMin}) is not in the schedule.`
        )
      );
    }
  }

  return violations;
}

module.exports = { validateCandidate, spareCapViolations, repeatDayViolations };
