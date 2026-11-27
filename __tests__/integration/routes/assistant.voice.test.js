jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

process.env.ASSISTANT_TURNS_PER_MINUTE = '10000';

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const settings = require('../../../services/assistant/settings');

const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440088', role: 'TEACHER', email: 'voice-a@test.com' };
const OPENAI = 'https://api.openai.com/v1/audio/transcriptions';

// Muley's microphone: a recording becomes text for the composer. The audio
// goes to OpenAI and is not kept; every use counts against the AI limits.
describe('Muley: voice to text', () => {
  let pool, realFetch, sent, answer;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
    realFetch = global.fetch;
    global.fetch = async (url, init) => {
      if (String(url) !== OPENAI) return realFetch(url, init);
      const form = init.body;
      sent.push({ model: form.get('model'), keywords: form.getAll('keywords[]'), file: form.get('file') });
      return answer(sent.length);
    };
  });
  afterAll(() => { global.fetch = realFetch; });

  beforeEach(async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    sent = [];
    answer = () => new Response(JSON.stringify({ text: ' Mark everyone present except Yusuf. ', usage: { input_tokens: 40, output_tokens: 9 } }), { status: 200 });
    settings.invalidateAll();
    await settings.save('ALHAADIACADEMY', { enabled: true, roleTeacher: true, roleAdmin: true }, null);
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'x', 'Tess', 'Teacher', 'ALHAADIACADEMY', 'TEACHER', true, true)`, [TEACHER.userId, TEACHER.email, TEACHER.email]);
  });

  const record = (contentType = 'audio/webm', bytes = 'opus-bytes', token = TEACHER) =>
    authenticatedRequest('post', '/api/assistant/transcribe', token).attach('audio', Buffer.from(bytes), { filename: 'clip', contentType });

  it('turns a recording into text with the school\'s own words, and counts it', async () => {
    const res = await record();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ text: 'Mark everyone present except Yusuf.' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: 'gpt-transcribe', keywords: expect.arrayContaining(['Muley', 'School Mule']) });
    expect(sent[0].file.name).toBe('recording.webm');
    const { rows } = await pool.query(`SELECT requests, input_tokens, output_tokens FROM ai_usage_daily WHERE user_id = $1 AND feature = 'assistant_voice'`, [TEACHER.userId]);
    expect(rows.map((r) => [Number(r.requests), Number(r.input_tokens), Number(r.output_tokens)])).toEqual([[1, 40, 9]]);
  });

  it('asks again without keywords when the model refuses them', async () => {
    answer = (n) => (n === 1
      ? new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'keywords'", param: 'keywords' } }), { status: 400 })
      : new Response(JSON.stringify({ text: 'Hello' }), { status: 200 }));
    const res = await record('audio/mp4');
    expect(res.body.data.text).toBe('Hello');
    expect(sent.map((s) => s.keywords.length > 0)).toEqual([true, false]);
    expect(sent[1].file.name).toBe('recording.m4a');
  });

  it('says plainly what went wrong, and keeps nothing', async () => {
    expect((await record('text/plain')).body.code).toBe('AUDIO_TYPE');
    answer = () => new Response(JSON.stringify({ text: '   ' }), { status: 200 });
    expect((await record()).body.code).toBe('NOTHING_HEARD');
    answer = () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    const failed = await record();
    expect(failed.status).toBe(502);
    expect(failed.body.message).toMatch(/type your message/);
    delete process.env.OPENAI_API_KEY;
    expect((await record()).status).toBe(503);
  });

  it('is off where Muley is off, and refuses a student', async () => {
    await settings.save('ALHAADIACADEMY', { enabled: false }, null);
    expect((await record()).status).toBe(403);
    expect(sent).toEqual([]);
  });
});
