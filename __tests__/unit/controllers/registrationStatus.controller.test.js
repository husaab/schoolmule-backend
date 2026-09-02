const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const db = require('../../__mocks__/config/database');
const { toKey } = require('../../../controllers/registrationStatus.controller');

const app = getApp();

const statusRow = (over = {}) => ({
  status_id: '11111111-1111-4111-8111-111111111111',
  school: 'ALHAADIACADEMY',
  key: 'waitlist',
  label: 'Waitlist',
  color: 'amber',
  sort_order: 2,
  is_builtin: false,
  is_default: false,
  ...over,
});

// The delete path runs inside a transaction, so its reads go through the
// pooled client rather than db.query.
const mockClientQueries = (responses) => {
  const client = db._mockClient;
  client.query.mockImplementation((sql) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return Promise.resolve({});
    const next = responses.shift();
    return Promise.resolve(next || { rows: [], rowCount: 0 });
  });
};

describe('toKey', () => {
  it('derives a stable storage key from a label', () => {
    expect(toKey('On Waitlist')).toBe('on_waitlist');
    expect(toKey('  Accepted!  ')).toBe('accepted');
    expect(toKey('Needs follow-up')).toBe('needs_follow_up');
  });

  it('collapses punctuation runs rather than leaving separators', () => {
    expect(toKey('A -- B')).toBe('a_b');
  });

  it('returns empty for a label with nothing usable', () => {
    expect(toKey('!!!')).toBe('');
  });
});

describe('Registration Status Controller', () => {
  // ─── GET /api/registration/statuses ────────────────────────────
  describe('GET /statuses', () => {
    it('returns the school\'s statuses', async () => {
      const token = mockAdminUser();
      mockQueryResponse([statusRow({ key: 'new', label: 'New', is_builtin: true, is_default: true })]);

      const res = await request(app)
        .get('/api/registration/statuses')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({ key: 'new', label: 'New', isBuiltin: true, isDefault: true });
    });

    it('seeds the built-ins for a school that has none yet', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);                                    // initial read: empty
      mockQueryResponse([]);                                    // seed insert
      mockQueryResponse([statusRow({ key: 'new', label: 'New', is_builtin: true })]); // re-read

      const res = await request(app)
        .get('/api/registration/statuses')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      // The seed INSERT must actually have been issued, not just an empty list returned.
      const sqls = db.query.mock.calls.map((c) => c[0]);
      expect(sqls.some((s) => /INSERT INTO registration_statuses/i.test(s))).toBe(true);
    });
  });

  // ─── POST /api/registration/statuses ───────────────────────────
  describe('POST /statuses', () => {
    const url = '/api/registration/statuses';

    it('creates a custom status', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);                          // no existing key
      mockQueryResponse([statusRow({ key: 'accepted', label: 'Accepted', color: 'emerald' })]);

      const res = await request(app).post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ label: 'Accepted', color: 'emerald' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ key: 'accepted', label: 'Accepted', color: 'emerald' });
    });

    it('rejects a blank label', async () => {
      const token = mockAdminUser();
      const res = await request(app).post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ label: '   ' });
      expect(res.status).toBe(400);
    });

    it('rejects a colour outside the palette', async () => {
      const token = mockAdminUser();
      const res = await request(app).post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ label: 'Accepted', color: 'hotpink' });
      expect(res.status).toBe(400);
    });

    it('rejects a label that collides with an existing status', async () => {
      const token = mockAdminUser();
      mockQueryResponse([statusRow({ key: 'waitlist', label: 'Waitlist' })]);

      const res = await request(app).post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ label: 'wait list' }); // → same key as "Waitlist"

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already exists/i);
    });
  });

  // ─── DELETE /api/registration/statuses/:id ─────────────────────
  describe('DELETE /statuses/:statusId', () => {
    const url = '/api/registration/statuses/11111111-1111-4111-8111-111111111111';

    it('deletes an unused custom status', async () => {
      const token = mockAdminUser();
      mockClientQueries([
        { rows: [statusRow()] },        // target lookup
        { rows: [{ count: '0' }] },     // usage count
        { rows: [statusRow()] },        // delete
      ]);

      const res = await request(app).delete(url)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.reassigned).toBe(0);
    });

    it('refuses to delete a built-in status', async () => {
      const token = mockAdminUser();
      mockClientQueries([{ rows: [statusRow({ key: 'new', label: 'New', is_builtin: true })] }]);

      const res = await request(app).delete(url)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/built-in/i);
    });

    it('refuses to delete an in-use status without a replacement', async () => {
      const token = mockAdminUser();
      mockClientQueries([
        { rows: [statusRow()] },
        { rows: [{ count: '14' }] },
      ]);

      const res = await request(app).delete(url)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IN_USE');
      expect(res.body.data.submissionCount).toBe(14);
      expect(res.body.message).toMatch(/14 submissions/);
    });

    it('reassigns then deletes when a replacement is given', async () => {
      const token = mockAdminUser();
      mockClientQueries([
        { rows: [statusRow()] },                                   // target
        { rows: [{ count: '14' }] },                               // in use
        { rows: [statusRow({ key: 'reviewed', label: 'Reviewed' })] }, // replacement
        { rows: [] },                                              // reassign
        { rows: [statusRow()] },                                   // delete
      ]);

      const res = await request(app).delete(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ reassignTo: 'reviewed' });

      expect(res.status).toBe(200);
      expect(res.body.data.reassigned).toBe(14);

      // The reassignment must precede the delete, or submissions would briefly
      // reference a status that no longer exists.
      const sqls = db._mockClient.query.mock.calls.map((c) => c[0]);
      const reassignAt = sqls.findIndex((s) => /UPDATE registration_form_submissions/i.test(s));
      const deleteAt = sqls.findIndex((s) => /DELETE FROM registration_statuses/i.test(s));
      expect(reassignAt).toBeGreaterThanOrEqual(0);
      expect(deleteAt).toBeGreaterThan(reassignAt);
    });

    it('rejects reassigning a status to itself', async () => {
      const token = mockAdminUser();
      mockClientQueries([
        { rows: [statusRow()] },
        { rows: [{ count: '3' }] },
        { rows: [statusRow()] }, // replacement resolves to the same key
      ]);

      const res = await request(app).delete(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ reassignTo: 'waitlist' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/itself/i);
    });

    it('rejects an unknown replacement status', async () => {
      const token = mockAdminUser();
      mockClientQueries([
        { rows: [statusRow()] },
        { rows: [{ count: '3' }] },
        { rows: [] }, // replacement not found
      ]);

      const res = await request(app).delete(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ reassignTo: 'nonexistent' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not found/i);
    });
  });

  // ─── Submission status validation ──────────────────────────────
  describe('PATCH /submissions/:id/status', () => {
    const url = '/api/registration/submissions/22222222-2222-4222-8222-222222222222/status';

    it('accepts a school-defined custom status', async () => {
      const token = mockAdminUser();
      mockQueryResponse([statusRow({ key: 'accepted', label: 'Accepted' })]); // vocabulary lookup
      mockQueryResponse([{ submission_id: '22222222-2222-4222-8222-222222222222', status: 'accepted' }]);

      const res = await request(app).patch(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'accepted' });

      expect(res.status).toBe(200);
    });

    it('rejects a status the school has not defined', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // not in the vocabulary

      const res = await request(app).patch(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'not_a_real_status' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid status/i);
    });
  });
});
