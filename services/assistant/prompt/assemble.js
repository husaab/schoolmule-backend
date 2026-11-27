// services/assistant/prompt/assemble.js
//
// The instructions for one turn: the static prefix (the same bytes for
// everyone, so it caches), then what is true of this person right now.
// Nothing here comes from the model or from page text: the name and role
// are the session's, and the page is only what a guarded read confirmed.

const { STATIC_PREFIX, STATIC_PREFIX_PARENT } = require('./static');
const { PERMISSIONS } = require('../../../config/permissions');

const VIEW_LABEL = { ADMIN: 'a school administrator', TEACHER: 'a teacher' };

/** Today's date in the school's timezone, as YYYY-MM-DD and as a weekday. */
function todayIn(timezone, now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const weekday = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, weekday: 'long' }).format(now);
  return { date, weekday };
}

/**
 * @param {{ firstName?: string|null, view: string, access: object, schoolYearLabel?: string|null,
 *   today: { date: string, weekday: string }, page?: { label: string, classRef?: string|null } | null }} context
 * @returns {string[]} system instructions, static part first
 */
function assemble({ firstName, view, access, schoolYearLabel, today, page, allowWrites = false }) {
  const lines = ['# This conversation'];
  if (view === 'PARENT') {
    lines.push(`You are helping ${firstName ? `${firstName}, ` : ''}a parent or guardian in the parent portal.`);
    lines.push(`Today is ${today.weekday}, ${today.date}.${schoolYearLabel ? ` The school year in use is ${schoolYearLabel}.` : ''}`);
    lines.push('You can only read, explain and show where things are.');
    return [STATIC_PREFIX_PARENT, lines.join('\n')];
  }
  lines.push(`You are helping ${firstName ? `${firstName}, ` : ''}${VIEW_LABEL[view] || 'a member of staff'}.`);
  if (access.isFullAdmin) {
    lines.push('Their account is a full administrator: it can open every area of the school.');
  } else {
    const held = PERMISSIONS.filter((p) => access.permissions.has(p.key)).map((p) => p.label);
    lines.push('Their account can always work with the classes they teach.');
    if (held.length > 0) lines.push(`Beyond their own classes it has: ${held.join('; ')}.`);
  }
  lines.push(`Today is ${today.weekday}, ${today.date}.${schoolYearLabel ? ` The school year in use is ${schoolYearLabel}.` : ''}`);
  lines.push(allowWrites
    ? 'This school lets you prepare changes for this person to save, with the tools that prepare them (attendance, marks, report card comments, who counts in the class average, the school\'s stamp, logo or signature). Nothing else can be changed through you.'
    : 'This school has not switched on preparing changes: you can only read, explain and show where things are.');
  if (page && page.classRef) {
    lines.push(`They are looking at the class ${page.label} right now. Its ref is ${page.classRef}.`);
  }
  if (page && page.dailyAttendance) {
    lines.push('They are on the General Attendance page, the school\'s daily attendance: "attendance" here means daily attendance (get_daily_attendance, propose_general_attendance).');
  }
  return [STATIC_PREFIX, lines.join('\n')];
}

module.exports = { assemble, todayIn };
