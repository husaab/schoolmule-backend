// Integration: "Copy with new times" — a schedule copied with winter bell
// times goes live on its date, the original keeps its own times so it can be
// published again in March, and the go-live date has full CRUD.

const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const goLiveWorker = require('../../../services/schedulePlanner/goLiveWorker');

const SCHOOL = 'ALHAADIACADEMY';
const TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440052';
const API = '/api/schedule-planner';

const asAdmin = (method, url) => authenticatedRequest(method, url);
const asTeacher = (method, url) => authenticatedRequest(method, url, { role: 'TEACHER', userId: TEACHER_USER_ID });

const torontoDay = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
};

/**
 * Two bells, like a Junior/Senior school: Grade 1 (P1 8:55, P5 12:45) and
 * Grade 5 (P1 8:55, P5 12:55), Salat 1:40 for everyone, day 8:55–3:00.
 */
async function seedSchool() {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO schools (school_code, name, slug) VALUES ($1, 'Test Academy', 'test-academy')
     ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`,
    [SCHOOL]
  );
  await pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, 'teacher.retime@example.test', 'retimeteacher', 'x', 'Test', 'Teacher', $2, 'TEACHER', true, true)`,
    [TEACHER_USER_ID, SCHOOL]
  );
  const t1 = (await asAdmin('post', `${API}/teachers`).send({ displayName: 'Teacher One', userId: TEACHER_USER_ID })).body.data;
  const t2 = (await asAdmin('post', `${API}/teachers`).send({ displayName: 'Teacher Two' })).body.data;
  const g1 = (await asAdmin('post', `${API}/class-groups`).send({ name: 'Grade 1' })).body.data;
  const g5 = (await asAdmin('post', `${API}/class-groups`).send({ name: 'Grade 5' })).body.data;
  const course = async (group, teacher) =>
    (await asAdmin('post', `${API}/class-groups/${group.classGroupId}/courses`).send({
      name: 'Math', sessionsPerWeek: 2, durationMinutes: 45, maxPerDay: 2, assignedTeacherId: teacher.plannerTeacherId,
    })).body.data;
  const c1 = await course(g1, t1);
  const c5 = await course(g5, t2);
  await asAdmin('put', `${API}/day-templates`).send({
    days: [1, 2].map((dayOfWeek) => ({ dayOfWeek, fillableRanges: [{ startMin: 535, endMin: 900 }] })),
  });
  for (const dayOfWeek of [1, 2]) {
    await asAdmin('post', `${API}/fixed-blocks`).send({ label: 'Salat', dayOfWeek, startMin: 820, endMin: 850, classGroupIds: [] });
  }
  const session = (c, g, t, sessionIndex, startMin) => ({
    courseId: c.courseId, sessionIndex, classGroupId: g.classGroupId, courseName: 'Math',
    day: 1, startMin, endMin: startMin + 45, teacherId: t.plannerTeacherId, roomId: null,
  });
  const sessions = [session(c1, g1, t1, 0, 535), session(c1, g1, t1, 1, 765), session(c5, g5, t2, 0, 535), session(c5, g5, t2, 1, 775)];
  const summer = (await asAdmin('post', `${API}/schedules`).send({ name: 'Summer', sessions })).body.data;
  await asAdmin('post', `${API}/schedules/${summer.scheduleId}/publish`).expect(200);
  return { summer, g1, g5 };
}

function winterEdits(model) {
  const rows = model.bells.flatMap((b) => b.rows);
  const period = (label, start) => rows.filter((r) => r.label === label && r.startMin === start);
  const salat = rows.find((r) => r.label === 'Salat');
  return {
    rows: [
      ...period('Period 1', 535).map((r) => ({ rowId: r.rowId, startMin: 530, endMin: 580 })),
      ...rows.filter((r) => r.label === 'Period 2').map((r) => ({ rowId: r.rowId, startMin: 805, endMin: 850 })),
      { rowId: salat.rowId, startMin: 775, endMin: 805 },
    ],
    added: [{ label: 'Assembly', startMin: 520, endMin: 530, classGroupIds: [] }],
    hours: [{ rowId: model.hours[0].rowId, startMin: 520, endMin: 900 }],
  };
}

const liveBlocks = async () =>
  (await getTestPool().query(
    `SELECT label, day_of_week, start_min, end_min FROM planner_fixed_blocks WHERE school = $1 ORDER BY day_of_week, start_min`,
    [SCHOOL]
  )).rows;
const liveHours = async () =>
  (await getTestPool().query(`SELECT fillable_ranges FROM planner_day_templates WHERE school = $1`, [SCHOOL])).rows.map(
    (r) => r.fillable_ranges[0]
  );

describe('Integration: copy with new times', () => {
  it('previews without writing, then saves a draft that carries its own bell times', async () => {
    const { summer } = await seedSchool();
    const model = (await asAdmin('get', `${API}/schedules/${summer.scheduleId}/retime`).expect(200)).body.data;
    expect(model.bells.map((b) => b.label)).toEqual(['Grade 1', 'Grade 5']);
    expect(model.bells[0].rows.map((r) => r.label)).toEqual(['Period 1', 'Period 2', 'Salat']);

    const edits = winterEdits(model);
    const dry = await asAdmin('post', `${API}/schedules/${summer.scheduleId}/retime`).send({ edits, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.data.totals).toEqual({ sessions: 4, moved: 4 });
    expect(dry.body.data.warnings).toEqual([]);
    const { rows: count } = await getTestPool().query('SELECT count(*)::int AS n FROM planner_schedules');
    expect(count[0].n).toBe(1);

    const created = await asAdmin('post', `${API}/schedules/${summer.scheduleId}/retime`).send({
      edits, name: 'Winter', goLiveOn: torontoDay(1),
    });
    expect(created.status).toBe(201);
    const winter = created.body.data.schedule;
    expect(winter).toMatchObject({
      name: 'Winter', status: 'draft', hasOwnBellTimes: true, sourceScheduleId: summer.scheduleId,
      goLiveOn: torontoDay(1), goLiveStatus: 'pending',
    });
    expect(winter.sessions.map((s) => s.startMin).sort()).toEqual([530, 530, 805, 805]);
    expect(winter.bellTimes.fixedBlocks.filter((b) => b.label === 'Assembly')).toHaveLength(2);

    // The live schedule and its breaks are untouched until go-live.
    expect((await liveBlocks()).map((b) => b.start_min)).toEqual([820, 820]);
  });

  it('rejects edits that no longer match the schedule', async () => {
    const { summer } = await seedSchool();
    const res = await asAdmin('post', `${API}/schedules/${summer.scheduleId}/retime`).send({
      edits: { rows: [{ rowId: 'p:gone:1-2', startMin: 1, endMin: 2 }] }, dryRun: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/changed since you opened it/);
  });

  it('goes live on its date, and the original brings its own times back', async () => {
    const { summer } = await seedSchool();
    const model = (await asAdmin('get', `${API}/schedules/${summer.scheduleId}/retime`)).body.data;
    const winter = (await asAdmin('post', `${API}/schedules/${summer.scheduleId}/retime`).send({
      edits: winterEdits(model), name: 'Winter', goLiveOn: torontoDay(0),
    })).body.data.schedule;

    // Not-yet-due drafts are left alone; due ones publish.
    expect(await goLiveWorker.runOnce()).toEqual({ claimed: 1, published: 1 });
    expect(await goLiveWorker.runOnce()).toEqual({ claimed: 0, published: 0 });

    const list = (await asAdmin('get', `${API}/schedules`)).body.data;
    const byId = Object.fromEntries(list.map((s) => [s.scheduleId, s]));
    expect(byId[winter.scheduleId]).toMatchObject({
      status: 'published', goLiveStatus: 'done', effectiveFrom: torontoDay(0), hasOwnBellTimes: false,
    });
    expect(byId[summer.scheduleId]).toMatchObject({ status: 'draft', hasOwnBellTimes: true });

    expect((await liveBlocks()).map((b) => `${b.label} ${b.start_min}`)).toEqual([
      'Assembly 520', 'Salat 775', 'Assembly 520', 'Salat 775',
    ]);
    expect(await liveHours()).toEqual([{ startMin: 520, endMin: 900 }, { startMin: 520, endMin: 900 }]);

    const mine = (await asTeacher('get', `${API}/my-schedule`).expect(200)).body.data;
    expect(mine.sessions.map((s) => s.startMin)).toEqual([530, 805]);
    expect(mine.fixedBlocks.some((b) => b.label === 'Assembly')).toBe(true);
    expect(mine.schedule).toMatchObject({ name: 'Winter', effectiveFrom: torontoDay(0) });

    // March: publish the original again.
    await asAdmin('post', `${API}/schedules/${summer.scheduleId}/publish`).expect(200);
    expect((await liveBlocks()).map((b) => `${b.label} ${b.start_min}`)).toEqual(['Salat 820', 'Salat 820']);
    expect(await liveHours()).toEqual([{ startMin: 535, endMin: 900 }, { startMin: 535, endMin: 900 }]);
    const again = (await asAdmin('get', `${API}/schedules/${winter.scheduleId}`)).body.data;
    expect(again).toMatchObject({ status: 'draft', hasOwnBellTimes: true, goLiveOn: null, goLiveStatus: null });
    expect(again.bellTimes.fixedBlocks.some((b) => b.label === 'Assembly')).toBe(true);

    // Next November the winter copy can be scheduled again.
    await asAdmin('put', `${API}/schedules/${winter.scheduleId}/go-live`).send({ goLiveOn: torontoDay(5) }).expect(200);
  });

  it('keeps a break edited in settings when the live schedule is published again', async () => {
    const { summer } = await seedSchool();
    const model = (await asAdmin('get', `${API}/schedules/${summer.scheduleId}/retime`)).body.data;
    const winter = (await asAdmin('post', `${API}/schedules/${summer.scheduleId}/retime`).send({
      edits: winterEdits(model), name: 'Winter',
    })).body.data.schedule;
    await asAdmin('post', `${API}/schedules/${winter.scheduleId}/publish`).expect(200);

    const salat = (await asAdmin('get', `${API}/fixed-blocks`)).body.data.find((b) => b.label === 'Salat');
    await asAdmin('patch', `${API}/fixed-blocks/${salat.fixedBlockId}`).send({ startMin: 780, endMin: 810 }).expect(200);
    await asAdmin('post', `${API}/schedules/${winter.scheduleId}/publish`).expect(200);

    expect((await liveBlocks()).filter((b) => b.label === 'Salat').map((b) => b.start_min).sort()).toEqual([775, 780]);
  });
});

describe('Integration: go-live dates', () => {
  it('sets, moves and removes a draft go-live date', async () => {
    const { summer } = await seedSchool();
    const draft = (await asAdmin('post', `${API}/schedules`).send({ name: 'Draft', sessions: [{ courseId: 'x', sessionIndex: 0, day: 1, startMin: 600, endMin: 645 }] })).body.data;

    const set = await asAdmin('put', `${API}/schedules/${draft.scheduleId}/go-live`).send({ goLiveOn: torontoDay(3) });
    expect(set.status).toBe(200);
    expect(set.body.data).toMatchObject({ goLiveOn: torontoDay(3), goLiveStatus: 'pending' });

    const moved = await asAdmin('put', `${API}/schedules/${draft.scheduleId}/go-live`).send({ goLiveOn: torontoDay(5) });
    expect(moved.body.data.goLiveOn).toBe(torontoDay(5));

    const cleared = await asAdmin('put', `${API}/schedules/${draft.scheduleId}/go-live`).send({ goLiveOn: null });
    expect(cleared.body.data).toMatchObject({ goLiveOn: null, goLiveStatus: null });

    expect((await asAdmin('put', `${API}/schedules/${draft.scheduleId}/go-live`).send({ goLiveOn: torontoDay(-2) })).status).toBe(400);
    expect((await asAdmin('put', `${API}/schedules/${draft.scheduleId}/go-live`).send({ goLiveOn: 'soon' })).status).toBe(400);
    expect((await asAdmin('put', `${API}/schedules/${draft.scheduleId}/go-live`).send({ goLiveOn: '2026-02-30' })).status).toBe(400);
    expect((await asAdmin('put', `${API}/schedules/${draft.scheduleId}/go-live`).send({ goLiveOn: '2026-13-01' })).status).toBe(400);
    expect((await asAdmin('put', `${API}/schedules/${summer.scheduleId}/go-live`).send({ goLiveOn: torontoDay(3) })).status).toBe(409);
  });

  it('allows one scheduled go-live per year', async () => {
    await seedSchool();
    const make = async (name) =>
      (await asAdmin('post', `${API}/schedules`).send({ name, sessions: [{ courseId: 'x', sessionIndex: 0, day: 1, startMin: 600, endMin: 645 }] })).body.data;
    const a = await make('A');
    const b = await make('B');
    await asAdmin('put', `${API}/schedules/${a.scheduleId}/go-live`).send({ goLiveOn: torontoDay(2) }).expect(200);
    const clash = await asAdmin('put', `${API}/schedules/${b.scheduleId}/go-live`).send({ goLiveOn: torontoDay(3) });
    expect(clash.status).toBe(409);
    expect(clash.body.message).toMatch(/already set to go live/);
  });

  it('marks a go-live that cannot publish as failed, and Retry clears it', async () => {
    const { summer } = await seedSchool();
    const pool = getTestPool();
    const { rows } = await pool.query(
      `INSERT INTO planner_schedules (school, name, sessions, school_year_id, go_live_on, go_live_status)
       SELECT school, 'Empty', '[]'::jsonb, school_year_id, $2::date, 'pending' FROM planner_schedules WHERE schedule_id = $1
       RETURNING schedule_id`,
      [summer.scheduleId, torontoDay(0)]
    );
    expect(await goLiveWorker.runOnce()).toEqual({ claimed: 1, published: 0 });
    const failed = (await asAdmin('get', `${API}/schedules`)).body.data.find((s) => s.scheduleId === rows[0].schedule_id);
    expect(failed).toMatchObject({ goLiveStatus: 'failed', goLiveError: 'Cannot publish an empty schedule' });
    expect((await asAdmin('get', `${API}/schedules`)).body.data.find((s) => s.scheduleId === summer.scheduleId).status).toBe('published');

    const retry = await asAdmin('put', `${API}/schedules/${rows[0].schedule_id}/go-live`).send({ goLiveOn: torontoDay(0) });
    expect(retry.body.data).toMatchObject({ goLiveStatus: 'pending', goLiveError: null });
  });

  it('is planner-only: teachers get 403', async () => {
    const { summer } = await seedSchool();
    expect((await asTeacher('get', `${API}/schedules/${summer.scheduleId}/retime`)).status).toBe(403);
    expect((await asTeacher('put', `${API}/schedules/${summer.scheduleId}/go-live`).send({ goLiveOn: null })).status).toBe(403);
  });
});
