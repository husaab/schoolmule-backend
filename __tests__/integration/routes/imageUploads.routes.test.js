// Every route that stores a user's image runs it through the server-side
// safety net (utils/imageResize.js; user request, final fix wave): a phone
// photo bigger than 2000 px (or 1.5 MB) is stored at 2000 px, upright, with
// its EXIF/GPS removed. Avatars, class banners, quiz question images,
// classwork attachments (and replacing one), turned-in work, message and
// announcement attachments. PDFs and GIFs are stored as they came.
// The test photo is generated here; synthetic identities only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const sharp = require('sharp');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const MONA_ID = '550e8400-e29b-41d4-a716-446655440005';
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'ziad.teacher@example.com', role: 'TEACHER' };
const asAmal = { userId: AMAL_USER_ID, username: 'Amal Haddad', email: 'amal.haddad@example.com', role: 'STUDENT', roles: ['STUDENT'] };

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString();

describe('Integration: uploaded images are resized and stripped on the server', () => {
  let pool, yearId, classId, amalId, PHOTO, PDF, GIF;

  beforeAll(async () => {
    getApp();
    pool = getTestPool();
    // A 3200 × 2400 phone photo stored sideways (EXIF orientation 6), with the camera's make and a GPS position.
    PHOTO = await sharp({ create: { width: 3200, height: 2400, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 12 } } })
      .jpeg({ quality: 80 })
      .withExifMerge({ IFD0: { Make: 'ExamplePhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '43/1 39/1 0/1' } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    PDF = Buffer.from('%PDF-1.4 a worksheet');
    GIF = await sharp({ create: { width: 2400, height: 2400, channels: 3, background: '#336699' } }).gif().toBuffer();
  });

  const expectStatus = async (req, status) => {
    const res = await req;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const uploads = () => supabase._mockStorage.upload.mock.calls.map(([path, buffer, options]) => ({ path, buffer, options }));
  // The one photo upload of the request, checked as stored.
  const expectStoredPhoto = async (stored) => {
    expect(stored.options.contentType).toBe('image/jpeg');
    const m = await sharp(stored.buffer).metadata();
    expect(m.format).toBe('jpeg');
    expect([m.width, m.height]).toEqual([1500, 2000]); // upright, 2000 px on the long edge
    expect(m.exif).toBeUndefined();
    expect(m.orientation).toBeUndefined();
    expect(stored.buffer.includes(Buffer.from('ExamplePhone'))).toBe(false);
    expect(stored.buffer.length).toBeLessThan(PHOTO.length);
  };
  const photoUpload = (all) => all.find((u) => u.options.contentType.startsWith('image/jpeg'));

  beforeEach(async () => {
    supabase._reset();
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    const termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', 'Term 1', DATE '2026-09-01', DATE '2027-06-30', TRUE, $1) RETURNING term_id`, [yearId],
    )).rows[0].term_id;
    const user = (id, email, first, last, role) => pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`, [id, email, `${first} ${last}`, first, last, role]);
    await user(TEACHER_ID, 'ziad.teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(MONA_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(AMAL_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`);
    classId = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id)
       VALUES ('ALHAADIACADEMY', '5', 'Science', 'Ziad Teacher', $1, $2, 'Term 1', $3) RETURNING class_id`, [TEACHER_ID, termId, yearId],
    )).rows[0].class_id;
    amalId = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Amal Haddad', '5', 'ALHAADIACADEMY', $1) RETURNING student_id`, [yearId],
    )).rows[0].student_id;
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, amalId]);
    await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [AMAL_USER_ID, amalId, yearId]);
    await pool.query(`INSERT INTO student_accounts (user_id, school, consent_at) VALUES ($1, 'ALHAADIACADEMY', NOW())`, [AMAL_USER_ID]);
    await pool.query(
      `INSERT INTO parent_students (parent_id, student_id, parent_name, parent_email, relation, school)
       VALUES ($1, $2, 'Mona Haddad', 'mona.haddad@example.com', 'Mother', 'ALHAADIACADEMY')`, [MONA_ID, amalId],
    );
  });

  const createItem = async (body) => (await expectStatus(
    authenticatedRequest('post', `/api/classroom/classes/${classId}/items`, asTeacher).send(body), 201,
  )).data;

  it('profile photo, class banner and quiz question image (single-image uploads)', async () => {
    await expectStatus(authenticatedRequest('post', '/api/profile/photo', asTeacher)
      .attach('photo', PHOTO, { filename: 'me.jpg', contentType: 'image/jpeg' }), 200);
    await expectStoredPhoto(uploads()[0]);
    expect(uploads()[0].path).toMatch(/\.jpg$/);

    supabase._reset();
    await expectStatus(authenticatedRequest('post', `/api/classroom/classes/${classId}/banner`, asTeacher)
      .attach('banner', PHOTO, { filename: 'banner.jpg', contentType: 'image/jpeg' }), 200);
    await expectStoredPhoto(uploads()[0]);

    supabase._reset();
    const quiz = await createItem({ kind: 'quiz', title: 'Cells quiz', dueAt: inDays(3), gradebook: { mode: 'none' } });
    await expectStatus(authenticatedRequest('post', `/api/classroom/items/${quiz.itemId}/question-images`, asTeacher)
      .attach('image', PHOTO, { filename: 'cell.jpg', contentType: 'image/jpeg' }), 201);
    await expectStoredPhoto(uploads()[0]);

    // A transparent PNG stays a PNG (and keeps its alpha) while being resized.
    supabase._reset();
    const clear = await sharp({ create: { width: 2400, height: 1200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.4 } } }).png().toBuffer();
    await expectStatus(authenticatedRequest('post', `/api/classroom/items/${quiz.itemId}/question-images`, asTeacher)
      .attach('image', clear, { filename: 'diagram.png', contentType: 'image/png' }), 201);
    const [png] = uploads();
    expect(png.options.contentType).toBe('image/png');
    expect(png.path).toMatch(/\.png$/);
    const m = await sharp(png.buffer).metadata();
    expect([m.format, m.width, m.height, m.hasAlpha]).toEqual(['png', 2000, 1000, true]);
  });

  it('classwork attachments (and replacing a file) store the resized photo; a PDF and a GIF are untouched', async () => {
    const item = await createItem({ kind: 'material', title: 'Cells reading' });
    const res = await expectStatus(authenticatedRequest('post', `/api/classroom/items/${item.itemId}/attachments`, asTeacher)
      .attach('files', PHOTO, { filename: 'board.jpg', contentType: 'image/jpeg' })
      .attach('files', PDF, { filename: 'sheet.pdf', contentType: 'application/pdf' })
      .attach('files', GIF, { filename: 'loop.gif', contentType: 'image/gif' }), 201);
    const all = uploads();
    expect(all).toHaveLength(3);
    await expectStoredPhoto(photoUpload(all));
    expect(all.find((u) => u.options.contentType === 'application/pdf').buffer.equals(PDF)).toBe(true);
    expect(all.find((u) => u.options.contentType === 'image/gif').buffer.equals(GIF)).toBe(true);
    // The row records what was stored.
    const rows = (await pool.query(
      `SELECT file_name, mime_type, size_bytes FROM classwork_attachments WHERE item_id = $1 AND kind = 'file' ORDER BY sort_order`, [item.itemId],
    )).rows;
    const photoRow = rows.find((r) => r.file_name === 'board.jpg');
    expect(Number(photoRow.size_bytes)).toBe(photoUpload(all).buffer.length);
    expect(rows.find((r) => r.file_name === 'sheet.pdf').size_bytes).toBe(PDF.length);

    // Replacing a file: an opaque screenshot PNG comes back a JPEG, named so.
    supabase._reset();
    const attachmentId = (Array.isArray(res.data) ? res.data : res.data.attachments).find((a) => a.fileName === 'sheet.pdf').attachmentId;
    const shot = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#eeeeee' } }).png().toBuffer();
    const replaced = await expectStatus(authenticatedRequest('put', `/api/classroom/attachments/${attachmentId}/file`, asTeacher)
      .attach('file', shot, { filename: 'Screenshot.png', contentType: 'image/png' }), 200);
    expect(replaced.data).toMatchObject({ fileName: 'Screenshot.jpg' });
    const [stored] = uploads();
    expect(stored.options.contentType).toBe('image/jpeg');
    expect(stored.path).toMatch(/\.jpg$/);
    expect((await sharp(stored.buffer).metadata()).width).toBe(2000);
  });

  it("a student's turned-in photo is stored resized and without GPS", async () => {
    const item = await createItem({ kind: 'assignment', title: 'Plant cell diagram', submissionMode: 'file', dueAt: inDays(2), gradebook: { mode: 'none' } });
    const res = await expectStatus(authenticatedRequest('post', `/api/student/items/${item.itemId}/files`, asAmal)
      .attach('files', PHOTO, { filename: 'IMG_0042.jpg', contentType: 'image/jpeg' }), 201);
    await expectStoredPhoto(uploads()[0]);
    expect(res.data.files).toEqual([expect.objectContaining({ fileName: 'IMG_0042.jpg', mimeType: 'image/jpeg', sizeBytes: uploads()[0].buffer.length })]);
  });

  it('message and announcement attachments store the resized photo', async () => {
    const thread = (await expectStatus(authenticatedRequest('post', '/api/student/conversations', asAmal)
      .send({ teacherId: TEACHER_ID, classId, subject: 'Lab photo', body: 'Here is my lab.' }), 201)).data.conversation.conversationId;
    await expectStatus(authenticatedRequest('post', `/api/messaging/conversations/${thread}/messages`, asTeacher)
      .field('body', 'Your setup, labelled.')
      .attach('files', PHOTO, { filename: 'lab.jpg', contentType: 'image/jpeg' }), 201);
    await expectStoredPhoto(uploads()[0]);
    const [att] = (await pool.query(
      `SELECT a.size_bytes, a.mime_type FROM message_attachments a JOIN messages m ON m.message_id = a.message_id WHERE m.conversation_id = $1`, [thread],
    )).rows;
    expect(att.mime_type).toBe('image/jpeg');
    expect(Number(att.size_bytes)).toBe(uploads()[0].buffer.length);

    supabase._reset();
    await expectStatus(authenticatedRequest('post', '/api/announcements', asTeacher)
      .field('scope', 'class').field('classId', classId).field('title', 'Science fair').field('body', 'Our boards.')
      .attach('files', PHOTO, { filename: 'fair.jpg', contentType: 'image/jpeg' }), 201);
    await expectStoredPhoto(uploads()[0]);
  });
});
