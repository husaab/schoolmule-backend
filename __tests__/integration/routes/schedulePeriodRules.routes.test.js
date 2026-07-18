// Integration: period rules CRUD + generate honoring a teach-rule and a
// teacher max-days cap end to end.

const { authenticatedRequest } = require('../setup/integrationApp');

const asAdmin = (method, url) => authenticatedRequest(method, url);

async function setupSchool() {
  const t1 = await asAdmin('post', '/api/schedule-planner/teachers').send({ displayName: 'Ms. X' });
  const t2 = await asAdmin('post', '/api/schedule-planner/teachers').send({ displayName: 'Mr. Y' });
  const g1 = await asAdmin('post', '/api/schedule-planner/class-groups').send({ name: 'Grade 1' });
  const teacher1 = t1.body.data.plannerTeacherId;
  const teacher2 = t2.body.data.plannerTeacherId;
  const group = g1.body.data.classGroupId;
  await asAdmin('post', `/api/schedule-planner/class-groups/${group}/courses`).send({
    name: 'Math', sessionsPerWeek: 2, maxPerDay: 1, assignedTeacherId: teacher1,
  });
  await asAdmin('post', `/api/schedule-planner/class-groups/${group}/courses`).send({
    name: 'English', sessionsPerWeek: 2, maxPerDay: 1, assignedTeacherId: teacher2,
  });
  await asAdmin('put', '/api/schedule-planner/day-templates').send({
    days: [
      { dayOfWeek: 1, fillableRanges: [{ startMin: 480, endMin: 560 }] },
      { dayOfWeek: 2, fillableRanges: [{ startMin: 480, endMin: 560 }] },
    ],
  });
  return { teacher1, teacher2, group };
}

describe('Integration: period rules', () => {
  it('CRUDs a rule and enforces it in generation', async () => {
    const { teacher1, group } = await setupSchool();

    // Ms. X must teach Grade 1's first period (480-520) both days
    const createRes = await asAdmin('post', '/api/schedule-planner/period-rules').send({
      teacherId: teacher1,
      classGroupId: group,
      kind: 'teach',
      startMin: 480,
      endMin: 520,
      minPerWeek: 2,
    });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.data.ruleId;

    const listRes = await asAdmin('get', '/api/schedule-planner/period-rules');
    expect(listRes.body.data).toHaveLength(1);

    const genRes = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 3, seed: 3, timeBudgetMs: 2000,
    });
    expect(genRes.status).toBe(200);
    for (const cand of genRes.body.data.candidates) {
      const firstSlots = cand.sessions.filter((s) => s.startMin < 520);
      expect(firstSlots.every((s) => s.teacherId === teacher1)).toBe(true);
    }

    const patchRes = await asAdmin('patch', `/api/schedule-planner/period-rules/${ruleId}`).send({
      minPerWeek: 1,
    });
    expect(patchRes.body.data.minPerWeek).toBe(1);

    const delRes = await asAdmin('delete', `/api/schedule-planner/period-rules/${ruleId}`);
    expect(delRes.status).toBe(200);
    const listRes2 = await asAdmin('get', '/api/schedule-planner/period-rules');
    expect(listRes2.body.data).toHaveLength(0);
  });

  it('enforces maxDaysPerWeek from teacher config', async () => {
    const { teacher2 } = await setupSchool();
    await asAdmin('patch', `/api/schedule-planner/teachers/${teacher2}`).send({
      maxDaysPerWeek: 1,
    });
    // Mr. Y teaches English x2 with maxPerDay 1 -> needs 2 days but capped at 1
    const genRes = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 2, seed: 4, timeBudgetMs: 1000,
    });
    expect(genRes.status).toBe(422);
  });

  it('rejects invalid rule payloads', async () => {
    const { teacher1 } = await setupSchool();
    const res = await asAdmin('post', '/api/schedule-planner/period-rules').send({
      teacherId: teacher1, kind: 'teach', startMin: 480, endMin: 520, minPerWeek: 2,
    });
    expect(res.status).toBe(400); // teach rule without classGroupId
  });
});
