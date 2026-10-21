#!/usr/bin/env node
// scripts/seed/playground/smoke.js
//
// Signs in as the four PLAYGROUND test accounts and reads the main screens of
// each role (GET only, nothing is written). Prints one line per call with the
// status and a short summary, and exits 1 if any call fails.
//
//   node scripts/seed/playground/smoke.js https://schoolmule-backend-production.up.railway.app/api

const C = require('./content');

const BASE = (process.argv[2] || 'http://127.0.0.1:4000/api').replace(/\/$/, '');
let failures = 0;

const summarize = (data) => {
  if (Array.isArray(data)) return `${data.length} items`;
  if (data && typeof data === 'object') {
    return Object.entries(data).slice(0, 6).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:${v.length}`;
      if (v && typeof v === 'object') return `${k}:{…}`;
      return `${k}:${String(v).slice(0, 24)}`;
    }).join(' ');
  }
  return String(data).slice(0, 60);
};

async function call(token, path, label = path, expectStatus = null) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const ok = expectStatus ? res.status === expectStatus : res.status < 400;
  if (!ok) failures += 1;
  const data = body?.data ?? body;
  console.log(`  ${ok ? 'ok ' : 'ERR'} ${res.status} ${label.padEnd(58)} ${ok ? summarize(data) : (body?.message || body?.code || '')}`);
  return data;
}

async function login(email) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: C.PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    failures += 1;
    console.log(`ERR login ${email}: ${res.status} ${body.message || body.code || ''}`);
    return null;
  }
  const d = body.data;
  console.log(`\n${d.role} ${d.fullName} <${email}> · year ${d.activeSchoolYear?.label} · term ${d.activeTerm}`);
  return d;
}

(async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

  const admin = await login(`admin@${C.DOMAIN}`);
  if (admin) {
    const t = admin.token;
    await call(t, `/dashboard/summary?term=${encodeURIComponent(admin.activeTerm)}&date=${today}`);
    await call(t, '/dashboard/attendance/trend');
    await call(t, '/students');
    await call(t, '/classroom/classes');
    await call(t, '/admin/approvals');
    await call(t, '/admin/student-accounts');
    const termId = (await call(t, '/terms', '/terms'))?.find?.((x) => x.isActive || x.is_active)?.termId;
    await call(t, `/analytics/overview?termId=${termId}`, '/analytics/overview?termId=');
    await call(t, '/announcements');
    await call(t, '/messaging/conversations');
    await call(t, '/schedule-planner/school-schedule');
    await call(t, '/teacher-attendance/pay-periods');
    await call(t, '/calendar-events');
  }

  const teacher = await login(`teacher@${C.DOMAIN}`);
  if (teacher) {
    const t = teacher.token;
    const classes = await call(t, '/classroom/classes');
    const list = Array.isArray(classes) ? classes : classes?.classes || [];
    const sci = list.find((c) => c.subject === 'Science' && String(c.grade) === '5') || list[0];
    if (sci) {
      const id = sci.classId || sci.class_id || sci.id;
      await call(t, `/classroom/classes/${id}`, `/classroom/classes/:G5 Science`);
      await call(t, `/classroom/classes/${id}/stream`, '/classroom/classes/:id/stream');
      const items = await call(t, `/classroom/classes/${id}/items`, '/classroom/classes/:id/items');
      await call(t, `/classroom/classes/${id}/people`, '/classroom/classes/:id/people');
      await call(t, `/analytics/class/${id}`, '/analytics/class/:id');
      const arr = Array.isArray(items) ? items : items?.items || [];
      const assignment = arr.find((i) => i.kind === 'assignment');
      if (assignment) await call(t, `/classroom/items/${assignment.itemId || assignment.item_id}/submissions`, '/classroom/items/:assignment/submissions');
    }
    await call(t, '/schedule-planner/my-schedule');
    await call(t, `/teacher-attendance/today?date=${today}`, '/teacher-attendance/today?date=');
    await call(t, '/teacher-attendance/me/pay-period');
    await call(t, '/messaging/conversations');
    await call(t, '/messaging/conversations/unread-count');
    await call(t, '/announcements');
    const termId = (await call(t, '/terms', '/terms'))?.find?.((x) => x.isActive || x.is_active)?.termId;
    await call(t, `/analytics/classes-health?termId=${termId}`, '/analytics/classes-health?termId=');
  }

  const parent = await login(`parent@${C.DOMAIN}`);
  if (parent) {
    const t = parent.token;
    const summary = await call(t, '/parent-portal/summary');
    await call(t, '/parent-portal/recent-publications');
    await call(t, '/parent-portal/calendar');
    await call(t, '/parent-portal/classroom/summary');
    const kids = summary?.children || summary?.students || [];
    for (const kid of kids) {
      const id = kid.studentId || kid.student_id || kid.id;
      const name = kid.name || kid.studentName || id;
      await call(t, `/parent-portal/students/${id}/grades`, `grades · ${name}`);
      await call(t, `/parent-portal/students/${id}/attendance`, `attendance · ${name}`);
      await call(t, `/parent-portal/students/${id}/feedback`, `feedback · ${name}`);
      await call(t, `/parent-portal/students/${id}/weekly-summary`, `weekly-summary · ${name}`);
      await call(t, `/parent-portal/students/${id}/classroom/classes`, `classroom classes · ${name}`);
    }
    await call(t, '/messaging/conversations');
    await call(t, '/announcements');
    await call(t, '/parent-portal/notification-prefs');
  }

  const student = await login(`student@${C.DOMAIN}`);
  if (student) {
    const t = student.token;
    await call(t, '/student/home');
    await call(t, '/student/classes');
    await call(t, '/student/todo');
    await call(t, '/student/grades');
    await call(t, '/student/announcements');
    await call(t, '/student/conversations');
    await call(t, '/messaging/conversations', '/messaging/conversations (the student fence: 403)', 403);
  }

  console.log(failures ? `\n${failures} call(s) failed` : '\nall calls ok');
  process.exit(failures ? 1 : 0);
})();
