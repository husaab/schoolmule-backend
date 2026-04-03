jest.mock('puppeteer', () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue({
      setContent: jest.fn(),
      pdf: jest.fn().mockResolvedValue(Buffer.from('fake-pdf')),
      close: jest.fn(),
    }),
    close: jest.fn(),
  }),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const {
  mockAdminUser,
  mockTeacherUser,
  TEST_SCHOOL,
  TEST_TEACHER_USER_ID,
} = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const {
  buildJkskSkillDomainRow,
  buildJkskSkillRow,
  buildJkskSkillAssessmentRow,
  buildJkskLearningSkillRow,
  buildJkskDomainCommentRow,
  buildJkskTeacherAssistantRow,
  buildJkskProgressReportCommentRow,
} = require('../../helpers/factories');

const app = getApp();

describe('JKSK Controller', () => {
  // ─── GET /api/jksk/domains ─────────────────────────────────────
  describe('GET /api/jksk/domains', () => {
    const url = '/api/jksk/domains';

    it('should return domains with nested skills', async () => {
      const token = mockAdminUser();
      const rows = [
        {
          domain_id: 'dom-1',
          document_type: 'progress_report',
          domain_name: 'Language and Communication',
          domain_sort_order: 0,
          skill_id: 'sk-1',
          skill_name: 'Speaks clearly',
          skill_description: null,
          skill_sort_order: 0,
        },
        {
          domain_id: 'dom-1',
          document_type: 'progress_report',
          domain_name: 'Language and Communication',
          domain_sort_order: 0,
          skill_id: 'sk-2',
          skill_name: 'Listens attentively',
          skill_description: null,
          skill_sort_order: 1,
        },
      ];
      mockQueryResponse(rows);

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ documentType: 'progress_report', school: TEST_SCHOOL });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1); // One domain
      expect(res.body.data[0].skills).toHaveLength(2); // Two skills
      expect(res.body.data[0].name).toBe('Language and Communication');
    });

    it('should return 400 when documentType is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ school: TEST_SCHOOL });

      expect(res.status).toBe(400);
    });

    it('should return 400 when school is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ documentType: 'progress_report' });

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ documentType: 'progress_report', school: TEST_SCHOOL });

      expect(res.status).toBe(500);
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app).get(url).query({ documentType: 'progress_report', school: TEST_SCHOOL });
      expect(res.status).toBe(401);
    });
  });

  // ─── POST /api/jksk/domains ────────────────────────────────────
  describe('POST /api/jksk/domains', () => {
    const url = '/api/jksk/domains';

    it('should create a domain', async () => {
      const token = mockAdminUser();
      const row = buildJkskSkillDomainRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          documentType: 'progress_report',
          name: 'Language and Communication',
          sortOrder: 0,
          school: TEST_SCHOOL,
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toBeDefined();
    });

    it('should return 400 when required fields are missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Incomplete' });

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          documentType: 'progress_report',
          name: 'Domain',
          school: TEST_SCHOOL,
        });

      expect(res.status).toBe(500);
    });
  });

  // ─── PUT /api/jksk/domains/:domainId ───────────────────────────
  describe('PUT /api/jksk/domains/:domainId', () => {
    it('should update a domain', async () => {
      const token = mockAdminUser();
      const row = buildJkskSkillDomainRow({ name: 'Updated Domain' });
      mockQueryResponse([row]);

      const res = await request(app)
        .put(`/api/jksk/domains/${row.domain_id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Domain', sortOrder: 1 });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when name is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .put('/api/jksk/domains/some-id')
        .set('Authorization', `Bearer ${token}`)
        .send({ sortOrder: 1 });

      expect(res.status).toBe(400);
    });
  });

  // ─── DELETE /api/jksk/domains/:domainId ────────────────────────
  describe('DELETE /api/jksk/domains/:domainId', () => {
    it('should delete a domain', async () => {
      const token = mockAdminUser();
      mockQueryResponse([], 1);

      const res = await request(app)
        .delete('/api/jksk/domains/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toBe('Domain deleted');
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .delete('/api/jksk/domains/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /api/jksk/skills ─────────────────────────────────────
  describe('POST /api/jksk/skills', () => {
    const url = '/api/jksk/skills';

    it('should create a skill', async () => {
      const token = mockAdminUser();
      const row = buildJkskSkillRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          domainId: row.domain_id,
          name: 'Speaks clearly',
          description: 'Can speak clearly and fluently',
          sortOrder: 0,
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when domainId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Skill without domain' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when name is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ domainId: 'dom-1' });

      expect(res.status).toBe(400);
    });
  });

  // ─── PUT /api/jksk/skills/:skillId ─────────────────────────────
  describe('PUT /api/jksk/skills/:skillId', () => {
    it('should update a skill', async () => {
      const token = mockAdminUser();
      const row = buildJkskSkillRow({ name: 'Updated Skill' });
      mockQueryResponse([row]);

      const res = await request(app)
        .put(`/api/jksk/skills/${row.skill_id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Skill', description: 'Updated description' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when name is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .put('/api/jksk/skills/some-id')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'No name' });

      expect(res.status).toBe(400);
    });
  });

  // ─── DELETE /api/jksk/skills/:skillId ──────────────────────────
  describe('DELETE /api/jksk/skills/:skillId', () => {
    it('should delete a skill', async () => {
      const token = mockAdminUser();
      mockQueryResponse([], 1);

      const res = await request(app)
        .delete('/api/jksk/skills/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Skill deleted');
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .delete('/api/jksk/skills/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/jksk/assessments/:studentId ──────────────────────
  describe('GET /api/jksk/assessments/:studentId', () => {
    it('should return assessments for a student', async () => {
      const token = mockAdminUser();
      const rows = [
        {
          id: 'a-1',
          student_id: 'sid',
          skill_id: 'sk-1',
          term: 'Term 1',
          rating: 'DV',
          assessed_by: TEST_TEACHER_USER_ID,
          updated_at: new Date().toISOString(),
          skill_name: 'Speaks clearly',
          domain_id: 'dom-1',
          domain_name: 'Language',
        },
      ];
      mockQueryResponse(rows);

      const res = await request(app)
        .get('/api/jksk/assessments/sid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1', documentType: 'progress_report' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].rating).toBe('DV');
      expect(res.body.data[0].skillName).toBe('Speaks clearly');
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get('/api/jksk/assessments/sid')
        .set('Authorization', `Bearer ${token}`)
        .query({ documentType: 'progress_report' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when documentType is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get('/api/jksk/assessments/sid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/jksk/assessments/bulk ───────────────────────────
  describe('POST /api/jksk/assessments/bulk', () => {
    const url = '/api/jksk/assessments/bulk';

    it('should bulk upsert assessments', async () => {
      const token = mockAdminUser();
      const row = buildJkskSkillAssessmentRow();
      mockQueryResponse([row]);
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          entries: [
            { studentId: 'sid', skillId: 'sk-1', term: 'Term 1', rating: 'DV', school: TEST_SCHOOL, assessedBy: TEST_TEACHER_USER_ID },
            { studentId: 'sid', skillId: 'sk-2', term: 'Term 1', rating: 'BG', school: TEST_SCHOOL, assessedBy: TEST_TEACHER_USER_ID },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.updated).toBe(2);
    });

    it('should return 400 when entries array is empty', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ entries: [] });

      expect(res.status).toBe(400);
    });

    it('should return 400 when entries is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          entries: [{ studentId: 'sid', skillId: 'sk-1', term: 'T1', rating: 'DV', school: TEST_SCHOOL }],
        });

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/jksk/learning-skills/:studentId ──────────────────
  describe('GET /api/jksk/learning-skills/:studentId', () => {
    it('should return learning skills for a student', async () => {
      const token = mockAdminUser();
      const rows = [
        { id: 'ls-1', student_id: 'sid', term: 'Term 1', skill_name: 'Self-Regulation', rating: 'G', updated_at: new Date().toISOString() },
      ];
      mockQueryResponse(rows);

      const res = await request(app)
        .get('/api/jksk/learning-skills/sid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].skillName).toBe('Self-Regulation');
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get('/api/jksk/learning-skills/sid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/jksk/learning-skills/bulk ───────────────────────
  describe('POST /api/jksk/learning-skills/bulk', () => {
    const url = '/api/jksk/learning-skills/bulk';

    it('should bulk upsert learning skills', async () => {
      const token = mockAdminUser();
      const row = buildJkskLearningSkillRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          entries: [
            { studentId: 'sid', term: 'Term 1', skillName: 'Self-Regulation', rating: 'G', school: TEST_SCHOOL },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.updated).toBe(1);
    });

    it('should return 400 when entries is empty', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ entries: [] });

      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/jksk/domain-comments/:studentId ─────────────────
  describe('GET /api/jksk/domain-comments/:studentId', () => {
    it('should return domain comments for a student', async () => {
      const token = mockAdminUser();
      const rows = [
        {
          id: 'dc-1',
          student_id: 'sid',
          domain_id: 'dom-1',
          term: 'Term 1',
          comment: 'Strong language skills',
          domain_name: 'Language',
          updated_at: new Date().toISOString(),
        },
      ];
      mockQueryResponse(rows);

      const res = await request(app)
        .get('/api/jksk/domain-comments/sid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].comment).toBe('Strong language skills');
      expect(res.body.data[0].domainName).toBe('Language');
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get('/api/jksk/domain-comments/sid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/jksk/domain-comments/bulk ───────────────────────
  describe('POST /api/jksk/domain-comments/bulk', () => {
    const url = '/api/jksk/domain-comments/bulk';

    it('should bulk upsert domain comments', async () => {
      const token = mockAdminUser();
      const row = buildJkskDomainCommentRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          entries: [
            { studentId: 'sid', domainId: 'dom-1', term: 'Term 1', comment: 'Great progress', school: TEST_SCHOOL },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.updated).toBe(1);
    });

    it('should return 400 when entries is empty', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ entries: [] });

      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/jksk/teacher-assistant/:studentId ────────────────
  describe('GET /api/jksk/teacher-assistant/:studentId', () => {
    it('should return teacher assistant data', async () => {
      const token = mockAdminUser();
      const row = buildJkskTeacherAssistantRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .get(`/api/jksk/teacher-assistant/${row.student_id}`)
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1 2025-2026' });

      expect(res.status).toBe(200);
      expect(res.body.data).not.toBeNull();
      expect(res.body.data.teacherAssistantName).toBe('Assistant Name');
    });

    it('should return null when no teacher assistant', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get('/api/jksk/teacher-assistant/sid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get('/api/jksk/teacher-assistant/sid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/jksk/teacher-assistant ──────────────────────────
  describe('POST /api/jksk/teacher-assistant', () => {
    const url = '/api/jksk/teacher-assistant';

    it('should upsert teacher assistant', async () => {
      const token = mockAdminUser();
      const row = buildJkskTeacherAssistantRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          studentId: 'sid',
          teacherAssistantName: 'Ms. Smith',
          term: 'Term 1',
          school: TEST_SCHOOL,
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when studentId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ term: 'Term 1', school: TEST_SCHOOL });

      expect(res.status).toBe(400);
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid', school: TEST_SCHOOL });

      expect(res.status).toBe(400);
    });

    it('should return 400 when school is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid', term: 'Term 1' });

      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/jksk/progress-report-comments/:studentId ────────
  describe('GET /api/jksk/progress-report-comments/:studentId', () => {
    it('should return progress report comments', async () => {
      const token = mockAdminUser();
      const rows = [
        {
          id: 'prc-1',
          student_id: 'sid',
          term: 'Term 1',
          section_type: 'academic_achievement',
          comment: 'Strong progress',
          updated_at: new Date().toISOString(),
        },
      ];
      mockQueryResponse(rows);

      const res = await request(app)
        .get('/api/jksk/progress-report-comments/sid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].sectionType).toBe('academic_achievement');
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get('/api/jksk/progress-report-comments/sid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/jksk/progress-report-comments/bulk ─────────────
  describe('POST /api/jksk/progress-report-comments/bulk', () => {
    const url = '/api/jksk/progress-report-comments/bulk';

    it('should bulk upsert progress report comments', async () => {
      const token = mockAdminUser();
      const row = buildJkskProgressReportCommentRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          entries: [
            { studentId: 'sid', term: 'Term 1', sectionType: 'academic_achievement', comment: 'Good', school: TEST_SCHOOL },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.updated).toBe(1);
    });

    it('should return 400 when entries is empty', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ entries: [] });

      expect(res.status).toBe(400);
    });

    it('should return 400 when entries is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/jksk/progress-report/generate ──────────────────
  describe('POST /api/jksk/progress-report/generate', () => {
    const url = '/api/jksk/progress-report/generate';

    it('should return 400 when studentId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ term: 'Term 1' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid' });

      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/jksk/progress-report/generate/bulk ─────────────
  describe('POST /api/jksk/progress-report/generate/bulk', () => {
    const url = '/api/jksk/progress-report/generate/bulk';

    it('should return 400 when studentIds is not an array', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentIds: 'not-array', term: 'Term 1' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentIds: ['s1'] });

      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/jksk/report-card/generate ───────────────────────
  describe('POST /api/jksk/report-card/generate', () => {
    const url = '/api/jksk/report-card/generate';

    it('should return 400 when studentId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ term: 'Term 1' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid' });

      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/jksk/report-card/generate/bulk ─────────────────
  describe('POST /api/jksk/report-card/generate/bulk', () => {
    const url = '/api/jksk/report-card/generate/bulk';

    it('should return 400 when studentIds is not an array', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentIds: 'string', term: 'Term 1' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentIds: ['s1'] });

      expect(res.status).toBe(400);
    });
  });
});
