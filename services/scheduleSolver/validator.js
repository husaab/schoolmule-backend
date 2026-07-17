// Independent candidate checker: re-derives every constraint from the RAW
// solver input using plain interval arithmetic (no bitsets, nothing shared
// with the search). Used as the test oracle and as a final safety net.

function overlaps(a, b) {
  return a.day === b.day && a.startMin < b.endMin && b.startMin < a.endMin;
}

function violation(code, message) {
  return { code, message };
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

module.exports = { validateCandidate };
