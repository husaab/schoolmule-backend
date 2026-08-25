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

describe('Integration: POST /generate with baseScheduleId (variations)', () => {
  it('warm-starts from a saved schedule and every candidate differs from it', async () => {
    const { teacherId, classGroupId } = await setupSmallSchool();
    // A second course gives the instance real variety: the engine deliberately
    // treats few-minute slides as duplicates, so distinct schedules must swap
    // which course occupies which slot.
    await asAdmin('post', `/api/schedule-planner/class-groups/${classGroupId}/courses`).send({
      name: 'Science',
      sessionsPerWeek: 2,
      durationMinutes: 40,
      maxPerDay: 1,
      assignedTeacherId: teacherId,
    });
    const genRes = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 1,
      seed: 5,
      timeBudgetMs: 3000,
    });
    const baseSessions = genRes.body.data.candidates[0].sessions;
    const saveRes = await asAdmin('post', '/api/schedule-planner/schedules').send({
      name: 'Variation base',
      sessions: baseSessions,
    });
    const scheduleId = saveRes.body.data.scheduleId;

    const res = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 3,
      seed: 9,
      timeBudgetMs: 3000,
      baseScheduleId: scheduleId,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.candidates.length).toBeGreaterThanOrEqual(1);

    const baseKeys = new Set(baseSessions.map((s) => `${s.courseId}:${s.day}:${s.startMin}`));
    for (const cand of res.body.data.candidates) {
      const shared = cand.sessions.filter((s) =>
        baseKeys.has(`${s.courseId}:${s.day}:${s.startMin}`)
      ).length;
      expect(shared / cand.sessions.length).toBeLessThanOrEqual(0.9);
    }
  });

  it('returns 404 for a baseScheduleId that does not exist', async () => {
    await setupSmallSchool();
    const res = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 2,
      timeBudgetMs: 1000,
      baseScheduleId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(404);
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

// The CP-SAT service is mocked at the transport boundary: these assert that the
// route forwards the request and passes the service's envelope through to the
// same 200/422 shapes the in-process solver produces.
describe('Integration: POST /generate routed to the CP-SAT solver service', () => {
  const originalUrl = process.env.SOLVER_URL;
  let fetchSpy;

  beforeEach(() => {
    process.env.SOLVER_URL = 'http://solver.internal:8000';
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.SOLVER_URL;
    else process.env.SOLVER_URL = originalUrl;
    if (fetchSpy) fetchSpy.mockRestore();
  });

  it('returns 200 with the service candidates and forwards the assembled input', async () => {
    const { teacherId, classGroupId } = await setupSmallSchool();
    const sessions = [
      {
        courseId: 'c-1',
        sessionIndex: 0,
        classGroupId,
        courseName: 'Math',
        day: 1,
        startMin: 480,
        endMin: 520,
        teacherId,
        roomId: null,
        pinned: false,
      },
    ];
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        candidates: [{ candidateIndex: 0, sessions, metrics: { teacherLoadStdDev: 0, avgGapMinutesPerClass: 0 } }],
        meta: { requested: 2, returned: 1, elapsedMs: 40, timedOut: false, seed: 9, nodes: 11, warnings: [] },
      }),
    });

    const res = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 2,
      seed: 9,
      timeBudgetMs: 3000,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.candidates[0].sessions).toEqual(sessions);
    expect(res.body.data.meta.returned).toBe(1);

    // The service receives the same solver input the JS engine would have run.
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://solver.internal:8000/solve');
    const sent = JSON.parse(options.body);
    expect(sent.courses).toHaveLength(1);
    expect(sent.courses[0].teacherId).toBe(teacherId);
    expect(sent.days.map((d) => d.day).sort()).toEqual([1, 2]);
  });

  it('maps a service infeasible envelope to the existing 422 diagnostics shape', async () => {
    await setupSmallSchool();
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: false,
        phase: 'search',
        diagnostics: [{ code: 'PERIOD_RULE_IMPOSSIBLE', message: 'Ms. X cannot cover that window.' }],
        partial: null,
        meta: { requested: 1, returned: 0, elapsedMs: 20, timedOut: false, seed: 1, nodes: 4, warnings: [] },
      }),
    });

    const res = await asAdmin('post', '/api/schedule-planner/generate').send({ numCandidates: 1 });

    expect(res.status).toBe(422);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toBe('Ms. X cannot cover that window.');
    expect(res.body.data.phase).toBe('search');
    expect(res.body.data.diagnostics[0].code).toBe('PERIOD_RULE_IMPOSSIBLE');
  });

  it('still returns a schedule when the service is down (JS fallback)', async () => {
    await setupSmallSchool();
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 1,
      seed: 42,
      timeBudgetMs: 3000,
    });

    expect(fetchSpy).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body.data.candidates.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.candidates[0].sessions).toHaveLength(2);
  });
});

describe('Integration: teacher spare rules round-trip through the API', () => {
  it('creates, reads back, edits and clears maxSparesPerDay / avoidAdjacentSpares', async () => {
    const created = await asAdmin('post', '/api/schedule-planner/teachers').send({
      displayName: 'Ms. Homeroom',
      maxSparesPerDay: 1,
      avoidAdjacentSpares: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.maxSparesPerDay).toBe(1);
    expect(created.body.data.avoidAdjacentSpares).toBe(true);
    const id = created.body.data.plannerTeacherId;

    const listed = await asAdmin('get', '/api/schedule-planner/teachers');
    const mine = listed.body.data.find((t) => t.plannerTeacherId === id);
    expect(mine.maxSparesPerDay).toBe(1);

    const edited = await asAdmin('patch', `/api/schedule-planner/teachers/${id}`).send({
      maxSparesPerDay: 2,
      avoidAdjacentSpares: false,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.maxSparesPerDay).toBe(2);
    expect(edited.body.data.avoidAdjacentSpares).toBe(false);

    // null clears the rule (teacher opts out again)
    const cleared = await asAdmin('patch', `/api/schedule-planner/teachers/${id}`).send({
      maxSparesPerDay: null,
    });
    expect(cleared.body.data.maxSparesPerDay).toBeNull();

    const removed = await asAdmin('delete', `/api/schedule-planner/teachers/${id}`);
    expect(removed.status).toBe(200);
  });

  it('rejects a negative spare cap', async () => {
    const res = await asAdmin('post', '/api/schedule-planner/teachers').send({
      displayName: 'Ms. Bad',
      maxSparesPerDay: -1,
    });
    expect(res.status).toBe(400);
  });

  it('defaults both fields to null for teachers that do not opt in', async () => {
    const res = await asAdmin('post', '/api/schedule-planner/teachers').send({
      displayName: 'Ms. Plain',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.maxSparesPerDay).toBeNull();
    expect(res.body.data.avoidAdjacentSpares).toBeNull();
    await asAdmin('delete', `/api/schedule-planner/teachers/${res.body.data.plannerTeacherId}`);
  });
});
