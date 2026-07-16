// Integration: Schedule Planner config CRUD (settings, teachers, rooms,
// class groups, courses, day templates, fixed blocks) + admin gating.

const { authenticatedRequest } = require('../setup/integrationApp');

const SCHOOL = 'ALHAADIACADEMY';

const asAdmin = (method, url) => authenticatedRequest(method, url);
const asTeacher = (method, url) =>
  authenticatedRequest(method, url, { role: 'TEACHER', userId: '550e8400-e29b-41d4-a716-446655440001' });

async function createTeacher(overrides = {}) {
  const res = await asAdmin('post', '/api/schedule-planner/teachers').send({
    displayName: 'Ms. X',
    isFullTime: true,
    maxWeeklyMinutes: 1200,
    allowedDays: [1, 2, 3, 4, 5],
    excludedWindows: [{ day: 5, startMin: 720, endMin: 930 }],
    ...overrides,
  });
  return res;
}

async function createClassGroup(overrides = {}) {
  return asAdmin('post', '/api/schedule-planner/class-groups').send({
    name: 'Grade 1',
    grade: '1',
    sortOrder: 1,
    ...overrides,
  });
}

describe('Integration: Schedule Planner admin gating', () => {
  it('rejects non-admin users with 403 on every planner config route', async () => {
    const res = await asTeacher('get', '/api/schedule-planner/config');
    expect(res.status).toBe(403);
    const res2 = await asTeacher('post', '/api/schedule-planner/teachers');
    expect(res2.status).toBe(403);
  });
});

describe('Integration: Planner settings', () => {
  it('returns defaults when no settings row exists, and upserts on PATCH', async () => {
    const getRes = await asAdmin('get', '/api/schedule-planner/settings');
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.defaultDurationMinutes).toBe(40);
    expect(getRes.body.data.snapMinutes).toBe(5);

    const patchRes = await asAdmin('patch', '/api/schedule-planner/settings').send({
      defaultDurationMinutes: 60,
      snapMinutes: 10,
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.defaultDurationMinutes).toBe(60);

    const getRes2 = await asAdmin('get', '/api/schedule-planner/settings');
    expect(getRes2.body.data.defaultDurationMinutes).toBe(60);
    expect(getRes2.body.data.snapMinutes).toBe(10);
  });
});

describe('Integration: Planner teachers CRUD', () => {
  it('creates, lists, updates, and deletes a teacher with JSONB fields intact', async () => {
    const createRes = await createTeacher();
    expect(createRes.status).toBe(201);
    const teacher = createRes.body.data;
    expect(teacher.displayName).toBe('Ms. X');
    expect(teacher.allowedDays).toEqual([1, 2, 3, 4, 5]);
    expect(teacher.excludedWindows).toEqual([{ day: 5, startMin: 720, endMin: 930 }]);

    const listRes = await asAdmin('get', '/api/schedule-planner/teachers');
    expect(listRes.body.data).toHaveLength(1);

    const patchRes = await asAdmin(
      'patch',
      `/api/schedule-planner/teachers/${teacher.plannerTeacherId}`
    ).send({ maxWeeklyMinutes: 900, allowedDays: [1, 3, 5] });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.maxWeeklyMinutes).toBe(900);
    expect(patchRes.body.data.allowedDays).toEqual([1, 3, 5]);
    expect(patchRes.body.data.displayName).toBe('Ms. X'); // unchanged

    const delRes = await asAdmin(
      'delete',
      `/api/schedule-planner/teachers/${teacher.plannerTeacherId}`
    );
    expect(delRes.status).toBe(200);
    const listRes2 = await asAdmin('get', '/api/schedule-planner/teachers');
    expect(listRes2.body.data).toHaveLength(0);
  });

  it('rejects a duplicate display name within the school', async () => {
    await createTeacher();
    const dupRes = await createTeacher();
    expect(dupRes.status).toBe(409);
  });

  it('requires displayName', async () => {
    const res = await asAdmin('post', '/api/schedule-planner/teachers').send({});
    expect(res.status).toBe(400);
  });
});

describe('Integration: Planner rooms CRUD', () => {
  it('creates, lists, updates, deletes a room', async () => {
    const createRes = await asAdmin('post', '/api/schedule-planner/rooms').send({
      name: 'Gym',
      capacityNote: 'Fits two classes',
    });
    expect(createRes.status).toBe(201);
    const room = createRes.body.data;

    const patchRes = await asAdmin('patch', `/api/schedule-planner/rooms/${room.roomId}`).send({
      name: 'Gymnasium',
    });
    expect(patchRes.body.data.name).toBe('Gymnasium');
    expect(patchRes.body.data.capacityNote).toBe('Fits two classes');

    const delRes = await asAdmin('delete', `/api/schedule-planner/rooms/${room.roomId}`);
    expect(delRes.status).toBe(200);
    const listRes = await asAdmin('get', '/api/schedule-planner/rooms');
    expect(listRes.body.data).toHaveLength(0);
  });
});

describe('Integration: Class groups and courses', () => {
  it('manages class groups and nested course requirements', async () => {
    const teacherRes = await createTeacher();
    const teacherId = teacherRes.body.data.plannerTeacherId;

    const groupRes = await createClassGroup();
    expect(groupRes.status).toBe(201);
    const group = groupRes.body.data;

    const courseRes = await asAdmin(
      'post',
      `/api/schedule-planner/class-groups/${group.classGroupId}/courses`
    ).send({
      name: 'Math',
      sessionsPerWeek: 5,
      durationMinutes: 40,
      maxPerDay: 1,
      assignedTeacherId: teacherId,
    });
    expect(courseRes.status).toBe(201);
    const course = courseRes.body.data;
    expect(course.assignedTeacherId).toBe(teacherId);

    const patchRes = await asAdmin('patch', `/api/schedule-planner/courses/${course.courseId}`).send({
      sessionsPerWeek: 4,
    });
    expect(patchRes.body.data.sessionsPerWeek).toBe(4);
    expect(patchRes.body.data.name).toBe('Math');

    // Config endpoint nests courses under their group
    const configRes = await asAdmin('get', '/api/schedule-planner/config');
    expect(configRes.status).toBe(200);
    expect(configRes.body.data.classGroups).toHaveLength(1);
    expect(configRes.body.data.classGroups[0].courses).toHaveLength(1);
    expect(configRes.body.data.teachers).toHaveLength(1);

    // Deleting the group cascades to its courses
    await asAdmin('delete', `/api/schedule-planner/class-groups/${group.classGroupId}`);
    const configRes2 = await asAdmin('get', '/api/schedule-planner/config');
    expect(configRes2.body.data.classGroups).toHaveLength(0);
  });

  it('rejects a course with both an assigned teacher and a candidate pool', async () => {
    const teacherRes = await createTeacher();
    const teacherId = teacherRes.body.data.plannerTeacherId;
    const groupRes = await createClassGroup();
    const res = await asAdmin(
      'post',
      `/api/schedule-planner/class-groups/${groupRes.body.data.classGroupId}/courses`
    ).send({
      name: 'Math',
      sessionsPerWeek: 5,
      assignedTeacherId: teacherId,
      candidateTeacherIds: [teacherId],
    });
    expect(res.status).toBe(400);
  });
});

describe('Integration: Day templates and fixed blocks', () => {
  it('bulk-upserts day templates and reads them back', async () => {
    const putRes = await asAdmin('put', '/api/schedule-planner/day-templates').send({
      days: [
        { dayOfWeek: 1, fillableRanges: [{ startMin: 510, endMin: 930 }] },
        { dayOfWeek: 2, fillableRanges: [{ startMin: 510, endMin: 720 }, { startMin: 760, endMin: 930 }] },
      ],
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body.data).toHaveLength(2);

    // Re-PUT replaces
    const putRes2 = await asAdmin('put', '/api/schedule-planner/day-templates').send({
      days: [{ dayOfWeek: 1, fillableRanges: [{ startMin: 480, endMin: 900 }] }],
    });
    expect(putRes2.body.data).toHaveLength(1);

    const getRes = await asAdmin('get', '/api/schedule-planner/day-templates');
    expect(getRes.body.data).toHaveLength(1);
    expect(getRes.body.data[0].fillableRanges).toEqual([{ startMin: 480, endMin: 900 }]);
  });

  it('manages fixed blocks, school-wide and class-scoped', async () => {
    const groupRes = await createClassGroup();
    const groupId = groupRes.body.data.classGroupId;

    const schoolWide = await asAdmin('post', '/api/schedule-planner/fixed-blocks').send({
      label: 'Lunch',
      dayOfWeek: 1,
      startMin: 720,
      endMin: 760,
    });
    expect(schoolWide.status).toBe(201);
    expect(schoolWide.body.data.classGroupId).toBeNull();

    const scoped = await asAdmin('post', '/api/schedule-planner/fixed-blocks').send({
      label: 'Recess',
      dayOfWeek: 1,
      startMin: 600,
      endMin: 615,
      classGroupId: groupId,
    });
    expect(scoped.status).toBe(201);
    expect(scoped.body.data.classGroupId).toBe(groupId);

    const badRes = await asAdmin('post', '/api/schedule-planner/fixed-blocks').send({
      label: 'Broken',
      dayOfWeek: 1,
      startMin: 800,
      endMin: 700,
    });
    expect(badRes.status).toBe(400);

    const listRes = await asAdmin('get', '/api/schedule-planner/fixed-blocks');
    expect(listRes.body.data).toHaveLength(2);

    const delRes = await asAdmin(
      'delete',
      `/api/schedule-planner/fixed-blocks/${scoped.body.data.fixedBlockId}`
    );
    expect(delRes.status).toBe(200);
  });
});
