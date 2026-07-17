// Integration: publish flow (materialized sessions, one-published-per-school),
// teacher /my-schedule endpoint, and the public unauthenticated share link.

const request = require('supertest');
const { authenticatedRequest, getApp } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const SCHOOL = 'ALHAADIACADEMY';
const TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440042';

const asAdmin = (method, url) => authenticatedRequest(method, url);
const asTeacher = (method, url) =>
  authenticatedRequest(method, url, { role: 'TEACHER', userId: TEACHER_USER_ID });

async function seedSchoolAndUser() {
  const pool = getTestPool();
  // setupTestDB's global beforeEach already seeds a baseline ALHAADIACADEMY
  // row (+ active school_year via trigger) so resolveSchoolYear doesn't 400
  // pre-existing write-path tests; upsert here instead of a plain INSERT so
  // this doesn't collide with it.
  await pool.query(
    `INSERT INTO schools (school_code, name, slug) VALUES ($1, 'Al Haadi Academy', 'al-haadi-academy')
     ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`,
    [SCHOOL]
  );
  await pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, 't@test.com', 'teachx', 'x', 'Teach', 'Er', $2, 'TEACHER', true, true)`,
    [TEACHER_USER_ID, SCHOOL]
  );
}

// Full pipeline: config -> generate -> save draft. Returns { scheduleId, shareToken }.
async function setupAndSaveDraft({ linkTeacherUser = true } = {}) {
  const teacherRes = await asAdmin('post', '/api/schedule-planner/teachers').send({
    displayName: 'Ms. X',
    userId: linkTeacherUser ? TEACHER_USER_ID : null,
  });
  const groupRes = await asAdmin('post', '/api/schedule-planner/class-groups').send({
    name: 'Grade 1',
  });
  await asAdmin(
    'post',
    `/api/schedule-planner/class-groups/${groupRes.body.data.classGroupId}/courses`
  ).send({
    name: 'Math',
    sessionsPerWeek: 2,
    durationMinutes: 40,
    maxPerDay: 1,
    assignedTeacherId: teacherRes.body.data.plannerTeacherId,
  });
  await asAdmin('put', '/api/schedule-planner/day-templates').send({
    days: [
      { dayOfWeek: 1, fillableRanges: [{ startMin: 480, endMin: 600 }] },
      { dayOfWeek: 2, fillableRanges: [{ startMin: 480, endMin: 600 }] },
    ],
  });
  const genRes = await asAdmin('post', '/api/schedule-planner/generate').send({
    numCandidates: 1,
    seed: 9,
    timeBudgetMs: 2000,
  });
  const saveRes = await asAdmin('post', '/api/schedule-planner/schedules').send({
    name: 'Master Schedule',
    sessions: genRes.body.data.candidates[0].sessions,
  });
  return {
    scheduleId: saveRes.body.data.scheduleId,
    shareToken: saveRes.body.data.shareToken,
  };
}

describe('Integration: publish flow', () => {
  it('publishes a draft, materializes sessions, and demotes the previous published schedule', async () => {
    await seedSchoolAndUser();
    const first = await setupAndSaveDraft();

    const pubRes = await asAdmin(
      'post',
      `/api/schedule-planner/schedules/${first.scheduleId}/publish`
    );
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.data.status).toBe('published');
    expect(pubRes.body.data.publishedAt).toBeTruthy();

    // Materialized rows exist with resolved teacher_user_id and names
    const pool = getTestPool();
    const { rows } = await pool.query(
      'SELECT * FROM planner_schedule_sessions WHERE schedule_id = $1 ORDER BY day_of_week',
      [first.scheduleId]
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].teacher_user_id).toBe(TEACHER_USER_ID);
    expect(rows[0].teacher_name).toBe('Ms. X');
    expect(rows[0].class_group_name).toBe('Grade 1');
    expect(rows[0].course_name).toBe('Math');

    // Publishing a second draft demotes the first
    const saveRes2 = await asAdmin('post', '/api/schedule-planner/schedules').send({
      name: 'Second Schedule',
      sessions: (await asAdmin('get', `/api/schedule-planner/schedules/${first.scheduleId}`)).body
        .data.sessions,
    });
    const secondId = saveRes2.body.data.scheduleId;
    const pubRes2 = await asAdmin('post', `/api/schedule-planner/schedules/${secondId}/publish`);
    expect(pubRes2.status).toBe(200);

    const listRes = await asAdmin('get', '/api/schedule-planner/schedules');
    const byId = Object.fromEntries(listRes.body.data.map((s) => [s.scheduleId, s.status]));
    expect(byId[first.scheduleId]).toBe('draft');
    expect(byId[secondId]).toBe('published');

    // Old materialized sessions are gone, new ones exist
    const { rows: oldRows } = await pool.query(
      'SELECT * FROM planner_schedule_sessions WHERE schedule_id = $1',
      [first.scheduleId]
    );
    expect(oldRows).toHaveLength(0);
  });

  it('404s when publishing a nonexistent schedule', async () => {
    await seedSchoolAndUser();
    const res = await asAdmin(
      'post',
      '/api/schedule-planner/schedules/00000000-0000-0000-0000-000000000000/publish'
    );
    expect(res.status).toBe(404);
  });
});

describe('Integration: GET /api/schedule-planner/my-schedule', () => {
  it('returns only the logged-in teacher sessions from the published schedule', async () => {
    await seedSchoolAndUser();
    const { scheduleId } = await setupAndSaveDraft();
    await asAdmin('post', `/api/schedule-planner/schedules/${scheduleId}/publish`);

    const res = await asTeacher('get', '/api/schedule-planner/my-schedule');
    expect(res.status).toBe(200);
    expect(res.body.data.sessions).toHaveLength(2);
    expect(res.body.data.sessions[0].teacherName).toBe('Ms. X');
    expect(res.body.data.sessions[0].courseName).toBe('Math');
  });

  it('returns an empty list when nothing is published', async () => {
    await seedSchoolAndUser();
    const res = await asTeacher('get', '/api/schedule-planner/my-schedule');
    expect(res.status).toBe(200);
    expect(res.body.data.sessions).toEqual([]);
  });
});

describe('Integration: public schedule endpoint', () => {
  it('serves the published schedule without authentication', async () => {
    await seedSchoolAndUser();
    const { scheduleId, shareToken } = await setupAndSaveDraft();
    await asAdmin('post', `/api/schedule-planner/schedules/${scheduleId}/publish`);

    const res = await request(getApp()).get(
      `/api/schedule/public/al-haadi-academy/${shareToken}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.schoolName).toBe('Al Haadi Academy');
    expect(res.body.data.scheduleName).toBe('Master Schedule');
    expect(res.body.data.sessions).toHaveLength(2);
    expect(res.body.data.sessions[0].classGroupName).toBe('Grade 1');
  });

  it('404s for drafts, wrong tokens, and mismatched slugs', async () => {
    await seedSchoolAndUser();
    const { scheduleId, shareToken } = await setupAndSaveDraft();

    // Draft (not published yet)
    const draftRes = await request(getApp()).get(
      `/api/schedule/public/al-haadi-academy/${shareToken}`
    );
    expect(draftRes.status).toBe(404);

    await asAdmin('post', `/api/schedule-planner/schedules/${scheduleId}/publish`);

    const badToken = await request(getApp()).get(
      '/api/schedule/public/al-haadi-academy/00000000-0000-0000-0000-000000000000'
    );
    expect(badToken.status).toBe(404);

    const badSlug = await request(getApp()).get(`/api/schedule/public/wrong-school/${shareToken}`);
    expect(badSlug.status).toBe(404);
  });
});
