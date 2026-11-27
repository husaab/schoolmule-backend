jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

process.env.ASSISTANT_TURNS_PER_MINUTE = '10000';

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient'); // the storage mock
const { fakeProvider, text, toolCall } = require('../../helpers/fakeProvider');
const provider = require('../../../services/assistant/provider');
const dispatcher = require('../../../services/assistant/tools/dispatcher');
const settings = require('../../../services/assistant/settings');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000'; // authenticatedRequest's default account: a full admin
const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440091', role: 'TEACHER', email: 'assets-muley-t@test.com' };
const LIVE_PNG = 'ALHAADIACADEMY/school_stamp.png';

// An admin attaches a new school stamp in Muley's panel. Muley prepares it
// with the current stamp beside the new one; Save makes it the stamp through
// the school-assets route (the old one kept first), and Undo brings it back.
describe('Muley: a new school stamp from an attached image', () => {
  let pool, schoolId;
  const storage = supabase._mockStorage;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
    dispatcher.__setTransportForTests(async ({ method, path, headers, body }) => {
      let req = request(getApp())[method.toLowerCase()](path).set(headers);
      if (body !== undefined) req = req.send(body);
      const res = await req;
      return { status: res.status, body: res.body };
    });
  });
  afterAll(() => {
    dispatcher.__setTransportForTests(null);
    provider.__setAdapterForTests(null);
  });

  beforeEach(async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    supabase._reset();
    storage.list.mockResolvedValue({ data: [{ name: 'school_stamp.png' }], error: null });
    storage.download.mockImplementation(async (objectPath) => ({
      data: new Blob([objectPath.includes('/muley-uploads/') ? 'new-bytes' : 'old-bytes'], { type: 'image/png' }), error: null,
    }));
    settings.invalidateAll();
    await settings.save('ALHAADIACADEMY', { enabled: true, roleTeacher: true, roleAdmin: true, allowWrites: true }, null);
    schoolId = (await pool.query(`SELECT school_id FROM schools WHERE school_code = 'ALHAADIACADEMY'`)).rows[0].school_id;
    await pool.query(`INSERT INTO school_assets (school_id, school_code, school_stamp_path) VALUES ($1, 'ALHAADIACADEMY', $2)`, [schoolId, LIVE_PNG]);
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'x', 'Tess', 'Teacher', 'ALHAADIACADEMY', 'TEACHER', true, true)`, [TEACHER.userId, TEACHER.email, TEACHER.email]);
  });

  const attach = (token, filename = 'new-stamp.png', contentType = 'image/png') =>
    authenticatedRequest('post', '/api/assistant/attachments', token).attach('file', Buffer.from('new-bytes'), { filename, contentType });
  const script = (steps) => {
    const fake = fakeProvider(steps);
    provider.__setAdapterForTests(fake);
    return fake;
  };
  const turn = async (body, token) => {
    const res = await authenticatedRequest('post', '/api/assistant/turns', token).send(body);
    const events = res.status === 200 ? res.text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { res, events, of: (t) => events.filter((e) => e.t === t) };
  };
  const versions = async () => (await pool.query(`SELECT version_id, reason FROM school_asset_versions ORDER BY replaced_at, version_id`)).rows;

  it('keeps the attached image in the person\'s own folder, and refuses what is not an image', async () => {
    const res = await attach();
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}\.png$/), name: 'new-stamp.png' });
    expect(storage.upload.mock.calls[0][0]).toBe(`ALHAADIACADEMY/muley-uploads/${ADMIN_ID}/${res.body.data.id}`);

    expect((await attach(undefined, 'notes.txt', 'text/plain')).body.code).toBe('FILE_TYPE');
    await settings.save('ALHAADIACADEMY', { allowWrites: false }, null);
    expect((await attach()).body.code).toBe('WRITES_OFF');
  });

  it('prepares the new stamp beside the current one, saves it on Save, and Undo brings the old one back', async () => {
    const file = (await attach()).body.data;
    const fake = script([[toolCall('propose_school_asset', { asset: 'school_stamp', file: 'f1' }, 'stamp')], [text('Here it is: press Save.')]]);
    const { of } = await turn({ message: 'make this our new stamp', attachments: [file] });

    expect(JSON.stringify(fake.calls[0].messages)).toContain('The person attached an image: \\"new-stamp.png\\" (ref f1)');
    expect(fake.seen()).not.toContain(file.id);
    const [{ action }] = of('action');
    expect(action).toMatchObject({ kind: 'school_asset', applyLabel: 'Save the new school stamp', topics: ['school-assets:ALHAADIACADEMY'] });
    expect(of('card').find((c) => c.id === 'stamp').card).toMatchObject({
      type: 'asset_change', title: 'School stamp', subtitle: 'new-stamp.png', now: 'https://mock-public-url.com', next: 'https://mock-signed-url.com',
    });
    // Nothing is changed before Save.
    expect(await versions()).toEqual([]);

    const saved = await authenticatedRequest('post', `/api/assistant/actions/${action.id}/apply`).send({ expectedHash: action.hash });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ status: 'applied', doneLabel: 'Saved the new school stamp', canUndo: true });
    const kept = await versions();
    expect(kept).toEqual([expect.objectContaining({ reason: 'replaced' })]);
    // The old stamp was copied to its history first, then the attached image went live.
    expect(storage.upload.mock.calls.map(([objectPath]) => objectPath).slice(-2)).toEqual([expect.stringMatching(/^ALHAADIACADEMY\/school_stamp\//), LIVE_PNG]);

    const undone = await authenticatedRequest('post', `/api/assistant/actions/${action.id}/undo`).send({});
    expect(undone.status).toBe(200);
    expect(undone.body.data).toMatchObject({ status: 'undone', undoneLabel: 'Undone. The earlier school stamp is back.' });
    expect((await versions()).map((v) => v.reason)).toEqual(['replaced', 'restored_over']);
  });

  it('refuses an attachment that is not one of the person\'s, and a teacher without school setup', async () => {
    const bad = await turn({ message: 'use this', attachments: [{ id: '../../etc/passwd', name: 'x' }] });
    expect(bad.res.status).toBe(400);
    expect(bad.res.body.code).toBe('INVALID_ATTACHMENT');

    // Someone else's attachment is not one this person can name.
    const adminsFile = (await attach()).body.data;
    const borrowed = await turn({ message: 'new stamp', attachments: [adminsFile] }, TEACHER);
    expect(borrowed.res.body.code).toBe('ATTACHMENT_GONE');

    // A teacher's own image can't become the stamp either: School Assets needs school setup.
    const file = (await attach(TEACHER)).body.data;
    const fake = script([[toolCall('propose_school_asset', { asset: 'school_stamp', file: 'f1' }, 'stamp')], [text('You need an administrator.')]]);
    const { of } = await turn({ message: 'new stamp', attachments: [file] }, TEACHER);
    expect(of('action')).toEqual([]);
    expect(JSON.parse(fake.calls.at(-1).messages.find((m) => m.toolCallId === 'stamp').content).error.code).toBe('FORBIDDEN');
  });

  it('turns an attachment into the asset only for its own uploader', async () => {
    const file = (await attach()).body.data;
    // The admin's file, named by someone else, is looked for in that person's folder: not there.
    storage.download.mockImplementation(async (objectPath) => (objectPath.includes(ADMIN_ID)
      ? { data: new Blob(['new-bytes'], { type: 'image/png' }), error: null }
      : { data: null, error: { message: 'Object not found' } }));
    const other = await authenticatedRequest('post', '/api/school-assets/from-assistant', { userId: '550e8400-e29b-41d4-a716-446655440092', role: 'ADMIN', email: 'other-admin@test.com' })
      .send({ assetType: 'school_stamp', attachmentId: file.id });
    expect([403, 404]).toContain(other.status);
    expect(await versions()).toEqual([]);
  });

  it('removes attachments two days old, files first, and refuses one that is gone', async () => {
    const attachments = require('../../../services/assistant/attachments');
    const fresh = (await attach()).body.data;
    const old = (await attach()).body.data;
    await pool.query(`UPDATE assistant_attachments SET created_at = NOW() - INTERVAL '3 days' WHERE attachment_id = $1`, [old.id]);
    storage.remove.mockClear();

    expect(await attachments.prune()).toBe(1);
    expect(storage.remove).toHaveBeenCalledWith([`ALHAADIACADEMY/muley-uploads/${ADMIN_ID}/${old.id}`]);
    expect((await pool.query(`SELECT attachment_id FROM assistant_attachments`)).rows.map((r) => r.attachment_id)).toEqual([fresh.id]);

    const gone = await turn({ message: 'use the old one', attachments: [old] });
    expect(gone.res.body.code).toBe('ATTACHMENT_GONE');
  });

  it('keeps the rows when storage refuses, to try again the next day', async () => {
    const attachments = require('../../../services/assistant/attachments');
    const old = (await attach()).body.data;
    await pool.query(`UPDATE assistant_attachments SET created_at = NOW() - INTERVAL '3 days' WHERE attachment_id = $1`, [old.id]);
    storage.remove.mockResolvedValueOnce({ data: null, error: { message: 'storage down' } });
    expect(await attachments.prune()).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM assistant_attachments`)).rows[0].n).toBe(1);
  });
});

