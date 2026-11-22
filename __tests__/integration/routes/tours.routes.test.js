// Guided tours against the real schema: progress is per person, derived from
// events on the server, reachable by every role (students and parents too),
// never written by an admin's "View as" preview, and a patch note can carry
// a tour id.
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440002';
const STUDENT_USER_ID = '550e8400-e29b-41d4-a716-446655440003';

const asTeacher = { userId: TEACHER_ID, username: 'Teacher One', email: 'teacher@example.test', role: 'TEACHER', baseRole: 'TEACHER' };
const asParent = { userId: PARENT_ID, username: 'Parent One', email: 'parent@example.test', role: 'PARENT', baseRole: 'PARENT' };
const asStudent = { userId: STUDENT_USER_ID, username: 'Student One', email: 'student@example.test', role: 'STUDENT', baseRole: 'STUDENT' };

const event = (as, tourId, body) => authenticatedRequest('post', `/api/tours/${tourId}/event`, as).send(body);
const progressOf = async (as) => (await authenticatedRequest('get', '/api/tours/progress', as)).body.data;

describe('Integration: guided tours', () => {
  let pool;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  beforeEach(async () => {
    const users = [
      [ADMIN_ID, 'admin@example.test', 'Test Admin', 'ADMIN', '2025-01-01T00:00:00Z'],
      [TEACHER_ID, 'teacher@example.test', 'Teacher One', 'TEACHER', '2026-11-25T09:00:00Z'],
      [PARENT_ID, 'parent@example.test', 'Parent One', 'PARENT', '2025-09-01T00:00:00Z'],
      [STUDENT_USER_ID, 'student@example.test', 'Student One', 'STUDENT', '2026-12-01T00:00:00Z'],
    ];
    for (const [id, email, username, role, createdAt] of users) {
      await pool.query(
        `INSERT INTO users (user_id, email, username, first_name, last_name, role, school, password, is_verified, is_verified_school, created_at)
         VALUES ($1, $2, $3, $3, 'Test', $4, 'ALHAADIACADEMY', 'x', true, true, $5)`,
        [id, email, username, role, createdAt]
      );
    }
  });

  it('starts empty and reports the account creation date and server time', async () => {
    const data = await progressOf(asTeacher);
    expect(data.progress).toEqual([]);
    expect(new Date(data.createdAt).toISOString()).toBe('2026-11-25T09:00:00.000Z');
    expect(Number.isNaN(Date.parse(data.serverNow))).toBe(false);
  });

  it('walks a tour from offered to completed and logs every event', async () => {
    const id = 'welcome-staff';
    expect((await event(asTeacher, id, { event: 'offered', version: 1, platform: 'web' })).status).toBe(200);
    expect((await event(asTeacher, id, { event: 'started', version: 1, stepIndex: 0, stepId: 'hello', platform: 'web' })).body.data)
      .toMatchObject({ tourId: id, status: 'in_progress', stepIndex: 0, stepId: 'hello' });
    await event(asTeacher, id, { event: 'step', version: 1, stepIndex: 1, stepId: 'classes', platform: 'web' });
    const done = await event(asTeacher, id, { event: 'completed', version: 1, stepIndex: 4, platform: 'app' });
    expect(done.body.data).toMatchObject({ status: 'completed' });
    expect(done.body.data.completedAt).toBeTruthy();

    const { rows } = await pool.query(
      'SELECT event, step_index, step_id, role, platform FROM user_tour_events WHERE user_id = $1 ORDER BY event_id', [TEACHER_ID]
    );
    expect(rows.map((r) => r.event)).toEqual(['offered', 'started', 'step', 'completed']);
    expect(rows[2]).toMatchObject({ step_index: 1, step_id: 'classes', role: 'TEACHER', platform: 'web' });

    // A late step write from another device doesn't undo "completed".
    await event(asTeacher, id, { event: 'step', version: 1, stepIndex: 2, platform: 'app' });
    expect((await progressOf(asTeacher)).progress[0]).toMatchObject({ tourId: id, status: 'completed' });
  });

  it('Later snoozes for three days and Don\'t show again dismisses', async () => {
    const snoozed = await event(asTeacher, 'publish-grades', { event: 'snoozed', version: 1 });
    expect(snoozed.body.data.status).toBe('offered');
    const days = (Date.parse(snoozed.body.data.snoozedUntil) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
    expect((await event(asTeacher, 'publish-grades', { event: 'dismissed', version: 1 })).body.data.status).toBe('dismissed');
  });

  it('a new tour version is offered again', async () => {
    await event(asTeacher, 'publish-grades', { event: 'completed', version: 1 });
    const v2 = await event(asTeacher, 'publish-grades', { event: 'offered', version: 2 });
    expect(v2.body.data).toMatchObject({ version: 2, status: 'offered', stepIndex: 0 });
  });

  it('two devices sending their first events at once both land on one row', async () => {
    const results = await Promise.all([
      event(asTeacher, 'race', { event: 'started', version: 1, stepIndex: 0, stepId: 'a', platform: 'web' }),
      event(asTeacher, 'race', { event: 'completed', version: 1, stepIndex: 3, stepId: 'd', platform: 'app' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM user_tour_events WHERE tour_id = 'race'");
    expect(rows[0].n).toBe(2);
    expect((await progressOf(asTeacher)).progress.filter((p) => p.tourId === 'race')).toHaveLength(1);
  });

  it('an old tab\'s event for an older tour version changes nothing', async () => {
    await event(asTeacher, 'publish-grades', { event: 'offered', version: 2 });
    const stale = await event(asTeacher, 'publish-grades', { event: 'completed', version: 1, stepIndex: 5 });
    expect(stale.body.data).toMatchObject({ version: 2, status: 'offered' });
  });

  it('keeps each person\'s progress to themselves', async () => {
    await event(asTeacher, 'welcome-staff', { event: 'completed', version: 1 });
    expect((await progressOf(asParent)).progress).toEqual([]);
  });

  it('is open to parents and students', async () => {
    expect((await event(asParent, 'welcome-parent', { event: 'started', version: 1, stepIndex: 0 })).status).toBe(200);
    const student = await event(asStudent, 'welcome-student', { event: 'started', version: 1, stepIndex: 0 });
    expect(student.status).toBe(200);
    const mine = await progressOf(asStudent);
    expect(mine.progress).toEqual([expect.objectContaining({ tourId: 'welcome-student', status: 'in_progress' })]);
  });

  it('refuses writes from an admin "View as" preview', async () => {
    const preview = { ...asTeacher, impersonator: { userId: ADMIN_ID, email: 'admin@example.test' } };
    expect((await event(preview, 'welcome-staff', { event: 'started', version: 1 })).status).toBe(403);
    expect((await authenticatedRequest('get', '/api/tours/progress', preview)).status).toBe(200);
  });

  it.each([
    ['a bad tour id', 'Not_A_Tour', { event: 'started' }],
    ['an unknown event', 'welcome-staff', { event: 'exploded' }],
    ['a bad version', 'welcome-staff', { event: 'started', version: 0 }],
    ['a bad step', 'welcome-staff', { event: 'step', stepIndex: -1 }],
    ['a bad platform', 'welcome-staff', { event: 'step', platform: 'fax' }],
  ])('rejects %s', async (_label, tourId, body) => {
    expect((await event(asTeacher, tourId, body)).status).toBe(400);
  });

  it('a patch note can carry a tour id, and it can be cleared', async () => {
    const asAdmin = { userId: ADMIN_ID, role: 'ADMIN', baseRole: 'ADMIN', isFullAdmin: true, accessRole: 'ADMIN' };
    const created = await authenticatedRequest('post', '/api/patch-notes/create', asAdmin).send({
      title: 'Publish grades', body: 'Marks stay private until you publish them.', version: '3.2', category: 'feature',
      targetRoles: ['teacher'], tourId: 'publish-grades',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.tourId).toBe('publish-grades');
    const id = created.body.data.patchNoteId;

    const teacherNotes = await authenticatedRequest('get', '/api/patch-notes/unread', asTeacher);
    expect(teacherNotes.body.data.notes[0].tourId).toBe('publish-grades');

    const kept = await authenticatedRequest('patch', `/api/patch-notes/${id}`, asAdmin).send({ title: 'Publish grades to parents' });
    expect(kept.body.data.tourId).toBe('publish-grades');
    const cleared = await authenticatedRequest('patch', `/api/patch-notes/${id}`, asAdmin).send({ tourId: null });
    expect(cleared.body.data.tourId).toBeNull();
    const bad = await authenticatedRequest('patch', `/api/patch-notes/${id}`, asAdmin).send({ tourId: 'Bad Id!' });
    expect(bad.status).toBe(400);
  });
});
