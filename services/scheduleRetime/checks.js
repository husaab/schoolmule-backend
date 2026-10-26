// Problems a set of bell times can cause: double-booked teachers, classes or
// rooms, classes running into a break, classes outside school hours, and
// classes outside a teacher's set availability. Warnings, never blockers —
// the timetable builder works the same way.
//
// Every problem has a key built from session identity (course + index), not
// times, so the problems a schedule already had can be told apart from the
// ones new times create.

const { dayName, timeRange } = require('./format');
const { overlaps } = require('./model');

const sessionKey = (s, i) => (s.courseId != null ? `${s.courseId}:${s.sessionIndex}` : `#${i}`);

function findProblems({ sessions, fixedBlocks, dayTemplates }, lookups) {
  const { teacherById, groupNameById, roomNameById } = lookups;
  const out = [];
  const what = (s) => `${groupNameById.get(s.classGroupId) || 'A class'} ${s.courseName || ''}`.trim();
  const when = (s) => `${dayName(s.day)} ${timeRange(s.startMin, s.endMin)}`;
  const add = (code, keyParts, s, message) =>
    out.push({ key: [code, ...keyParts].join('|'), code, dayOfWeek: s.day, message });

  const keyed = sessions.map((s, i) => ({ s, k: sessionKey(s, i) }));
  const byDay = new Map();
  for (const item of keyed) {
    if (!byDay.has(item.s.day)) byDay.set(item.s.day, []);
    byDay.get(item.s.day).push(item);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.s.startMin - b.s.startMin);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].s.startMin < list[i].s.endMin; j++) {
        const a = list[i];
        const b = list[j];
        const pair = [a.k, b.k].sort();
        if (a.s.teacherId && a.s.teacherId === b.s.teacherId) {
          const name = teacherById.get(a.s.teacherId)?.name || 'A teacher';
          add('TEACHER_CLASH', pair, a.s, `${name} is double-booked ${when(a.s)}: ${what(a.s)} and ${what(b.s)}.`);
        }
        if (a.s.classGroupId && a.s.classGroupId === b.s.classGroupId) {
          add('CLASS_CLASH', pair, a.s, `${groupNameById.get(a.s.classGroupId) || 'A class'} has two classes at once on ${dayName(a.s.day)}: ${a.s.courseName} and ${b.s.courseName}.`);
        }
        if (a.s.roomId && a.s.roomId === b.s.roomId) {
          add('ROOM_CLASH', pair, a.s, `${roomNameById.get(a.s.roomId) || 'A room'} is double-booked ${when(a.s)}: ${what(a.s)} and ${what(b.s)}.`);
        }
      }
    }
  }

  const blocksByDay = new Map();
  for (const b of fixedBlocks) {
    if (!blocksByDay.has(b.dayOfWeek)) blocksByDay.set(b.dayOfWeek, []);
    blocksByDay.get(b.dayOfWeek).push(b);
  }
  const rangesByDay = new Map(dayTemplates.map((t) => [t.dayOfWeek, t.fillableRanges || []]));

  for (const { s, k } of keyed) {
    for (const b of blocksByDay.get(s.day) || []) {
      const applies = !b.classGroupIds?.length || b.classGroupIds.includes(s.classGroupId);
      if (applies && overlaps(s, b)) {
        add('IN_BREAK', [k, b.label], s, `${what(s)} on ${when(s)} runs into ${b.label} (${timeRange(b.startMin, b.endMin)}).`);
      }
    }
    const ranges = rangesByDay.get(s.day) || [];
    if (!ranges.some((r) => s.startMin >= r.startMin && s.endMin <= r.endMin)) {
      add('OUTSIDE_HOURS', [k], s, `${what(s)} on ${when(s)} is outside school hours.`);
    }
    const teacher = s.teacherId ? teacherById.get(s.teacherId) : null;
    if (!teacher) continue;
    if (Array.isArray(teacher.allowedDays) && teacher.allowedDays.length > 0 && !teacher.allowedDays.includes(s.day)) {
      add('TEACHER_UNAVAILABLE', [k, 'day'], s, `${teacher.name} isn't set to work ${dayName(s.day)}s (${what(s)}, ${timeRange(s.startMin, s.endMin)}).`);
    }
    const away = (teacher.excludedWindows || []).find((w) => w.day === s.day && overlaps(s, w));
    if (away) {
      add('TEACHER_UNAVAILABLE', [k, 'window'], s, `${teacher.name} isn't available for all of ${when(s)} (${what(s)}).`);
    }
  }

  return out;
}

const CODE_ORDER = ['TEACHER_CLASH', 'CLASS_CLASH', 'ROOM_CLASH', 'IN_BREAK', 'OUTSIDE_HOURS', 'TEACHER_UNAVAILABLE'];

/** Problems in `after` that `before` didn't already have. */
function newProblems(before, after) {
  const seen = new Set(before.map((p) => p.key));
  const fresh = new Map();
  for (const p of after) if (!seen.has(p.key) && !fresh.has(p.key)) fresh.set(p.key, p);
  return [...fresh.values()]
    .sort((a, b) => CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code) || a.dayOfWeek - b.dayOfWeek)
    .map(({ code, dayOfWeek, message }) => ({ code, dayOfWeek, message }));
}

module.exports = { findProblems, newProblems };
