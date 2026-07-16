// Integration: Schedule Planner generate (real solver in a worker thread)
// and schedule draft CRUD.

const { authenticatedRequest } = require('../setup/integrationApp');

const asAdmin = (method, url) => authenticatedRequest(method, url);

// Seeds a small solvable school through the public API:
// Mon+Tue 08:00-10:00, one teacher, one class group, Math 2x40 (max 1/day).
async function setupSmallSchool() {
  const teacherRes = await asAdmin('post', '/api/schedule-planner/teachers').send({
    displayName: 'Ms. X',
  });
  const teacherId = teacherRes.body.data.plannerTeacherId;

  const groupRes = await asAdmin('post', '/api/schedule-planner/class-groups').send({
    name: 'Grade 1',
  });
  const classGroupId = groupRes.body.data.classGroupId;

  await asAdmin('post', `/api/schedule-planner/class-groups/${classGroupId}/courses`).send({
    name: 'Math',
    sessionsPerWeek: 2,
    durationMinutes: 40,
    maxPerDay: 1,
    assignedTeacherId: teacherId,
  });

  await asAdmin('put', '/api/schedule-planner/day-templates').send({
    days: [
      { dayOfWeek: 1, fillableRanges: [{ startMin: 480, endMin: 600 }] },
      { dayOfWeek: 2, fillableRanges: [{ startMin: 480, endMin: 600 }] },
    ],
  });

  return { teacherId, classGroupId };
}

describe('Integration: POST /api/schedule-planner/generate', () => {
  it('generates valid candidates for a configured school', async () => {
    const { teacherId, classGroupId } = await setupSmallSchool();

    const res = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 3,
      seed: 42,
      timeBudgetMs: 3000,
    });
    expect(res.status).toBe(200);
    const { candidates, meta } = res.body.data;
    expect(meta.requested).toBe(3);
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    const sessions = candidates[0].sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions[0].teacherId).toBe(teacherId);
    expect(sessions[0].classGroupId).toBe(classGroupId);
    expect(sessions[0].endMin - sessions[0].startMin).toBe(40);
    expect(new Set(sessions.map((s) => s.day)).size).toBe(2); // maxPerDay 1
  });

  it('honors pinned sessions from the request body', async () => {
    const { teacherId } = await setupSmallSchool();
    const genRes = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 2,
      seed: 1,
      timeBudgetMs: 3000,
    });
    const courseId = genRes.body.data.candidates[0].sessions[0].courseId;

    const res = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 3,
      seed: 2,
      timeBudgetMs: 3000,
      pinnedSessions: [
        { courseId, sessionIndex: 0, day: 1, startMin: 480, teacherId, roomId: null },
      ],
    });
    expect(res.status).toBe(200);
    for (const cand of res.body.data.candidates) {
      const pinned = cand.sessions.find(
        (s) => s.day === 1 && s.startMin === 480 && s.pinned === true
      );
      expect(pinned).toBeDefined();
    }
  });

  it('clamps numCandidates to 50', async () => {
    await setupSmallSchool();
    const res = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 500,
      seed: 3,
      timeBudgetMs: 1000,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.meta.requested).toBe(50);
  });

  it('returns 422 with actionable diagnostics for an infeasible setup', async () => {
    const { classGroupId } = await setupSmallSchool();
    // Second teacher capped at 40 min/week but assigned 3x40 = 120 min.
    const teacherRes = await asAdmin('post', '/api/schedule-planner/teachers').send({
      displayName: 'Mr. Overbooked',
      maxWeeklyMinutes: 40,
    });
    await asAdmin('post', `/api/schedule-planner/class-groups/${classGroupId}/courses`).send({
      name: 'Science',
      sessionsPerWeek: 3,
      maxPerDay: 3,
      assignedTeacherId: teacherRes.body.data.plannerTeacherId,
    });

    const res = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 2,
      timeBudgetMs: 1000,
    });
    expect(res.status).toBe(422);
    expect(res.body.status).toBe('failed');
    expect(res.body.data.phase).toBe('preSolve');
    const codes = res.body.data.diagnostics.map((d) => d.code);
    expect(codes).toContain('TEACHER_OVER_MAX_HOURS');
    expect(res.body.message).toContain('Mr. Overbooked');
  });

  it('returns 400 when the school has no day templates configured', async () => {
    const res = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 2,
    });
    expect(res.status).toBe(400);
  });
});

describe('Integration: schedule draft CRUD', () => {
  it('saves, lists, reads, renames, and deletes a draft', async () => {
    await setupSmallSchool();
    const genRes = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 1,
      seed: 5,
      timeBudgetMs: 2000,
    });
    const sessions = genRes.body.data.candidates[0].sessions;

    const saveRes = await asAdmin('post', '/api/schedule-planner/schedules').send({
      name: 'Fall Draft A',
      sessions,
    });
    expect(saveRes.status).toBe(201);
    const scheduleId = saveRes.body.data.scheduleId;
    expect(saveRes.body.data.status).toBe('draft');
    expect(saveRes.body.data.shareToken).toBeDefined();

    const listRes = await asAdmin('get', '/api/schedule-planner/schedules');
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].name).toBe('Fall Draft A');
    // list is lightweight — no sessions payload
    expect(listRes.body.data[0].sessions).toBeUndefined();

    const getRes = await asAdmin('get', `/api/schedule-planner/schedules/${scheduleId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.sessions).toHaveLength(sessions.length);

    const patchRes = await asAdmin('patch', `/api/schedule-planner/schedules/${scheduleId}`).send({
      name: 'Fall Draft B',
    });
    expect(patchRes.body.data.name).toBe('Fall Draft B');

    const delRes = await asAdmin('delete', `/api/schedule-planner/schedules/${scheduleId}`);
    expect(delRes.status).toBe(200);
    const listRes2 = await asAdmin('get', '/api/schedule-planner/schedules');
    expect(listRes2.body.data).toHaveLength(0);
  });

  it('requires name and sessions to save a draft', async () => {
    const res = await asAdmin('post', '/api/schedule-planner/schedules').send({ name: 'X' });
    expect(res.status).toBe(400);
  });
});
