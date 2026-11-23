// GET /api/admin/overview: the admin panel's live facts. Covers who gets which
// block (a block the caller can't open is left out), that the counts match
// what each area's own page shows (approvals, users, student accounts), the
// messaging, guardian and term rules, and that a failing or slow block is
// { error: true } on its own while the rest still answer.
// Synthetic identities only (Test ..., @example.test).

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const Q = require('../../../queries/adminOverview.queries');
const accessStore = require('../../../services/access/accessStore');
const { torontoDate } = require('../../../services/adminOverview/shape');
const { addDays } = require('../../../services/classroom/classroomDigest');

const SCHOOL = 'ALHAADIACADEMY';
const URL = '/api/admin/overview';

const ADMIN = { userId: '550e8400-e29b-41d4-a716-446655440a01', username: 'Test Admin', email: 'admin@example.test', role: 'ADMIN' };
const OFFICE = { userId: '550e8400-e29b-41d4-a716-446655440a02', username: 'Test Office', email: 'office@example.test', role: 'ADMIN' };
const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440a03', username: 'Test Teacher', email: 'teacher@example.test', role: 'TEACHER' };
const PARENT = { userId: '550e8400-e29b-41d4-a716-446655440a04', username: 'Test Parent', email: 'parent@example.test', role: 'PARENT' };

const ALL_BLOCKS = [
  'approvals', 'users', 'studentAccounts', 'relations', 'messages', 'schoolSettings', 'calendar', 'assets',
  'reportTemplates', 'reportRuns', 'forms', 'planner', 'agendas', 'meetings', 'finance', 'roles', 'patchNotes',
].sort();
const blocksOf = (data) => Object.keys(data).filter((k) => !['generatedAt', 'today', 'schoolYear'].includes(k)).sort();

describe('Integration: GET /api/admin/overview', () => {
  let pool, yearId, schoolId, today, roleSeq;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const expectStatus = async (req, status) => {
    const res = await req;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const overview = async (who = ADMIN, { status = 200, year = null } = {}) => {
    const req = authenticatedRequest('get', URL, who);
    if (year) req.set('X-School-Year', year);
    return (await expectStatus(req, status)).data;
  };
  const get = async (url, who = ADMIN) => (await expectStatus(authenticatedRequest('get', url, who), 200)).data;

  let userSeq = 0;
  const user = async ({
    userId = null, email = null, role = 'PARENT', school = SCHOOL, password = 'not-a-real-hash', firstName = 'Test', lastName = 'Person',
    verified = true, verifiedSchool = true, archived = false, declined = false,
  } = {}) => {
    userSeq += 1;
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, is_archived, declined_at)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12 THEN NOW() END)
       RETURNING user_id`,
      [userId, email || `person${userSeq}@example.test`, `${firstName} ${lastName}`, password, firstName, lastName, school, role,
        verified, verifiedSchool, archived, declined],
    );
    return u.user_id;
  };
  const staff = (who) => user({ userId: who.userId, email: who.email, role: who.role, firstName: 'Test', lastName: who.username.split(' ')[1] });
  /** Puts `who` on a new custom access role holding `permissions`. */
  const giveRole = async (who, permissions) => {
    roleSeq += 1;
    const { rows: [r] } = await pool.query(
      `INSERT INTO staff_roles (school, name, permissions) VALUES ($1, $2, $3) RETURNING role_id`,
      [SCHOOL, `Test role ${roleSeq}`, permissions],
    );
    await pool.query('UPDATE users SET staff_role_id = $1 WHERE user_id = $2', [r.role_id, who.userId]);
    accessStore.invalidateAll();
  };
  const student = async (name, { year = yearId, grade = '5', archived = false, mother = null, father = null } = {}) => (await pool.query(
    `INSERT INTO students (name, grade, school, school_year_id, is_archived, mother_email, father_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING student_id`,
    [name, grade, SCHOOL, year, archived, mother, father],
  )).rows[0].student_id;
  const pastYear = async () => (await pool.query(
    `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
     VALUES ($1, $2, '2024-2025', '2024-09-01', '2025-06-30', false) RETURNING school_year_id`,
    [SCHOOL, schoolId],
  )).rows[0].school_year_id;

  beforeEach(async () => {
    roleSeq = 0;
    today = torontoDate(new Date());
    ({ school_year_id: yearId, school_id: schoolId } = (await pool.query(
      `SELECT school_year_id, school_id FROM school_years WHERE school = $1 AND is_active LIMIT 1`, [SCHOOL],
    )).rows[0]);
    await staff(ADMIN);
    await staff(OFFICE);
    await staff(TEACHER);
    await user({ userId: PARENT.userId, email: PARENT.email, role: 'PARENT', lastName: 'Parent' });
  });

  describe('who gets which block', () => {
    it('a full admin gets every block, none failed, with the day and the year', async () => {
      const data = await overview();

      expect(blocksOf(data)).toEqual(ALL_BLOCKS);
      for (const key of ALL_BLOCKS) expect(data[key]).not.toEqual({ error: true });
      expect(data.today).toBe(today);
      expect(new Date(data.generatedAt).toString()).not.toBe('Invalid Date');
      expect(data.schoolYear).toEqual({ schoolYearId: yearId, label: '2025-2026', isActive: true });
    });

    it('a forms-only role gets only the forms block', async () => {
      await giveRole(OFFICE, ['forms']);
      expect(blocksOf(await overview(OFFICE))).toEqual(['forms']);
    });

    it('a users-only role gets the people blocks, and never roles, patch notes or finance', async () => {
      await giveRole(OFFICE, ['users']);
      expect(blocksOf(await overview(OFFICE))).toEqual(['approvals', 'relations', 'studentAccounts', 'users']);
    });

    it('finance comes with the finance key alongside an admin panel key, and not without it', async () => {
      await giveRole(OFFICE, ['scheduling', 'report_cards']);
      expect(blocksOf(await overview(OFFICE))).toEqual(['agendas', 'meetings', 'planner', 'reportRuns']);

      await giveRole(OFFICE, ['forms', 'finance']);
      expect(blocksOf(await overview(OFFICE))).toEqual(['finance', 'forms']);
    });

    it('school setup and all messages bring their own blocks', async () => {
      await giveRole(OFFICE, ['school_setup', 'messages.all']);
      expect(blocksOf(await overview(OFFICE))).toEqual(['assets', 'calendar', 'messages', 'reportTemplates', 'schoolSettings']);
    });

    it('refuses a role with no admin panel key, a plain teacher and a parent', async () => {
      await giveRole(OFFICE, ['attendance.daily', 'finance', 'report_cards']);
      await overview(OFFICE, { status: 403 });
      await overview(TEACHER, { status: 403 });
      await overview(PARENT, { status: 403 });
    });
  });

  describe('the facts match the pages', () => {
    it('approvals: pending and unverified signups split like the Pending tab, plus student requests', async () => {
      // Waiting on an admin: a parent and a teacher who verified their email.
      await user({ role: 'PARENT', verifiedSchool: false });
      await user({ role: 'TEACHER', verifiedSchool: false });
      // Waiting on their email.
      await user({ role: 'PARENT', verified: false, verifiedSchool: false });
      // Never on the page: an unverified admin, a declined signup, an approved
      // account, another school's signup.
      await user({ role: 'ADMIN', verified: false, verifiedSchool: false });
      await user({ role: 'PARENT', verifiedSchool: false, archived: true, declined: true });
      await user({ role: 'PARENT' });
      await user({ role: 'PARENT', verifiedSchool: false, school: 'PLAYGROUND' });
      await pool.query(
        `INSERT INTO student_account_requests (school, first_name, last_name, grade, email, status, decided_at)
         VALUES ($1, 'Test', 'Student', '5', 'student.one@example.test', 'pending', NULL),
                ($1, 'Test', 'Student', '6', 'student.two@example.test', 'declined', NOW())`,
        [SCHOOL],
      );

      const { approvals } = await overview();
      expect(approvals).toEqual({ pendingSignups: 2, unverifiedSignups: 1, pendingStudentRequests: 1 });

      // The approvals page's own split of its rows (approvals/page.tsx).
      const rows = await get('/api/admin/approvals');
      expect(rows.filter((u) => !u.isArchived && u.isVerified !== false)).toHaveLength(approvals.pendingSignups);
      expect(rows.filter((u) => !u.isArchived && u.isVerified === false)).toHaveLength(approvals.unverifiedSignups);
    });

    it('users: the Users page tiles by role, and invites not used yet', async () => {
      await user({ role: 'TEACHER', password: '!' }); // invited, never signed in
      await user({ role: 'PARENT' });
      await user({ role: 'PARENT', password: '!' });
      await user({ role: 'PARENT', archived: true });
      await user({ role: 'STUDENT' });
      await user({ role: 'TEACHER', school: 'PLAYGROUND' });

      const { users } = await overview();
      // ADMIN, OFFICE (admins), TEACHER + the invited teacher, PARENT + two.
      expect(users).toEqual({ admins: 2, teachers: 2, parents: 3, invitedNotSignedIn: 2 });

      // The Users page's own derivation (adminUsers/userDisplay.tsx statusOf).
      const rows = (await get('/api/admin/users')).filter((u) => !u.isArchived);
      expect(rows.filter((u) => u.role === 'ADMIN')).toHaveLength(users.admins);
      expect(rows.filter((u) => u.role === 'TEACHER')).toHaveLength(users.teachers);
      expect(rows.filter((u) => u.role === 'PARENT')).toHaveLength(users.parents);
      expect(rows.filter((u) => u.invitePending)).toHaveLength(users.invitedNotSignedIn);
    });

    it("student accounts: the Student accounts page's own statuses for the selected year", async () => {
      await student('Test Student One');
      await student('Test Student Two');
      await student('Test Student Kinder', { grade: 'JK' }); // below the login grade
      await student('Test Student Gone', { archived: true });
      await student('Test Student Last Year', { year: await pastYear() });
      // An invited login with no invite on record (needs attention) and an active one.
      const invited = await student('Test Student Invited');
      const active = await student('Test Student Active');
      for (const [studentId, password, n] of [[invited, '!', 1], [active, 'not-a-real-hash', 2]]) {
        const loginId = await user({ role: 'STUDENT', password, email: `student.login${n}@example.test` });
        await pool.query(
          'INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)',
          [loginId, studentId, yearId],
        );
      }

      const { studentAccounts } = await overview();
      expect(studentAccounts).toEqual({ students: 5, notInvited: 2, invited: 1, active: 1, needsAttention: 1 });

      // The page's chips (lib/studentAccounts.ts countByStatus) over its rows.
      const { students } = await get('/api/admin/student-accounts');
      const count = (status) => students.filter((s) => s.status === status).length;
      expect({
        students: students.length,
        notInvited: count('not_invited'),
        invited: count('invited'),
        active: count('active'),
        needsAttention: students.filter((s) => s.needsAttention).length,
      }).toEqual(studentAccounts);
    });

    it("relations: students nobody can be reached about, by messaging's guardian rule", async () => {
      const linked = await student('Test Student Linked');
      await pool.query(
        `INSERT INTO parent_students (student_id, parent_id, school, relation) VALUES ($1, $2, $3, 'Mother')`,
        [linked, PARENT.userId, SCHOOL],
      );
      await student('Test Student On File', { mother: ' mother.onfile@example.test ' });
      await student('Test Student Bad Address', { mother: 'call the office' });
      const removed = await student('Test Student Removed', { father: 'Father.Removed@example.test' });
      await pool.query(`INSERT INTO guardian_removals (student_id, email) VALUES ($1, 'father.removed@example.test')`, [removed]);
      await user({ role: 'PARENT', archived: true, email: 'archived.parent@example.test' });
      await student('Test Student Archived Parent', { mother: 'archived.parent@example.test' });
      await student('Test Student Nothing');
      await student('Test Student Gone', { archived: true });
      await student('Test Student Last Year', { year: await pastYear() });

      const { relations } = await overview();
      expect(relations).toEqual({ students: 6, withoutGuardian: 4 });
    });

    it('messages: open threads awaiting the school, those waiting 48 hours or more, failed emails', async () => {
      const studentId = await student('Test Student Messages');
      const lastYearStudent = await student('Test Student Last Year', { year: await pastYear() });
      const thread = async ({ status = 'open', who = studentId } = {}) => (await pool.query(
        `INSERT INTO conversations (school, student_id, teacher_id, kind, title, status)
         VALUES ($1, $2, $3, 'general', 'Test thread', $4) RETURNING conversation_id`,
        [SCHOOL, who, TEACHER.userId, status],
      )).rows[0].conversation_id;
      const say = (conversationId, role, hoursAgo, { kind = 'message', deleted = false } = {}) => pool.query(
        `INSERT INTO messages (conversation_id, sender_id, sender_role, kind, body, created_at, deleted_at)
         VALUES ($1, $2, $3, $4, 'Test message', NOW() - make_interval(hours => $5), CASE WHEN $6 THEN NOW() END)`,
        [conversationId, role === 'PARENT' ? PARENT.userId : TEACHER.userId, role, kind, hoursAgo, deleted],
      );
      const failEmail = (conversationId, status = 'failed') => pool.query(
        `INSERT INTO message_email_jobs (conversation_id, recipient_id, school, send_after, status)
         VALUES ($1, $2, $3, NOW(), $4)`,
        [conversationId, PARENT.userId, SCHOOL, status],
      );

      const fresh = await thread(); // a parent wrote an hour ago
      await say(fresh, 'TEACHER', 5);
      await say(fresh, 'PARENT', 1);
      const old = await thread(); // a parent wrote three days ago
      await say(old, 'PARENT', 72);
      const answered = await thread();
      await say(answered, 'PARENT', 72);
      await say(answered, 'TEACHER', 70);
      const resolved = await thread({ status: 'resolved' });
      await say(resolved, 'PARENT', 72);
      // A teacher's removed reply and a system line don't answer the parent.
      const unanswered = await thread();
      await say(unanswered, 'PARENT', 50);
      await say(unanswered, 'TEACHER', 49, { deleted: true });
      await say(unanswered, 'TEACHER', 48, { kind: 'system' });
      const lastYear = await thread({ who: lastYearStudent });
      await say(lastYear, 'PARENT', 72);

      await failEmail(fresh);
      await failEmail(fresh);
      await failEmail(answered);
      await failEmail(old, 'sent');
      await failEmail(resolved);
      await failEmail(lastYear);

      const { messages } = await overview();
      expect(messages).toEqual({ awaitingReply: 3, waitingOverTwoDays: 2, failedEmailConversations: 2 });
    });

    it('school settings: the current term is the selected year\'s, even when another year has one of the same name', async () => {
      const lastYear = await pastYear();
      const term = async (name, year, from, to) => (await pool.query(
        `INSERT INTO terms (school, name, start_date, end_date, school_year_id) VALUES ($1, $2, $3, $4, $5) RETURNING term_id`,
        [SCHOOL, name, addDays(today, from), addDays(today, to), year],
      )).rows[0].term_id;
      // Created first so a lookup by name alone would find it.
      const oldTerm1 = await term('Term 1', lastYear, -30, 30);
      const term1 = await term('Term 1', yearId, -20, 20);
      await term('Term 2', yearId, 21, 120);

      expect((await overview()).schoolSettings).toEqual({
        currentTerm: { termId: term1, name: 'Term 1', startDate: addDays(today, -20), endDate: addDays(today, 20) },
        nextTerm: null,
      });
      expect((await overview(ADMIN, { year: lastYear })).schoolSettings.currentTerm.termId).toBe(oldTerm1);

      // Between terms: the next one, and no current one.
      await pool.query('UPDATE terms SET end_date = $1 WHERE term_id = $2', [addDays(today, -1), term1]);
      expect((await overview()).schoolSettings).toEqual({
        currentTerm: null,
        nextTerm: expect.objectContaining({ name: 'Term 2', startDate: addDays(today, 21) }),
      });
    });

    it('the remaining blocks read their own areas', async () => {
      const lastYear = await pastYear();
      // Calendar: the next closure from today, not an open-school event or a past one.
      await pool.query(
        `INSERT INTO school_calendar_events (school, title, category, start_date, end_date, is_school_closed, school_year_id)
         VALUES ($1, 'Test past closure', 'holiday', $2, $2, true, $5),
                ($1, 'Test open event', 'event', $3, NULL, false, $5),
                ($1, 'Test winter break', 'holiday', $4, $6, true, $5),
                ($1, 'Test other year', 'holiday', $3, NULL, true, $7)`,
        [SCHOOL, addDays(today, -3), addDays(today, 1), addDays(today, 5), yearId, addDays(today, 9), lastYear],
      );
      // Assets: a logo only (a blank stamp path counts as none).
      await pool.query(
        `INSERT INTO school_assets (school_id, school_code, logo_path, principal_signature_path, school_stamp_path)
         VALUES ($1, $2, 'logos/test.png', NULL, ' ')`,
        [schoolId, SCHOOL],
      );
      // Report templates: one never published, one published as drafted, one archived.
      const template = async (name, { archived = false } = {}) => (await pool.query(
        `INSERT INTO report_templates (school, doc_type, name, draft_doc, archived_at)
         VALUES ($1, 'report_card', $2, '{"v":1}', CASE WHEN $3 THEN NOW() END) RETURNING template_id`,
        [SCHOOL, name, archived],
      )).rows[0].template_id;
      await template('Test draft');
      const published = await template('Test published');
      await template('Test archived', { archived: true });
      const { rows: [version] } = await pool.query(
        `INSERT INTO report_template_versions (template_id, version_no, doc) VALUES ($1, 1, '{"v":1}') RETURNING version_id`,
        [published],
      );
      await pool.query('UPDATE report_templates SET published_version_id = $1 WHERE template_id = $2', [version.version_id, published]);
      // Report runs: one running, one finished with a failed student, one dismissed.
      const s1 = await student('Test Student Report One');
      const s2 = await student('Test Student Report Two');
      const run = async ({ finished = false, dismissed = false, statuses }) => {
        const { rows: [r] } = await pool.query(
          `INSERT INTO report_generation_runs (school, school_year_id, report_type, term, student_count, finished_at, dismissed_at)
           VALUES ($1, $2, 'report_card', 'Term 1', $3, CASE WHEN $4 THEN NOW() END, CASE WHEN $5 THEN NOW() END) RETURNING run_id`,
          [SCHOOL, yearId, statuses.length, finished, dismissed],
        );
        for (const [i, status] of statuses.entries()) {
          await pool.query(
            'INSERT INTO report_generation_items (run_id, student_id, position, status) VALUES ($1, $2, $3, $4)',
            [r.run_id, [s1, s2][i], i, status],
          );
        }
      };
      await run({ statuses: ['pending', 'failed'] });
      await run({ finished: true, statuses: ['generated', 'failed'] });
      await run({ finished: true, dismissed: true, statuses: ['failed', 'failed'] });
      // Forms: a published form with two new submissions, a closed one with one, a draft.
      await pool.query(
        `INSERT INTO registration_statuses (school, key, label, is_builtin, is_default) VALUES ($1, 'new', 'New', true, true),
                ($1, 'reviewed', 'Reviewed', true, false)`,
        [SCHOOL],
      );
      const form = async (slug, status, submissions) => {
        const { rows: [f] } = await pool.query(
          `INSERT INTO registration_forms (school, title, slug, status, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING form_id`,
          [SCHOOL, `Test form ${slug}`, slug, status, ADMIN.userId],
        );
        for (const s of submissions) {
          await pool.query(
            `INSERT INTO registration_form_submissions (form_id, school, answers, status) VALUES ($1, $2, '{}', $3)`,
            [f.form_id, SCHOOL, s],
          );
        }
      };
      await form('test-registration', 'published', ['new', 'new', 'reviewed']);
      await form('test-trip', 'closed', ['new']);
      await form('test-draft', 'draft', []);
      // Planner: the live timetable, a draft going live, a failed go-live.
      await pool.query(
        `INSERT INTO planner_schedules (school, name, status, published_at, effective_from, go_live_on, go_live_status, school_year_id)
         VALUES ($1, 'Test fall', 'published', NOW(), '2025-09-02', NULL, NULL, $2),
                ($1, 'Test winter', 'draft', NULL, NULL, $3, 'pending', $2),
                ($1, 'Test spring', 'draft', NULL, NULL, '2025-11-02', 'failed', $2)`,
        [SCHOOL, yearId, addDays(today, 7)],
      );
      // Agendas: the newest academic year's.
      await pool.query(
        `INSERT INTO agendas (school, academic_year, title, status) VALUES ($1, '2024-2025', 'Test old agenda', 'generated'),
                ($1, '2025-2026', 'Test agenda', 'draft')`,
        [SCHOOL],
      );
      // Meetings: an open event in three days with one booking for two siblings.
      const { rows: [event] } = await pool.query(
        `INSERT INTO ptm_events (school, school_year_id, title, status, cutoff_min) VALUES ($1, $2, 'Test meetings', 'open', NULL) RETURNING event_id`,
        [SCHOOL, yearId],
      );
      const { rows: [day] } = await pool.query(
        `INSERT INTO ptm_days (event_id, day_date, start_min, end_min) VALUES ($1, $2, 900, 1200) RETURNING day_id`,
        [event.event_id, addDays(today, 3)],
      );
      const { rows: [booking] } = await pool.query(
        `INSERT INTO ptm_bookings (event_id, day_id, teacher_id, start_min, end_min) VALUES ($1, $2, $3, 900, 910) RETURNING booking_id`,
        [event.event_id, day.day_id, TEACHER.userId],
      );
      for (const s of [s1, s2]) {
        await pool.query(
          'INSERT INTO ptm_booking_students (booking_id, event_id, teacher_id, student_id) VALUES ($1, $2, $3, $4)',
          [booking.booking_id, event.event_id, TEACHER.userId, s],
        );
      }
      // Finance: a connection that needs reconnecting, with a sync queued.
      await pool.query(
        `INSERT INTO finance_qbo_connections (school, realm_id, status, last_error, consecutive_failures, refresh_token, access_token)
         VALUES ($1, '1234567890', 'needs_reconnect', 'invalid_grant', 3, 'secret-refresh', 'secret-access')`,
        [SCHOOL],
      );
      await pool.query(`INSERT INTO finance_sync_jobs (school, kind, state) VALUES ($1, 'manual', 'pending')`, [SCHOOL]);
      // Roles and patch notes.
      await pool.query(`INSERT INTO staff_roles (school, name, permissions) VALUES ($1, 'Test front desk', '{forms}'), ('PLAYGROUND', 'Test elsewhere', '{forms}')`, [SCHOOL]);
      await pool.query(
        `INSERT INTO patch_notes (title, body, target_roles, published_at)
         VALUES ('Test out', 'Body', '{ADMIN}', NOW() - interval '2 days'), ('Test soon', 'Body', '{ADMIN}', NOW() + interval '2 days')`,
      );

      const data = await overview();
      expect(data.calendar).toEqual({
        nextClosure: { eventId: expect.any(String), title: 'Test winter break', startDate: addDays(today, 5), endDate: addDays(today, 9) },
      });
      expect(data.assets).toEqual({ logo: true, signature: false, stamp: false });
      expect(data.reportTemplates).toEqual({ total: 2, withUnpublishedChanges: 1 });
      expect(data.reportRuns).toEqual({ running: 1, failedItems: 2 });
      expect(data.forms).toEqual({
        newSubmissions: 3,
        formsWithNew: 2,
        topForm: { slug: 'test-registration', name: 'Test form test-registration', newSubmissions: 2 },
        openForms: 1,
        total: 3,
      });
      expect(data.planner).toEqual({
        live: { scheduleId: expect.any(String), name: 'Test fall', effectiveFrom: '2025-09-02' },
        nextDraft: { scheduleId: expect.any(String), name: 'Test winter', goLiveOn: addDays(today, 7) },
        goLiveFailures: [{ scheduleId: expect.any(String), name: 'Test spring' }],
      });
      expect(data.agendas).toEqual({ latest: { agendaId: expect.any(String), title: 'Test agenda', academicYear: '2025-2026', status: 'draft' } });
      expect(data.meetings).toEqual({
        event: {
          eventId: event.event_id, title: 'Test meetings', phase: 'open', opensAt: null, lastCallAt: null,
          firstDay: addDays(today, 3), lastDay: addDays(today, 3), bookings: 1, studentsBooked: 2,
        },
      });
      expect(data.finance).toEqual({
        connected: true, needsReconnect: true, syncing: true, lastSuccessAt: null, lastError: 'invalid_grant', consecutiveFailures: 3,
      });
      expect(JSON.stringify(data)).not.toMatch(/secret-/);
      expect(data.roles).toEqual({ customRoles: 1 });
      expect(data.patchNotes).toEqual({ lastPublishedAt: expect.any(String), scheduled: 1 });

      // The Forms badge says the same.
      expect((await get('/api/registration/new-count')).count).toBe(data.forms.newSubmissions);
    });
  });

  describe('a failing block stands alone', () => {
    const swap = async (key, sql, fn) => {
      const original = Q[key];
      Q[key] = sql;
      try { return await fn(); } finally { Q[key] = original; }
    };

    it('a broken query fails its block, and every other block still answers', async () => {
      await pool.query(
        `INSERT INTO school_assets (school_id, school_code, logo_path) VALUES ($1, $2, 'logos/test.png')`,
        [schoolId, SCHOOL],
      );
      const data = await swap('nextClosure', 'SELECT * FROM no_such_table', () => overview());

      expect(data.calendar).toEqual({ error: true });
      expect(blocksOf(data)).toEqual(ALL_BLOCKS);
      for (const key of ALL_BLOCKS.filter((k) => k !== 'calendar')) expect(data[key]).not.toEqual({ error: true });
      expect(data.assets).toEqual({ logo: true, signature: false, stamp: false });
    });

    it('a query over the 4 second cap is cut off, and its lane carries on', async () => {
      await giveRole(OFFICE, ['school_setup']);
      process.env.OVERVIEW_CONCURRENCY = '1'; // one lane: the slow block and the rest share a client
      try {
        const started = Date.now();
        const data = await swap('assetPresence', 'SELECT pg_sleep(6), $1::text AS school', () => overview(OFFICE));
        const took = Date.now() - started;
        expect(took).toBeGreaterThanOrEqual(3900); // it ran until the cap...
        expect(took).toBeLessThan(5900); // ...and no further
        expect(data.assets).toEqual({ error: true });
        expect(data.calendar).toEqual({ nextClosure: null });
        expect(data.schoolSettings).toEqual({ currentTerm: null, nextTerm: null });
        expect(data.reportTemplates).toEqual({ total: 0, withUnpublishedChanges: 0 });
      } finally {
        delete process.env.OVERVIEW_CONCURRENCY;
      }
    });
  });
});
