// Integration: Schedule Planner config CRUD (settings, teachers, rooms,
// class groups, courses, day templates, fixed blocks) + admin gating.

const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const SCHOOL = 'ALHAADIACADEMY';

const asAdmin = (method, url) => authenticatedRequest(method, url);
const asTeacher = (method, url) =>
  authenticatedRequest(method, url, { role: 'TEACHER', userId: '550e8400-e29b-41d4-a716-446655440001' });

// Settings upsert now resolves the school's active school_years row (a
// NULL school_year_id would never match ON CONFLICT), so seed a school +
// an active year before exercising the settings endpoints.
//
// setupTestDB's global beforeEach already seeds a baseline ALHAADIACADEMY
// row (+ active school_year via trigger) so resolveSchoolYear doesn't 400
// pre-existing write-path tests; both inserts below upsert instead of
// plain-inserting so this doesn't collide with that baseline.
async function seedActiveSchoolYear() {
  const pool = getTestPool();
  const { rows } = await pool.query(
    `INSERT INTO schools (school_code, name, slug) VALUES ($1, 'Al Haadi Academy', 'al-haadi-academy')
     ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug
     RETURNING school_id`,
    [SCHOOL]
  );
  const schoolId = rows[0].school_id;
  await pool.query(
    `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
     VALUES ($1, $2, '2025-2026', '2025-09-01', '2026-06-30', TRUE)
     ON CONFLICT (school_id, label) DO UPDATE SET is_active = TRUE, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date`,
    [SCHOOL, schoolId]
  );
}

async function createTeacher(overrides = {}) {
  const res = await asAdmin('post', '/api/schedule-planner/teachers').send({
    displayName: 'Ms. X',
    isFullTime: true,
    maxWeeklyMinutes: 1200,
    dailySpareMinutes: 45,
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
  beforeEach(async () => {
    await seedActiveSchoolYear();
  });

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

  it('PATCHes settings twice without creating a duplicate row (ON CONFLICT requires a non-null school_year_id)', async () => {
    const firstPatch = await asAdmin('patch', '/api/schedule-planner/settings').send({
      defaultDurationMinutes: 60,
      snapMinutes: 10,
    });
    expect(firstPatch.status).toBe(200);
    expect(firstPatch.body.data.defaultDurationMinutes).toBe(60);
    expect(firstPatch.body.data.snapMinutes).toBe(10);

    const secondPatch = await asAdmin('patch', '/api/schedule-planner/settings').send({
      defaultDurationMinutes: 45,
      snapMinutes: 15,
    });
    expect(secondPatch.status).toBe(200);
    expect(secondPatch.body.data.defaultDurationMinutes).toBe(45);
    expect(secondPatch.body.data.snapMinutes).toBe(15);

    const pool = getTestPool();
    const { rows } = await pool.query(
      'SELECT count(*) FROM planner_settings WHERE school = $1',
      [SCHOOL]
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('rejects settings PATCH with 400 when no active school year is configured', async () => {
    // Deactivate the seeded year so the lookup finds nothing.
    const pool = getTestPool();
    await pool.query('UPDATE school_years SET is_active = FALSE WHERE school = $1', [SCHOOL]);

    const res = await asAdmin('patch', '/api/schedule-planner/settings').send({
      defaultDurationMinutes: 60,
      snapMinutes: 10,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      status: 'failed',
      message: 'No school year configured for your school',
    });
  });
});

describe('Integration: Planner teachers CRUD', () => {
  it('creates, lists, updates, and deletes a teacher with JSONB fields intact', async () => {
    const createRes = await createTeacher();
    expect(createRes.status).toBe(201);
    const teacher = createRes.body.data;
    expect(teacher.displayName).toBe('Ms. X');
    expect(teacher.dailySpareMinutes).toBe(45);
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

  it('manages fixed blocks, school-wide and multi-group scoped', async () => {
    const groupRes = await createClassGroup();
    const groupId = groupRes.body.data.classGroupId;
    const group2Res = await createClassGroup({ name: 'Grade 2' });
    const group2Id = group2Res.body.data.classGroupId;

    const schoolWide = await asAdmin('post', '/api/schedule-planner/fixed-blocks').send({
      label: 'Lunch',
      dayOfWeek: 1,
      startMin: 720,
      endMin: 760,
    });
    expect(schoolWide.status).toBe(201);
    expect(schoolWide.body.data.classGroupIds).toEqual([]);

    const scoped = await asAdmin('post', '/api/schedule-planner/fixed-blocks').send({
      label: 'Snack 2',
      dayOfWeek: 1,
      startMin: 600,
      endMin: 615,
      classGroupIds: [groupId, group2Id],
    });
    expect(scoped.status).toBe(201);
    expect(scoped.body.data.classGroupIds).toEqual([groupId, group2Id]);

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
