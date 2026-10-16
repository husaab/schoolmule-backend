// Classwork: items (assessment, assignment, quiz, material), topics,
// attachments, the assessment triggers + backfill, copy and duplicate, and
// the class-card reads that moved onto items. Synthetic identities only:
// every address is @example.com.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const fs = require('fs');
const path = require('path');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');
const scheduler = require('../../../services/classroom/scheduler');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const CO_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440002';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';

const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'teacher@example.com', role: 'TEACHER' };
const asCoTeacher = { userId: CO_TEACHER_ID, username: 'Omar Coteacher', email: 'omar.coteacher@example.com', role: 'TEACHER' };
const asOtherTeacher = { userId: OTHER_TEACHER_ID, username: 'Dina Teacher', email: 'dina.teacher@example.com', role: 'TEACHER' };
const asStudent = {
  userId: AMAL_USER_ID, username: 'Amal Haddad', email: 'amal.haddad@example.com', role: 'STUDENT', roles: ['STUDENT'],
};

const BASE = '/api/classroom';
const D2 = 'Add a category in Grades → Assessments & categories first, or fill an existing column.';
const GRADES_EXIST = 'This column already has published grades. Unpublish or clear them in Grades first.';
const MIGRATION = path.resolve(__dirname, '../../../database/migrations/student_portal_20_classwork.sql');

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString();
const torontoDay = (instant) => new Date(instant).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

describe('Integration: classwork', () => {
  let pool, yearId, termId;
  let sciId, mathId, amalId, samiId;
  let testsId, unit1Id, homeworkId, hwIds, quizzesId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, `${first} ${last}`, first, last, role],
  );
  const makeClass = async (subject, grade, teacherId, extra = {}) => (await pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id)
     VALUES ('ALHAADIACADEMY', $1, $2, 'Lead Name', $3, $4, 'Term 1', $5) RETURNING class_id`,
    [grade, subject, teacherId, extra.termId ?? termId, yearId],
  )).rows[0].class_id;
  const student = async (name, classId) => {
    const id = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ($1, '5', 'ALHAADIACADEMY', $2) RETURNING student_id`,
      [name, yearId],
    )).rows[0].student_id;
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, id]);
    return id;
  };
  // A gradebook row written straight to the table, as code on main does (the triggers fire).
  const assessment = async (classId, name, o = {}) => (await pool.query(
    `INSERT INTO assessments (class_id, name, parent_assessment_id, is_parent, weight_points, max_score, date, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING assessment_id`,
    [classId, name, o.parentId ?? null, o.isParent ?? false, o.weight ?? null, o.max ?? null, o.date ?? null, o.sort ?? 0],
  )).rows[0].assessment_id;
  const itemsOf = async (assessmentId) => (await pool.query(
    `SELECT * FROM classwork_items WHERE assessment_id = $1`, [assessmentId],
  )).rows;
  const weights = async (parentId) => (await pool.query(
    `SELECT assessment_id, name, weight_points::float AS w FROM assessments WHERE parent_assessment_id = $1 ORDER BY sort_order, created_at`,
    [parentId],
  )).rows;
  const topLevelTotal = async (classId) => Number((await pool.query(
    `SELECT COALESCE(SUM(weight_points), 0)::float AS t FROM assessments WHERE class_id = $1 AND parent_assessment_id IS NULL`, [classId],
  )).rows[0].t);
  const sum = (rows) => Math.round(rows.reduce((s, r) => s + r.w, 0) * 100) / 100;

  const call = (method, url, who = asTeacher) => authenticatedRequest(method, url, who);
  const createItem = async (classId, body, who = asTeacher) => {
    const res = await call('post', `${BASE}/classes/${classId}/items`, who).send(body);
    if (res.status !== 201) throw new Error(`create failed ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const homeworkAssignment = (extra = {}) => ({
    kind: 'assignment', title: 'Plant cell diagram', instructions: 'Label six parts.', submissionMode: 'file',
    dueAt: inDays(2), gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 }, ...extra,
  });

  beforeEach(async () => {
    supabase._reset();
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', 'Term 1', DATE '2026-09-01', DATE '2027-01-31', TRUE, $1) RETURNING term_id`, [yearId],
    )).rows[0].term_id;

    await user(ADMIN_ID, 'office@example.com', 'Office', 'Admin', 'ADMIN');
    await user(TEACHER_ID, 'teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(CO_TEACHER_ID, 'omar.coteacher@example.com', 'Omar', 'Coteacher', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina', 'Teacher', 'TEACHER');

    sciId = await makeClass('Science', '5', TEACHER_ID);
    await pool.query(`INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)`, [sciId, CO_TEACHER_ID]);
    mathId = await makeClass('Math', '5', OTHER_TEACHER_ID);
    amalId = await student('Amal Haddad', sciId);
    samiId = await student('Sami Haddad', sciId);

    // Science totals 100: Tests 40 (one column), Homework 20 (four of 5), Quizzes 40 (empty).
    testsId = await assessment(sciId, 'Tests', { isParent: true, weight: 40, sort: 1 });
    unit1Id = await assessment(sciId, 'Unit 1 test', { parentId: testsId, weight: 40, max: 30, sort: 1 });
    homeworkId = await assessment(sciId, 'Homework', { isParent: true, weight: 20, sort: 2 });
    hwIds = [];
    for (let i = 1; i <= 4; i++) hwIds.push(await assessment(sciId, `Homework ${i}`, { parentId: homeworkId, weight: 5, max: 10, sort: i }));
    quizzesId = await assessment(sciId, 'Quizzes', { isParent: true, weight: 40, sort: 3 });
  });

  describe('assessment triggers', () => {
    it("inserting a leaf assessment creates one posted kind='assessment' item; a category creates none; deleting the assessment removes the item", async () => {
      // Main's own create path.
      const res = await call('post', '/api/assessments', asAdmin).send({ classId: mathId, name: 'Pop quiz', maxScore: 10, weightPoints: 10 });
      expect(res.status).toBe(201);
      const popId = res.body.data.assessmentId;
      const rows = await itemsOf(popId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ class_id: mathId, kind: 'assessment', status: 'posted', submission_mode: 'none', topic_id: null, title: null });
      expect(rows[0].posted_at).not.toBeNull();

      // A category with children (main's createParentWithChildren): the children get items, the category none.
      const cat = await call('post', '/api/assessments', asAdmin).send({ classId: mathId, name: 'Projects', isParent: true, childCount: 2, weightPoints: 20 });
      expect(cat.status).toBe(201);
      expect(await itemsOf(cat.body.data.parent.assessmentId)).toHaveLength(0);
      for (const c of cat.body.data.children) expect(await itemsOf(c.assessmentId)).toHaveLength(1);

      // Categories seeded in beforeEach have none; their leaves have one each.
      expect(await itemsOf(homeworkId)).toHaveLength(0);
      for (const id of hwIds) expect(await itemsOf(id)).toHaveLength(1);

      const del = await call('delete', `/api/assessments/${popId}`, asAdmin);
      expect(del.status).toBe(200);
      // The row itself is gone (not just unlinked by the foreign key).
      expect((await pool.query(`SELECT 1 FROM classwork_items WHERE item_id = $1`, [rows[0].item_id])).rows).toHaveLength(0);
    });

    it('accepts every row shape main writes: a NULL is_parent, batch creates and deletes, deleting a category with children', async () => {
      const nullParent = (await pool.query(
        `INSERT INTO assessments (class_id, name, is_parent) VALUES ($1, 'Legacy column', NULL) RETURNING assessment_id`, [mathId],
      )).rows[0].assessment_id;
      expect(await itemsOf(nullParent)).toHaveLength(1);

      const batch = await call('patch', '/api/assessments/batch', asAdmin).send({
        deleteIds: [hwIds[3]],
        creates: [{ classId: sciId, name: 'Homework 5', parentAssessmentId: homeworkId, weightPoints: 5, maxScore: 10, sortOrder: 5 }],
        updates: [{ assessmentId: hwIds[0], name: 'Homework one', weightPoints: 5 }],
      });
      expect(batch.status).toBe(200);
      expect(await itemsOf(hwIds[3])).toHaveLength(0);
      expect(await itemsOf(batch.body.created[0].assessmentId)).toHaveLength(1);

      // Deleting a category cascades to its columns; each column's item goes too.
      const del = await call('delete', `/api/assessments/${homeworkId}`, asAdmin);
      expect(del.status).toBe(200);
      const left = await pool.query(`SELECT COUNT(*)::int AS n FROM classwork_items WHERE class_id = $1`, [sciId]);
      expect(left.rows[0].n).toBe(1); // Unit 1 test
    });

    it('turning a standalone into a category removes its item', async () => {
      const standalone = await assessment(mathId, 'Midterm', { weight: 30, max: 50 });
      expect(await itemsOf(standalone)).toHaveLength(1);

      const res = await call('patch', `/api/assessments/${standalone}`, asAdmin).send({ isParent: true });
      expect(res.status).toBe(200);
      expect(await itemsOf(standalone)).toHaveLength(0);

      // And back to a leaf: one item again.
      await pool.query(`UPDATE assessments SET is_parent = FALSE WHERE assessment_id = $1`, [standalone]);
      expect(await itemsOf(standalone)).toHaveLength(1);
      // A rename that leaves is_parent alone does not touch the item.
      const renamed = await call('patch', `/api/assessments/${standalone}`, asAdmin).send({ name: 'Midterm exam' });
      expect(renamed.status).toBe(200);
      expect(await itemsOf(standalone)).toHaveLength(1);
    });

    it('an assignment whose column becomes a category keeps its row but loses the link', async () => {
      const item = await createItem(sciId, homeworkAssignment());
      await pool.query(`UPDATE assessments SET is_parent = TRUE WHERE assessment_id = $1`, [item.gradebook.assessmentId]);
      const row = (await pool.query(`SELECT * FROM classwork_items WHERE item_id = $1`, [item.itemId])).rows[0];
      expect(row).toMatchObject({ kind: 'assignment', assessment_id: null, deleted_at: null });
    });

    it('deleting a class with classwork removes all of it', async () => {
      const topic = await call('post', `${BASE}/classes/${sciId}/topics`).send({ name: 'Unit 2 · Cells' });
      const item = await createItem(sciId, homeworkAssignment({ topicId: topic.body.data.topicId }));
      await createItem(sciId, { kind: 'material', title: 'Cells reading' });
      await call('post', `${BASE}/items/${item.itemId}/links`).send({ title: 'Cells', url: 'https://example.com/cells' });

      const res = await call('delete', `/api/classes/${sciId}`, asAdmin);
      expect(res.status).toBe(200);
      for (const t of ['classwork_items', 'classwork_topics']) {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE class_id = $1`, [sciId]);
        expect(rows[0].n).toBe(0);
      }
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM classwork_attachments`)).rows[0].n).toBe(0);
    });

    it('the migration re-runs cleanly and backfills each missing leaf exactly once', async () => {
      // Rows that predate the triggers: drop the items the triggers made.
      await pool.query(`DELETE FROM classwork_items`);
      const sql = fs.readFileSync(MIGRATION, 'utf8');
      try {
        await pool.query(sql);
        await pool.query(sql);
      } finally {
        // The test schema is seeded without RLS (migration-only); put it back.
        await pool.query(`ALTER TABLE classwork_topics DISABLE ROW LEVEL SECURITY;
          ALTER TABLE classwork_items DISABLE ROW LEVEL SECURITY;
          ALTER TABLE classwork_item_students DISABLE ROW LEVEL SECURITY;
          ALTER TABLE classwork_attachments DISABLE ROW LEVEL SECURITY;`);
      }
      const { rows } = await pool.query(
        `SELECT a.assessment_id, a.name, COUNT(i.item_id)::int AS n, MAX(i.kind) AS kind, MAX(i.status) AS status,
                BOOL_AND(i.created_by = $2) AS by_teacher
         FROM assessments a LEFT JOIN classwork_items i ON i.assessment_id = a.assessment_id
         WHERE a.class_id = $1 GROUP BY a.assessment_id, a.name ORDER BY a.name`,
        [sciId, TEACHER_ID],
      );
      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
      for (const name of ['Homework 1', 'Homework 2', 'Homework 3', 'Homework 4', 'Unit 1 test']) {
        expect(byName[name]).toMatchObject({ n: 1, kind: 'assessment', status: 'posted', by_teacher: true });
      }
      for (const name of ['Tests', 'Homework', 'Quizzes']) expect(byName[name].n).toBe(0);

      // The triggers still work after the re-run.
      const fresh = await assessment(sciId, 'After re-run', { parentId: quizzesId, weight: 40, max: 10 });
      expect(await itemsOf(fresh)).toHaveLength(1);
    });
  });

  describe('items', () => {
    it('creating an assignment under Homework adds a child column and rescales siblings so the class still totals 100', async () => {
      const dueAt = inDays(2);
      const item = await createItem(sciId, homeworkAssignment({ dueAt }));

      expect(item).toMatchObject({
        classId: sciId, kind: 'assignment', title: 'Plant cell diagram', instructions: 'Label six parts.',
        status: 'posted', effectiveStatus: 'posted', submissionMode: 'file', audience: 'all', topicId: null,
        dueAt: new Date(dueAt).toISOString(), date: torontoDay(dueAt), attachmentCount: 0, attachments: [], studentIds: [],
        emailStudents: true, remindStudents: true, showEarly: false, classAvgPct: null,
        counts: { turnedIn: 0, missing: 0, notYet: 0, toReview: 0, drafts: 0, published: 0 },
      });
      expect(item.postedAt).not.toBeNull();
      expect(item.gradebook).toMatchObject({
        categoryId: homeworkId, categoryName: 'Homework', maxScore: 10, weightPoints: 4, isPublished: false, scoreCount: 0,
      });

      const hw = await weights(homeworkId);
      expect(hw.map((r) => r.w)).toEqual([4, 4, 4, 4, 4]);
      expect(sum(hw)).toBe(20);
      expect(await topLevelTotal(sciId)).toBe(100);

      const rows = await itemsOf(item.gradebook.assessmentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ item_id: item.itemId, kind: 'assignment', title: null, created_by: TEACHER_ID });
      const col = (await pool.query(`SELECT name, TO_CHAR(date, 'YYYY-MM-DD') AS d FROM assessments WHERE assessment_id = $1`,
        [item.gradebook.assessmentId])).rows[0];
      expect(col).toEqual({ name: 'Plant cell diagram', d: torontoDay(dueAt) });
    });

    it('a plain assessment under a category takes the date and shows its class average once published', async () => {
      const item = await createItem(sciId, {
        kind: 'assessment', title: 'Unit 2 test', date: '2026-10-23', showEarly: true,
        gradebook: { mode: 'category', categoryId: testsId, maxScore: 30 },
      });
      expect(item).toMatchObject({ kind: 'assessment', date: '2026-10-23', dueAt: null, submissionMode: 'none', showEarly: true });
      expect((await weights(testsId)).map((r) => r.w)).toEqual([20, 20]);

      const a = item.gradebook.assessmentId;
      await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $3, 24, 'graded'), ($2, $3, NULL, 'missing')`,
        [amalId, samiId, a]);
      await pool.query(`UPDATE assessments SET is_published = TRUE WHERE assessment_id = $1`, [a]);
      const res = await call('get', `${BASE}/items/${item.itemId}`);
      expect(res.body.data.classAvgPct).toBe(40); // (80% + 0%) / 2
      expect(res.body.data.gradebook).toMatchObject({ isPublished: true, scoreCount: 2 });
    });

    it("creating with gradebook 'existing' converts that column's item in place (still one item per assessment)", async () => {
      const before = await itemsOf(hwIds[1]);
      const dueAt = inDays(3);
      const item = await createItem(sciId, {
        kind: 'quiz', title: 'Cells quiz', dueAt, gradebook: { mode: 'existing', assessmentId: hwIds[1] },
      });
      const after = await itemsOf(hwIds[1]);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ item_id: before[0].item_id, kind: 'quiz', title: null, submission_mode: 'none' });
      expect(item).toMatchObject({ itemId: before[0].item_id, kind: 'quiz', title: 'Cells quiz' });
      expect(item.gradebook).toMatchObject({ assessmentId: hwIds[1], categoryName: 'Homework', weightPoints: 5 });
      // The column is no longer offered to fill.
      const list = await call('get', `${BASE}/classes/${sciId}/items`);
      expect(list.body.data.linkableColumns.map((c) => c.assessmentId)).not.toContain(hwIds[1]);
      const again = await call('post', `${BASE}/classes/${sciId}/items`).send({
        kind: 'assignment', title: 'Second claim', gradebook: { mode: 'existing', assessmentId: hwIds[1] },
      });
      expect(again.status).toBe(400);
    });

    it('creating a material has no assessment and no due date', async () => {
      const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM assessments`)).rows[0].n;
      const item = await createItem(sciId, {
        kind: 'material', title: 'Cells reading, pages 42–47', dueAt: inDays(1), submissionMode: 'file',
        gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 },
      });
      expect(item).toMatchObject({ kind: 'material', gradebook: null, dueAt: null, submissionMode: 'none', title: 'Cells reading, pages 42–47' });
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM assessments`)).rows[0].n).toBe(before);
      const row = (await pool.query(`SELECT title, assessment_id FROM classwork_items WHERE item_id = $1`, [item.itemId])).rows[0];
      expect(row).toEqual({ title: 'Cells reading, pages 42–47', assessment_id: null });
    });

    it('kind assessment without a category is 400 with the D2 message', async () => {
      const res = await call('post', `${BASE}/classes/${mathId}/items`, asOtherTeacher).send({ kind: 'assessment', title: 'Fractions test' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(D2);
    });

    it('scheduled needs a future publishAt; promoteScheduledItems posts it once it is due', async () => {
      const missing = await call('post', `${BASE}/classes/${sciId}/items`).send({ kind: 'material', title: 'Later', status: 'scheduled' });
      expect(missing.status).toBe(400);
      const past = await call('post', `${BASE}/classes/${sciId}/items`).send({
        kind: 'material', title: 'Later', status: 'scheduled', publishAt: inDays(-1),
      });
      expect(past.status).toBe(400);

      const publishAt = inDays(1);
      const item = await createItem(sciId, { kind: 'material', title: 'Later', status: 'scheduled', publishAt });
      expect(item).toMatchObject({ status: 'scheduled', effectiveStatus: 'scheduled', publishAt: new Date(publishAt).toISOString(), postedAt: null });
      expect(await scheduler.promoteScheduledItems()).toEqual([]);

      await pool.query(`UPDATE classwork_items SET publish_at = NOW() - INTERVAL '1 minute' WHERE item_id = $1`, [item.itemId]);
      const due = (await call('get', `${BASE}/items/${item.itemId}`)).body.data;
      expect(due).toMatchObject({ status: 'scheduled', effectiveStatus: 'posted' });
      expect(due.postedAt).toBe(due.publishAt);

      expect(await scheduler.promoteScheduledItems()).toEqual([{ item_id: item.itemId, class_id: sciId }]);
      const row = (await pool.query(`SELECT status, posted_at = publish_at AS same FROM classwork_items WHERE item_id = $1`, [item.itemId])).rows[0];
      expect(row).toEqual({ status: 'posted', same: true });
      expect(await scheduler.promoteScheduledItems()).toEqual([]);
    });

    it('PATCH title of a linked item renames the gradebook column', async () => {
      const item = await createItem(sciId, homeworkAssignment());
      const res = await call('patch', `${BASE}/items/${item.itemId}`).send({ title: '  Labelled plant cell ' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ title: 'Labelled plant cell', kind: 'assignment' });
      expect(res.body.data.editedAt).not.toBeNull();
      const col = (await pool.query(`SELECT name FROM assessments WHERE assessment_id = $1`, [item.gradebook.assessmentId])).rows[0];
      expect(col.name).toBe('Labelled plant cell');
      const row = (await pool.query(`SELECT title FROM classwork_items WHERE item_id = $1`, [item.itemId])).rows[0];
      expect(row.title).toBeNull();

      // A legacy plain assessment (trigger-made, outside any category flow) is renamed the same way.
      const legacy = (await itemsOf(unit1Id))[0];
      const renamed = await call('patch', `${BASE}/items/${legacy.item_id}`).send({ title: 'Unit 1 exam', instructions: 'Bring a pencil.' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data).toMatchObject({ title: 'Unit 1 exam', instructions: 'Bring a pencil.', kind: 'assessment' });
    });

    it('PATCH status: draft → posted sets postedAt; content-free changes leave editedAt alone', async () => {
      const item = await createItem(sciId, { kind: 'material', title: 'Notes', status: 'draft' });
      expect(item.postedAt).toBeNull();
      const res = await call('patch', `${BASE}/items/${item.itemId}`).send({ status: 'posted' });
      expect(res.body.data.status).toBe('posted');
      expect(res.body.data.postedAt).not.toBeNull();
      expect(res.body.data.editedAt).toBeNull();
    });

    it('PATCH moving to another category rescales both', async () => {
      const item = await createItem(sciId, homeworkAssignment());
      const res = await call('patch', `${BASE}/items/${item.itemId}`).send({
        gradebook: { mode: 'category', categoryId: quizzesId, maxScore: 15 },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.gradebook).toMatchObject({ assessmentId: item.gradebook.assessmentId, categoryId: quizzesId, maxScore: 15, weightPoints: 40 });
      expect((await weights(homeworkId)).map((r) => r.w)).toEqual([5, 5, 5, 5]);
      expect((await weights(quizzesId)).map((r) => r.w)).toEqual([40]);
      expect(await topLevelTotal(sciId)).toBe(100);
    });

    it('PATCH gradebook none is 409 once scores exist', async () => {
      const item = await createItem(sciId, homeworkAssignment());
      await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, 8)`, [amalId, item.gradebook.assessmentId]);
      const res = await call('patch', `${BASE}/items/${item.itemId}`).send({ gradebook: { mode: 'none' } });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe(GRADES_EXIST);
      expect(await itemsOf(item.gradebook.assessmentId)).toHaveLength(1);

      // Without grades the column goes, the item keeps its name, Homework refills.
      await pool.query(`DELETE FROM student_assessments`);
      const ok = await call('patch', `${BASE}/items/${item.itemId}`).send({ gradebook: { mode: 'none' } });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ gradebook: null, title: 'Plant cell diagram', kind: 'assignment' });
      expect((await pool.query(`SELECT 1 FROM assessments WHERE assessment_id = $1`, [item.gradebook.assessmentId])).rows).toHaveLength(0);
      expect((await weights(homeworkId)).map((r) => r.w)).toEqual([5, 5, 5, 5]);

      // And back under a category: a new column, still one item.
      const back = await call('patch', `${BASE}/items/${item.itemId}`).send({ gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 } });
      expect(back.status).toBe(200);
      expect(back.body.data.gradebook).toMatchObject({ categoryId: homeworkId, weightPoints: 4 });
      expect(await itemsOf(back.body.data.gradebook.assessmentId)).toEqual([expect.objectContaining({ item_id: item.itemId, title: null })]);
    });

    it('DELETE a linked assignment removes its column and scores and rescales the category', async () => {
      const item = await createItem(sciId, homeworkAssignment());
      const columnId = item.gradebook.assessmentId;
      await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, 8)`, [amalId, columnId]);
      expect((await call('get', `${BASE}/items/${item.itemId}`)).body.data.gradebook.scoreCount).toBe(1);

      const res = await call('delete', `${BASE}/items/${item.itemId}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ deleted: true, removedColumn: true });
      expect((await pool.query(`SELECT 1 FROM assessments WHERE assessment_id = $1`, [columnId])).rows).toHaveLength(0);
      expect((await pool.query(`SELECT 1 FROM student_assessments WHERE assessment_id = $1`, [columnId])).rows).toHaveLength(0);
      expect((await weights(homeworkId)).map((r) => r.w)).toEqual([5, 5, 5, 5]);
      const row = (await pool.query(`SELECT assessment_id, deleted_at FROM classwork_items WHERE item_id = $1`, [item.itemId])).rows[0];
      expect(row.assessment_id).toBeNull();
      expect(row.deleted_at).not.toBeNull();
      expect((await call('get', `${BASE}/items/${item.itemId}`)).status).toBe(404);

      // A plain assessment's row goes with its column.
      const plain = (await itemsOf(hwIds[0]))[0];
      const del = await call('delete', `${BASE}/items/${plain.item_id}`);
      expect(del.body.data).toEqual({ deleted: true, removedColumn: true });
      expect((await pool.query(`SELECT 1 FROM classwork_items WHERE item_id = $1`, [plain.item_id])).rows).toHaveLength(0);
      expect(sum(await weights(homeworkId))).toBe(20);

      // An ungraded item is only hidden.
      const material = await createItem(sciId, { kind: 'material', title: 'Reading' });
      const gone = await call('delete', `${BASE}/items/${material.itemId}`);
      expect(gone.body.data).toEqual({ deleted: true, removedColumn: false });
      const list = (await call('get', `${BASE}/classes/${sciId}/items`)).body.data.items;
      expect(list.map((i) => i.itemId)).not.toContain(material.itemId);
    });

    it('GET items lists topics, items, categories and linkable columns, filtered by topic and kind', async () => {
      const topic = (await call('post', `${BASE}/classes/${sciId}/topics`).send({ name: 'Unit 2 · Cells' })).body.data;
      const a = await createItem(sciId, homeworkAssignment({ topicId: topic.topicId }));
      await createItem(sciId, { kind: 'material', title: 'Reading' });

      const all = (await call('get', `${BASE}/classes/${sciId}/items`)).body.data;
      expect(all.topics).toEqual([{ topicId: topic.topicId, name: 'Unit 2 · Cells', sortOrder: 0, itemCount: 1 }]);
      expect(all.items).toHaveLength(7); // 5 legacy columns + 2
      expect(all.categories).toEqual([
        { assessmentId: testsId, name: 'Tests', weightPoints: 40, childCount: 1 },
        { assessmentId: homeworkId, name: 'Homework', weightPoints: 20, childCount: 5 },
        { assessmentId: quizzesId, name: 'Quizzes', weightPoints: 40, childCount: 0 },
      ]);
      expect(all.linkableColumns.map((c) => c.assessmentId)).toEqual(expect.arrayContaining([unit1Id, ...hwIds]));
      expect(all.linkableColumns.map((c) => c.assessmentId)).not.toContain(a.gradebook.assessmentId);
      expect(all.linkableColumns.find((c) => c.assessmentId === unit1Id)).toEqual({
        assessmentId: unit1Id, name: 'Unit 1 test', categoryName: 'Tests', maxScore: 30,
      });

      const inTopic = (await call('get', `${BASE}/classes/${sciId}/items?topic=${topic.topicId}`)).body.data.items;
      expect(inTopic.map((i) => i.itemId)).toEqual([a.itemId]);
      const noTopic = (await call('get', `${BASE}/classes/${sciId}/items?topic=none`)).body.data.items;
      expect(noTopic).toHaveLength(6);
      const materials = (await call('get', `${BASE}/classes/${sciId}/items?kind=material`)).body.data.items;
      expect(materials.map((i) => i.title)).toEqual(['Reading']);
      const bad = await call('get', `${BASE}/classes/${sciId}/items?kind=essay`);
      expect(bad.status).toBe(400);
    });

    it('audience some keeps the chosen students and refuses a student from another class', async () => {
      const other = await student('Noor Saleh', mathId);
      const refused = await call('post', `${BASE}/classes/${sciId}/items`).send({
        kind: 'material', title: 'Extra reading', audience: 'some', studentIds: [amalId, other],
      });
      expect(refused.status).toBe(400);
      const item = await createItem(sciId, { kind: 'material', title: 'Extra reading', audience: 'some', studentIds: [amalId.toUpperCase()] });
      expect(item).toMatchObject({ audience: 'some', studentIds: [amalId] });
      const back = await call('patch', `${BASE}/items/${item.itemId}`).send({ audience: 'all' });
      expect(back.body.data).toMatchObject({ audience: 'all', studentIds: [] });
    });

    it('a co-teacher and an admin may create; a teacher of another class may not', async () => {
      await createItem(sciId, { kind: 'material', title: 'From the co-teacher' }, asCoTeacher);
      await createItem(sciId, { kind: 'material', title: 'From the office' }, asAdmin);
      const res = await call('post', `${BASE}/classes/${sciId}/items`, asOtherTeacher).send({ kind: 'material', title: 'Nope' });
      expect(res.status).toBe(403);
    });
  });

  describe('attachments', () => {
    it('attachments: upload (storage mock), add link with YouTube id, edit title/url, replace file, delete, signed url', async () => {
      const item = await createItem(sciId, homeworkAssignment());
      const up = await call('post', `${BASE}/items/${item.itemId}/attachments`)
        .attach('files', Buffer.from('%PDF-1.4 checklist'), { filename: 'cell-parts-checklist.pdf', contentType: 'application/pdf' })
        .attach('files', Buffer.from('fake png bytes'), { filename: 'example-plant-cell.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      expect(up.body.data).toEqual([
        expect.objectContaining({ kind: 'file', fileName: 'cell-parts-checklist.pdf', mimeType: 'application/pdf', sizeBytes: 18, title: null, youtubeId: null }),
        expect.objectContaining({ kind: 'file', fileName: 'example-plant-cell.png', mimeType: 'image/png' }),
      ]);
      const uploadedPath = supabase._mockStorage.upload.mock.calls[0][0];
      expect(uploadedPath).toMatch(new RegExp(`^ALHAADIACADEMY/classwork/${item.itemId}/[0-9a-f-]{36}\\.pdf$`));
      const pdf = up.body.data[0];

      const badType = await call('post', `${BASE}/items/${item.itemId}/attachments`)
        .attach('files', Buffer.from('MZ'), { filename: 'setup.exe', contentType: 'application/x-msdownload' });
      expect(badType.status).toBe(400);

      const link = await call('post', `${BASE}/items/${item.itemId}/links`).send({ title: 'Cells video', url: 'https://youtu.be/dQw4w9WgXcQ?t=42' });
      expect(link.status).toBe(201);
      expect(link.body.data).toMatchObject({ kind: 'link', title: 'Cells video', url: 'https://youtu.be/dQw4w9WgXcQ?t=42', youtubeId: 'dQw4w9WgXcQ', fileName: null });
      const ftp = await call('post', `${BASE}/items/${item.itemId}/links`).send({ title: 'x', url: 'ftp://example.com/file' });
      expect(ftp.status).toBe(400);

      const edited = await call('patch', `${BASE}/attachments/${link.body.data.attachmentId}`)
        .send({ title: 'Plant cells', url: 'https://www.youtube.com/watch?v=abcdefghijk' });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({ title: 'Plant cells', youtubeId: 'abcdefghijk' });
      const fileUrl = await call('patch', `${BASE}/attachments/${pdf.attachmentId}`).send({ url: 'https://example.com/x' });
      expect(fileUrl.status).toBe(400);
      const fileTitle = await call('patch', `${BASE}/attachments/${pdf.attachmentId}`).send({ title: 'Checklist' });
      expect(fileTitle.body.data).toMatchObject({ title: 'Checklist', fileName: 'cell-parts-checklist.pdf' });

      supabase._mockStorage.remove.mockClear();
      const replaced = await call('put', `${BASE}/attachments/${pdf.attachmentId}/file`)
        .attach('file', Buffer.from('%PDF-1.4 v2'), { filename: 'checklist-v2.pdf', contentType: 'application/pdf' });
      expect(replaced.status).toBe(200);
      expect(replaced.body.data).toMatchObject({ attachmentId: pdf.attachmentId, fileName: 'checklist-v2.pdf', sizeBytes: 11, title: 'Checklist' });
      expect(supabase._mockStorage.remove).toHaveBeenCalledWith([uploadedPath]);

      const signed = await call('get', `${BASE}/attachments/${pdf.attachmentId}/url`);
      expect(signed.body.data).toEqual({ url: 'https://mock-signed-url.com' });
      const linkUrl = await call('get', `${BASE}/attachments/${link.body.data.attachmentId}/url`);
      expect(linkUrl.body.data).toEqual({ url: 'https://www.youtube.com/watch?v=abcdefghijk' });

      const full = (await call('get', `${BASE}/items/${item.itemId}`)).body.data;
      expect(full.attachmentCount).toBe(3);
      expect(full.attachments.map((a) => a.kind)).toEqual(['file', 'file', 'link']);
      expect(full.editedAt).not.toBeNull();

      const del = await call('delete', `${BASE}/attachments/${pdf.attachmentId}`);
      expect(del.body.data).toEqual({ deleted: true });
      expect((await call('get', `${BASE}/items/${item.itemId}`)).body.data.attachmentCount).toBe(2);
      expect((await call('get', `${BASE}/attachments/${pdf.attachmentId}/url`)).status).toBe(404);
    });

    it('a failed storage upload stores nothing', async () => {
      const item = await createItem(sciId, { kind: 'material', title: 'Reading' });
      supabase._mockStorage.upload
        .mockResolvedValueOnce({ data: { path: 'ok' }, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: 'storage down' } });
      const res = await call('post', `${BASE}/items/${item.itemId}/attachments`)
        .attach('files', Buffer.from('one'), { filename: 'one.pdf', contentType: 'application/pdf' })
        .attach('files', Buffer.from('two'), { filename: 'two.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(500);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM classwork_attachments`)).rows[0].n).toBe(0);
      expect(supabase._mockStorage.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe('topics', () => {
    it('topics: create, rename, reorder, delete (items keep, topic NULL)', async () => {
      const t1 = await call('post', `${BASE}/classes/${sciId}/topics`).send({ name: 'Unit 1 · Matter' });
      expect(t1.status).toBe(201);
      const t2 = await call('post', `${BASE}/classes/${sciId}/topics`).send({ name: 'Unit 2 · Cells' });
      expect(t2.body.data).toEqual({ topicId: expect.any(String), name: 'Unit 2 · Cells', sortOrder: 1, itemCount: 0 });
      expect((await call('post', `${BASE}/classes/${sciId}/topics`).send({ name: '   ' })).status).toBe(400);
      expect((await call('post', `${BASE}/classes/${sciId}/topics`).send({ name: 'x'.repeat(81) })).status).toBe(400);

      const renamed = await call('patch', `${BASE}/topics/${t1.body.data.topicId}`).send({ name: 'Unit 1 · States of matter' });
      expect(renamed.body.data.name).toBe('Unit 1 · States of matter');

      const order = await call('post', `${BASE}/classes/${sciId}/topics/reorder`).send({ topicIds: [t2.body.data.topicId, t1.body.data.topicId] });
      expect(order.status).toBe(200);
      expect(order.body.data.map((t) => [t.name, t.sortOrder])).toEqual([['Unit 2 · Cells', 0], ['Unit 1 · States of matter', 1]]);
      const foreign = await call('post', `${BASE}/classes/${sciId}/topics/reorder`).send({ topicIds: [t2.body.data.topicId, mathId] });
      expect(foreign.status).toBe(400);

      const item = await createItem(sciId, { kind: 'material', title: 'Reading', topicId: t2.body.data.topicId });
      const listed = (await call('get', `${BASE}/classes/${sciId}/topics`)).body.data;
      expect(listed.find((t) => t.topicId === t2.body.data.topicId).itemCount).toBe(1);

      const del = await call('delete', `${BASE}/topics/${t2.body.data.topicId}`);
      expect(del.body.data).toEqual({ deleted: true });
      const after = (await call('get', `${BASE}/items/${item.itemId}`)).body.data;
      expect(after.topicId).toBeNull();
      expect((await call('get', `${BASE}/classes/${sciId}/topics`)).body.data.map((t) => t.name)).toEqual(['Unit 1 · States of matter']);
    });
  });

  describe('authorization', () => {
    it('another teacher gets 403 on every item/topic/attachment route; a student token gets STUDENT_FORBIDDEN', async () => {
      const item = await createItem(sciId, homeworkAssignment());
      const topic = (await call('post', `${BASE}/classes/${sciId}/topics`).send({ name: 'Unit 2' })).body.data;
      const link = (await call('post', `${BASE}/items/${item.itemId}/links`).send({ title: 'x', url: 'https://example.com' })).body.data;
      const routes = [
        ['get', `${BASE}/classes/${sciId}/items`],
        ['post', `${BASE}/classes/${sciId}/items`],
        ['get', `${BASE}/items/${item.itemId}`],
        ['patch', `${BASE}/items/${item.itemId}`],
        ['delete', `${BASE}/items/${item.itemId}`],
        ['get', `${BASE}/classes/${sciId}/topics`],
        ['post', `${BASE}/classes/${sciId}/topics`],
        ['patch', `${BASE}/topics/${topic.topicId}`],
        ['delete', `${BASE}/topics/${topic.topicId}`],
        ['post', `${BASE}/classes/${sciId}/topics/reorder`],
        ['post', `${BASE}/items/${item.itemId}/attachments`],
        ['post', `${BASE}/items/${item.itemId}/links`],
        ['patch', `${BASE}/attachments/${link.attachmentId}`],
        ['put', `${BASE}/attachments/${link.attachmentId}/file`],
        ['delete', `${BASE}/attachments/${link.attachmentId}`],
        ['get', `${BASE}/attachments/${link.attachmentId}/url`],
        ['get', `${BASE}/classes/${sciId}/copy-sources`],
        ['post', `${BASE}/classes/${sciId}/copy`],
      ];
      for (const [method, url] of routes) {
        const res = await call(method, url, asOtherTeacher).send({});
        expect([method, url, res.status]).toEqual([method, url, 403]);
        const st = await call(method, url, asStudent).send({});
        expect([method, url, st.status, st.body.code]).toEqual([method, url, 403, 'STUDENT_FORBIDDEN']);
      }
      // Nothing changed.
      expect((await call('get', `${BASE}/items/${item.itemId}`)).status).toBe(200);
      // Unknown and malformed ids are 404s.
      expect((await call('get', `${BASE}/items/99999999-9999-4999-8999-999999999999`)).status).toBe(404);
      expect((await call('get', `${BASE}/items/not-a-uuid`)).status).toBe(404);
      expect((await call('patch', `${BASE}/topics/not-a-uuid`)).status).toBe(404);
      expect((await call('get', `${BASE}/attachments/not-a-uuid/url`)).status).toBe(404);
    });

    it('copy refuses a source class the caller does not teach', async () => {
      const res = await call('post', `${BASE}/classes/${sciId}/copy`).send({ sourceClassId: mathId });
      expect(res.status).toBe(403);
    });
  });

  describe('copy and duplicate', () => {
    // Science's classwork: an assignment under Homework (in a topic, with a
    // file and a link), a quiz under Quizzes, a material, and the legacy
    // plain columns (Unit 1 test under Tests, Homework 1–4).
    const seedScienceClasswork = async () => {
      const topic = (await call('post', `${BASE}/classes/${sciId}/topics`).send({ name: 'Unit 2 · Cells' })).body.data;
      const assignment = await createItem(sciId, homeworkAssignment({ topicId: topic.topicId }));
      await call('post', `${BASE}/items/${assignment.itemId}/attachments`)
        .attach('files', Buffer.from('%PDF-1.4'), { filename: 'checklist.pdf', contentType: 'application/pdf' });
      await call('post', `${BASE}/items/${assignment.itemId}/links`).send({ title: 'Cells video', url: 'https://youtu.be/dQw4w9WgXcQ' });
      const quiz = await createItem(sciId, { kind: 'quiz', title: 'Cells quiz', dueAt: inDays(4), gradebook: { mode: 'category', categoryId: quizzesId, maxScore: 8 } });
      const material = await createItem(sciId, { kind: 'material', title: 'Cells reading', topicId: topic.topicId });
      return { topic, assignment, quiz, material };
    };

    it('copy from another class creates drafts, maps categories by name and warns when missing', async () => {
      const src = await seedScienceClasswork();
      const targetId = await makeClass('Science', '5', TEACHER_ID);
      const targetHomework = await assessment(targetId, 'homework', { isParent: true, weight: 50 });
      await assessment(targetId, 'Labs', { isParent: true, weight: 50 });

      const sources = await call('get', `${BASE}/classes/${targetId}/copy-sources`);
      expect(sources.status).toBe(200);
      expect(sources.body.data.classes).toEqual([{ classId: sciId, label: 'Grade 5 Science · Term 1', itemCount: 8 }]);

      supabase._mockStorage.copy.mockClear();
      const res = await call('post', `${BASE}/classes/${targetId}/copy`).send({
        sourceClassId: sciId, itemIds: [src.assignment.itemId, src.quiz.itemId, src.material.itemId, (await itemsOf(unit1Id))[0].item_id],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.copied).toBe(3);
      expect(res.body.data.warnings).toEqual(expect.arrayContaining([
        { title: 'Cells quiz', message: 'No Quizzes category here, so it was copied as not graded.' },
        { title: 'Unit 1 test', message: 'No Tests category here, so it was not copied.' },
      ]));
      expect(res.body.data.warnings).toHaveLength(2);

      const byTitle = Object.fromEntries(res.body.data.items.map((i) => [i.title, i]));
      expect(Object.keys(byTitle).sort()).toEqual(['Cells quiz', 'Cells reading', 'Plant cell diagram']);
      for (const i of res.body.data.items) expect(i).toMatchObject({ classId: targetId, status: 'draft', dueAt: null, postedAt: null });
      expect(byTitle['Plant cell diagram'].gradebook).toMatchObject({ categoryId: targetHomework, maxScore: 10, weightPoints: 50 });
      expect(byTitle['Cells quiz'].gradebook).toBeNull();
      expect(byTitle['Plant cell diagram'].attachmentCount).toBe(2);
      expect(supabase._mockStorage.copy).toHaveBeenCalledTimes(1);
      expect(supabase._mockStorage.copy.mock.calls[0][1]).toMatch(new RegExp(`^ALHAADIACADEMY/classwork/${byTitle['Plant cell diagram'].itemId}/`));

      const topics = (await call('get', `${BASE}/classes/${targetId}/topics`)).body.data;
      expect(topics.map((t) => [t.name, t.itemCount])).toEqual([['Unit 2 · Cells', 2]]);

      // The source is untouched.
      expect((await call('get', `${BASE}/items/${src.assignment.itemId}`)).body.data.status).toBe('posted');

      // Copying the same class onto itself is refused.
      expect((await call('post', `${BASE}/classes/${sciId}/copy`).send({ sourceClassId: sciId })).status).toBe(400);
      // A whole-class copy without topics.
      const plain = await makeClass('Art', '5', TEACHER_ID);
      const whole = await call('post', `${BASE}/classes/${plain}/copy`).send({ sourceClassId: sciId, includeTopics: false });
      expect(whole.status).toBe(200);
      expect(whole.body.data.items.every((i) => i.topicId === null)).toBe(true);
      expect((await call('get', `${BASE}/classes/${plain}/topics`)).body.data).toEqual([]);
    });

    it('duplicating a class copies topics and classwork as drafts', async () => {
      const src = await seedScienceClasswork();
      supabase._mockStorage.copy.mockClear();
      const res = await call('post', `/api/classes/${sciId}/duplicate`, asTeacher).send({
        grade: '5', subject: 'Science', teacherName: 'Ziad Teacher', teacherId: TEACHER_ID, termId, termName: 'Term 1',
      });
      expect(res.status).toBe(201);
      const newId = res.body.data.classId;

      const topics = (await pool.query(`SELECT topic_id, name FROM classwork_topics WHERE class_id = $1`, [newId])).rows;
      expect(topics.map((t) => t.name)).toEqual(['Unit 2 · Cells']);
      const { rows } = await pool.query(
        `SELECT i.*, a.name AS a_name, p.name AS cat FROM classwork_items i
         LEFT JOIN assessments a ON a.assessment_id = i.assessment_id LEFT JOIN assessments p ON p.assessment_id = a.parent_assessment_id
         WHERE i.class_id = $1 AND i.deleted_at IS NULL`, [newId],
      );
      const byName = Object.fromEntries(rows.map((r) => [r.a_name ?? r.title, r]));
      expect(Object.keys(byName).sort()).toEqual([
        'Cells quiz', 'Cells reading', 'Homework 1', 'Homework 2', 'Homework 3', 'Homework 4', 'Plant cell diagram', 'Unit 1 test',
      ]);
      for (const r of rows) expect(r).toMatchObject({ status: 'draft', posted_at: null, due_at: null, publish_at: null });
      expect(byName['Plant cell diagram']).toMatchObject({ kind: 'assignment', submission_mode: 'file', cat: 'Homework', title: null, topic_id: topics[0].topic_id });
      expect(byName['Cells quiz']).toMatchObject({ kind: 'quiz', cat: 'Quizzes' });
      expect(byName['Cells reading']).toMatchObject({ kind: 'material', assessment_id: null, topic_id: topics[0].topic_id });
      expect(byName['Unit 1 test']).toMatchObject({ kind: 'assessment', cat: 'Tests' });
      // One item per copied column, none for the categories.
      const cols = (await pool.query(`SELECT assessment_id, is_parent FROM assessments WHERE class_id = $1`, [newId])).rows;
      for (const c of cols) expect((await itemsOf(c.assessment_id)).length).toBe(c.is_parent ? 0 : 1);

      const atts = (await pool.query(
        `SELECT x.kind, x.file_path, x.url FROM classwork_attachments x WHERE x.item_id = $1 ORDER BY x.sort_order`, [byName['Plant cell diagram'].item_id],
      )).rows;
      expect(atts.map((a) => a.kind)).toEqual(['file', 'link']);
      expect(atts[0].file_path).toMatch(new RegExp(`^ALHAADIACADEMY/classwork/${byName['Plant cell diagram'].item_id}/`));
      expect(supabase._mockStorage.copy).toHaveBeenCalledTimes(1);
      // The source stays posted.
      expect((await call('get', `${BASE}/items/${src.assignment.itemId}`)).body.data.status).toBe('posted');
    });
  });

  describe('class cards, coming up, drafts and stream', () => {
    it("class cards show the next due item; drafts & scheduled lists the caller's drafts", async () => {
      const dueAt = inDays(2);
      const assignment = await createItem(sciId, homeworkAssignment({ dueAt }));
      await createItem(sciId, { kind: 'material', title: 'Reading' }); // materials are never "next"
      const draft = await createItem(sciId, { kind: 'material', title: 'Unfinished notes', status: 'draft' });
      const publishAt = inDays(1);
      const scheduled = await createItem(sciId, { kind: 'assignment', title: 'Lab report', status: 'scheduled', publishAt, dueAt: inDays(5) });
      await createItem(mathId, { kind: 'material', title: 'Not mine', status: 'draft' }, asOtherTeacher);

      const res = await call('get', `${BASE}/classes`);
      expect(res.status).toBe(200);
      const card = res.body.data.classes.find((c) => c.classId === sciId);
      expect(card.next).toEqual({
        itemId: assignment.itemId, assessmentId: assignment.gradebook.assessmentId, title: 'Plant cell diagram', kind: 'assignment',
        dueAt: new Date(dueAt).toISOString(), date: torontoDay(dueAt),
      });

      expect(res.body.data.draftsAndScheduled).toEqual([
        { itemId: scheduled.itemId, classId: sciId, classLabel: 'Grade 5 Science', title: 'Lab report', kind: 'assignment', status: 'scheduled', publishAt: new Date(publishAt).toISOString() },
        { itemId: draft.itemId, classId: sciId, classLabel: 'Grade 5 Science', title: 'Unfinished notes', kind: 'material', status: 'draft', publishAt: null },
      ]);
      // The co-teacher sees the class's drafts too; the other teacher only their own.
      const co = (await call('get', `${BASE}/classes`, asCoTeacher)).body.data.draftsAndScheduled;
      expect(co.map((d) => d.itemId)).toEqual([scheduled.itemId, draft.itemId]);
      const other = (await call('get', `${BASE}/classes`, asOtherTeacher)).body.data.draftsAndScheduled;
      expect(other.map((d) => d.title)).toEqual(['Not mine']);

      expect(res.body.data.comingUp).toEqual([{
        itemId: assignment.itemId, assessmentId: assignment.gradebook.assessmentId, classId: sciId, classLabel: 'Grade 5 Science',
        title: 'Plant cell diagram', kind: 'assignment', date: torontoDay(dueAt), dueAt: new Date(dueAt).toISOString(),
        inClass: false, stillToTurnIn: 2,
      }]);
    });

    it('a dated plain assessment is next with its date and in class; drafts never show as next', async () => {
      const today = torontoDay(Date.now());
      await pool.query(`UPDATE assessments SET date = $2::date + 1 WHERE assessment_id = $1`, [unit1Id, today]);
      await createItem(sciId, homeworkAssignment({ status: 'draft', dueAt: new Date().toISOString() }));
      const data = (await call('get', `${BASE}/classes`)).body.data;
      const card = data.classes.find((c) => c.classId === sciId);
      expect(card.next).toMatchObject({ kind: 'assessment', title: 'Unit 1 test', dueAt: null, assessmentId: unit1Id });
      expect(card.next.itemId).toBe((await itemsOf(unit1Id))[0].item_id);
      expect(data.comingUp).toEqual([expect.objectContaining({ kind: 'assessment', inClass: true, stillToTurnIn: null, title: 'Unit 1 test' })]);
    });

    it('the teacher stream lists posted assignments, quizzes and materials as notices', async () => {
      const a = await createItem(sciId, homeworkAssignment());
      const m = await createItem(sciId, { kind: 'material', title: 'Reading' });
      await createItem(sciId, { kind: 'material', title: 'Draft', status: 'draft' });
      await createItem(sciId, { kind: 'assignment', title: 'Only Amal', audience: 'some', studentIds: [amalId] });
      const res = await call('get', `${BASE}/classes/${sciId}/stream`);
      expect(res.status).toBe(200);
      const notices = res.body.data.notices;
      expect(notices.map((n) => n.title)).toEqual(['Only Amal', 'Reading', 'Plant cell diagram']);
      expect(notices.find((n) => n.itemId === a.itemId)).toEqual({
        itemId: a.itemId, kind: 'assignment', title: 'Plant cell diagram', postedAt: a.postedAt, dueAt: a.dueAt, turnedInCount: 0, total: 2,
      });
      expect(notices.find((n) => n.itemId === m.itemId).dueAt).toBeNull();
      expect(notices.find((n) => n.title === 'Only Amal').total).toBe(1);
    });
  });
});
