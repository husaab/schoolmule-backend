// Parent–teacher meetings against the real schema: the office sets up and
// opens an event, families are invited (one tap, or create your account),
// parents book first come, first served, the office moves and cancels, the
// sweep sends the evening-before emails, and a booked time never vanishes.
// Event days are in 2027 so every time is still ahead of the real clock.
// Synthetic identities only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { getResend } = require('../../../utils/emailUtils');
const { deliverQueuedEmails } = require('../../helpers/emailOutbox');
const booking = require('../../../services/meetings/booking');
const scheduler = require('../../../services/meetings/scheduler');
const { torontoAt } = require('../../../services/meetings/time');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const SALEH = '770e8400-e29b-41d4-a716-446655440001';
const FAROUK = '770e8400-e29b-41d4-a716-446655440002';
const KHALIL = '770e8400-e29b-41d4-a716-446655440003';
const SALAAT_ONLY = '770e8400-e29b-41d4-a716-446655440004';
const AMAL = '770e8400-e29b-41d4-a716-446655440005';
const RASHA = '770e8400-e29b-41d4-a716-446655440006';

const MON = '2027-02-01';
const TUE = '2027-02-02';
const H = (h, m = 0) => h * 60 + m;

describe('Integration: parent–teacher meetings', () => {
  let pool, yearId, adam, lina, kareem, dina;
  const sent = () => getResend().emails.send.mock.calls.map(([msg]) => msg);
  const office = (method, url) => authenticatedRequest(method, `/api/meetings${url}`);
  const asTeacher = (id, method, url) => authenticatedRequest(method, `/api/meetings${url}`, {
    userId: id, role: 'TEACHER', email: `${id}@example.com`, username: 'Teacher',
  });
  const asParent = (id, method, url) => authenticatedRequest(method, `/api/parent-portal${url}`, {
    userId: id, role: 'PARENT', email: id === AMAL ? 'amal.parent@example.com' : 'rasha.parent@example.com', username: 'Parent',
  });

  const user = (id, email, first, last, role, { password = 'hashed', honorific = null } = {}) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, honorific)
     VALUES ($1, $2, $3, $4, $5, $6, 'ALHAADIACADEMY', $7, TRUE, TRUE, $8)`,
    [id, email, `${first} ${last}`, password, first, last, role, honorific],
  );
  const student = async (name, grade, homeroom, extra = {}) => (await pool.query(
    `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id, mother_name, mother_email)
     VALUES ($1, $2, 'ALHAADIACADEMY', $3, $4, $5, $6) RETURNING student_id`,
    [name, grade, yearId, homeroom, extra.motherName || null, extra.motherEmail || null],
  )).rows[0].student_id;
  const klass = async (subject, grade, teacherId, kids, { onReportCard = true } = {}) => {
    const id = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id, term_name, on_report_card)
       VALUES ('ALHAADIACADEMY', $1, $2, 'T', $3, $4, 'Term 1', $5) RETURNING class_id`,
      [grade, subject, teacherId, yearId, onReportCard],
    )).rows[0].class_id;
    for (const k of kids) await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [id, k]);
    return id;
  };
  const link = (parentId, studentId, name, email) => pool.query(
    `INSERT INTO parent_students (parent_id, student_id, parent_name, parent_email, relation, school)
     VALUES ($1, $2, $3, $4, 'Mother', 'ALHAADIACADEMY')`,
    [parentId, studentId, name, email],
  );
  const outbox = async (kind) => (await pool.query(
    `SELECT kind, status, LOWER(recipient_email) AS email, payload, skip_reason FROM email_outbox
     WHERE ($1::text IS NULL OR kind = $1) ORDER BY created_at, recipient_email`,
    [kind || null],
  )).rows;

  async function createEvent() {
    const res = await office('post', '/events').send({
      title: 'Parent–teacher meetings',
      days: [{ date: MON, start: H(15, 30), end: H(17, 30) }, { date: TUE, start: H(9), end: H(10) }],
    });
    expect(res.status).toBe(201);
    const eventId = res.body.data.eventId;
    const setupRes = await office('get', `/events/${eventId}`);
    const [mon, tue] = setupRes.body.data.days;
    return { eventId, mon: mon.dayId, tue: tue.dayId, setup: setupRes.body.data };
  }

  beforeAll(() => { getApp(); pool = getTestPool(); });

  beforeEach(async () => {
    getResend().emails.send.mockClear();
    ({ rows: [{ school_year_id: yearId }] } = await pool.query(
      "SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active",
    ));
    await user(SALEH, 'saleh.teacher@example.com', 'Layla', 'Saleh', 'TEACHER', { honorific: 'Ms.' });
    await user(FAROUK, 'farouk.teacher@example.com', 'Omar', 'Farouk', 'TEACHER', { honorific: 'Mr.' });
    await user(KHALIL, 'khalil.teacher@example.com', 'Noor', 'Khalil', 'TEACHER', { honorific: 'Ms.' });
    await user(SALAAT_ONLY, 'salaat.teacher@example.com', 'Sami', 'Prayer', 'TEACHER', { honorific: 'Mr.' });
    await user(AMAL, 'amal.parent@example.com', 'Amal', 'Haddad', 'PARENT');
    await user(RASHA, 'rasha.parent@example.com', 'Rasha', 'Nasser', 'PARENT');
    adam = await student('Adam Haddad', '5', SALEH);
    lina = await student('Lina Haddad', '2', KHALIL);
    kareem = await student('Kareem Nasser', '5', SALEH);
    // No guardian row, only the address on the student file: the opening invites them to make an account.
    dina = await student('Dina Mansour', 'SK', KHALIL, { motherName: 'Karima Mansour', motherEmail: 'karima.mansour@example.com' });
    await klass('Math', '5', SALEH, [adam, kareem]);
    await klass('Arabic', '5', FAROUK, [adam, kareem]);
    await klass('Arabic', '2', FAROUK, [lina]);
    await klass('Salaat', '5', SALAAT_ONLY, [adam, kareem], { onReportCard: false });
    await link(AMAL, adam, 'Amal Haddad', 'amal.parent@example.com');
    await link(AMAL, lina, 'Amal Haddad', 'amal.parent@example.com');
    await link(RASHA, kareem, 'Rasha Nasser', 'rasha.parent@example.com');
  });

  it('sets up, opens, invites every family at once, and books first come, first served', async () => {
    const { eventId, mon, tue, setup } = await createEvent();
    // The teachers are the report-card classes' and homerooms', never Salaat's.
    expect(setup.teachers.map((t) => t.name)).toEqual(['Mr. Omar Farouk', 'Ms. Layla Saleh', 'Ms. Noor Khalil'].sort());
    expect(setup.teachers.find((t) => t.teacherId === FAROUK).families).toBe(2);
    expect(setup.days[0].timesPerTeacher).toBe(12);
    // Counted per family: the Haddads and the Nassers have accounts; the Mansours only an address on the student file.
    expect(setup.stats).toMatchObject({ families: 3, oneTap: 2, createAccount: 1, noEmail: 0 });

    // Maghrib for everyone on Monday.
    expect((await office('post', `/events/${eventId}/days/${mon}/breaks`).send({ start: H(16, 40), end: H(17), label: 'Maghrib' })).status).toBe(201);

    // Open now: Amal and Rasha get one-tap invitations; the address on Dina's file gets an account and a create-your-account link.
    const opened = await office('post', `/events/${eventId}/schedule`).send({});
    expect(opened.status).toBe(200);
    expect(opened.body.data.status).toBe('open');
    const pending = (await pool.query("SELECT user_id, password, role FROM users WHERE email = 'karima.mansour@example.com'")).rows;
    expect(pending).toEqual([expect.objectContaining({ password: '!', role: 'PARENT' })]);
    expect((await outbox('ptm_invite')).map((r) => r.email).sort())
      .toEqual(['amal.parent@example.com', 'karima.mansour@example.com', 'rasha.parent@example.com']);
    await deliverQueuedEmails(pool);
    const toAmal = sent().find((m) => m.to[0] === 'amal.parent@example.com');
    expect(toAmal.subject).toBe('Book your parent–teacher meetings · Mon Feb 1 & Tue Feb 2');
    expect(toAmal.html).toContain('Hi Amal,');
    expect(toAmal.html).toContain('/email-login?next=%2Fparent%2Fmeetings#');
    expect(toAmal.html).toContain('Plan my visit for me');
    const toKarima = sent().find((m) => m.to[0] === 'karima.mansour@example.com');
    expect(toKarima.html).toContain('Create your account to book');
    expect(toKarima.html).toContain('/reset-password?token=');
    expect(toKarima.html).toContain('next=%2Fparent%2Fmeetings');

    // Amal sees both children and their three teachers; never the Salaat teacher.
    const page = await asParent(AMAL, 'get', '/meetings');
    expect(page.status).toBe(200);
    const [event] = page.body.data.events;
    expect(event.children.map((c) => c.firstName)).toEqual(['Adam', 'Lina']);
    expect(event.teachers.map((t) => t.teacherId).sort()).toEqual([FAROUK, KHALIL, SALEH].sort());
    const farouk = event.teachers.find((t) => t.teacherId === FAROUK);
    expect(farouk.studentIds.sort()).toEqual([adam, lina].sort());
    expect(farouk.days.find((d) => d.dayId === mon).open.map((s) => s.start)).not.toContain(H(16, 40));

    // One meeting with Mr. Farouk for both children, and Adam's homeroom meeting after it.
    getResend().emails.send.mockClear();
    const booked = await asParent(AMAL, 'post', `/meetings/${eventId}/bookings`).send({
      items: [
        { teacherId: FAROUK, dayId: mon, startMin: H(15, 30), studentIds: [adam, lina] },
        { teacherId: SALEH, dayId: mon, startMin: H(15, 40), studentIds: [adam] },
      ],
    });
    expect(booked.status).toBe(201);
    expect(booked.body.data.bookingIds).toHaveLength(2);
    expect(booked.body.data.event.bookings.find((b) => b.teacherId === FAROUK).room).toBe('Grade 5 room');

    // First come, first served: the time is gone for Rasha.
    const race = await asParent(RASHA, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: FAROUK, dayId: mon, startMin: H(15, 30), studentIds: [kareem] });
    expect(race.status).toBe(409);
    expect(race.body.code).toBe('TIME_TAKEN');
    // A family is never in two meetings at once; a child meets each teacher once; only your own children.
    const busy = await asParent(AMAL, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: KHALIL, dayId: mon, startMin: H(15, 40), studentIds: [lina] });
    expect(busy.body.code).toBe('FAMILY_BUSY');
    const again = await asParent(AMAL, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: FAROUK, dayId: tue, startMin: H(9), studentIds: [lina] });
    expect(again.body.code).toBe('ALREADY_BOOKED');
    const notMine = await asParent(AMAL, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: SALEH, dayId: tue, startMin: H(9), studentIds: [kareem] });
    expect(notMine.status).toBe(403);
    const salaat = await asParent(AMAL, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: SALAAT_ONLY, dayId: tue, startMin: H(9), studentIds: [adam] });
    expect(salaat.body.code).toBe('NOT_TAKING_PART');

    // One confirmation with the full list and a calendar file.
    await deliverQueuedEmails(pool);
    const confirmations = sent().filter((m) => m.to[0] === 'amal.parent@example.com');
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].subject).toBe('Booked: 2 parent–teacher meetings');
    expect(confirmations[0].html).toContain('Mr. Omar Farouk · Arabic');
    expect(confirmations[0].html).toContain('Adam &amp; Lina · Grade 5 room');
    expect(confirmations[0].html).toContain('Ms. Layla Saleh · Homeroom, Math');
    expect(confirmations[0].attachments.map((a) => a.filename)).toEqual(['meetings.ics']);
    expect(confirmations[0].attachments[0].content.toString()).toContain('DTSTART:20270201T203000Z');

    // Past the cutoff (8 PM the evening before), parents can't book or cancel that day.
    const late = booking.book({
      school: 'ALHAADIACADEMY', eventId, user: { userId: RASHA }, kind: 'parent',
      items: [{ teacherId: SALEH, dayId: mon, startMin: H(16), studentIds: [kareem] }],
      now: torontoAt('2027-01-31', H(20, 1)),
    });
    await expect(late).rejects.toMatchObject({ code: 'PAST_CUTOFF' });
  });

  it('never strands a booked family: hours, breaks, closing and removing a day are refused', async () => {
    const { eventId, mon } = await createEvent();
    await office('post', `/events/${eventId}/schedule`).send({});
    const res = await asParent(AMAL, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: SALEH, dayId: mon, startMin: H(16), studentIds: [adam] });
    expect(res.status).toBe(201);

    const shorter = await office('put', `/events/${eventId}/teachers/${SALEH}`).send({ days: [{ dayId: mon, works: true, start: H(15, 30), end: H(15, 50) }] });
    expect(shorter.status).toBe(409);
    expect(shorter.body.code).toBe('BOOKED_TIMES');
    expect(shorter.body.bookings[0].label).toContain('4:00 PM · Ms. Layla Saleh · Adam Haddad');
    expect((await office('post', `/events/${eventId}/days/${mon}/breaks`).send({ start: H(15, 55), end: H(16, 5) })).status).toBe(409);
    expect((await office('put', `/events/${eventId}`).send({ slotMinutes: 15 })).status).toBe(409);
    expect((await office('delete', `/events/${eventId}/days/${mon}`)).status).toBe(409);
    expect((await office('put', `/events/${eventId}/teachers/${SALEH}`).send({ takingPart: false })).status).toBe(409);

    // Own hours that keep 4:00 are fine, as is another teacher's change.
    const own = await office('put', `/events/${eventId}/teachers/${SALEH}`).send({
      slotMinutes: null, room: 'Library', days: [{ dayId: mon, works: true, start: H(15, 30), end: H(16, 30), breaks: [{ start: H(16, 10), end: H(16, 20), label: 'Pickup' }] }],
    });
    expect(own.status).toBe(200);
    const saleh = own.body.data.teachers.find((t) => t.teacherId === SALEH);
    expect(saleh.room).toBe('Library');
    expect(saleh.days.find((d) => d.dayId === mon)).toMatchObject({ ownHours: true, start: H(15, 30), end: H(16, 30), times: 5 });

    // The teacher: a booked time can't be closed; an open one can, and reopened.
    expect((await asTeacher(SALEH, 'post', `/events/${eventId}/my-closed`).send({ dayId: mon, start: H(16), end: H(16, 10) })).status).toBe(409);
    const closed = await asTeacher(SALEH, 'post', `/events/${eventId}/my-closed`).send({ dayId: mon, start: H(15, 30), end: H(15, 40), label: 'Prep' });
    expect(closed.status).toBe(201);
    const mine = await asTeacher(SALEH, 'get', '/mine');
    const monday = mine.body.data.events[0].days.find((d) => d.dayId === mon);
    expect(monday.slots.find((s) => s.start === H(15, 30))).toMatchObject({ closed: true, closedLabel: 'Prep' });
    const meeting = monday.slots.find((s) => s.start === H(16)).booking;
    expect(meeting.room).toBe('Library');
    expect(meeting.students[0]).toMatchObject({ name: 'Adam Haddad', homeroom: true, subjects: ['Math'] });
    expect(meeting.students[0].classes).toHaveLength(1);
    expect((await asTeacher(SALEH, 'delete', `/events/${eventId}/my-closed/${closed.body.data.breakId}`)).status).toBe(200);
    // Another teacher can't reopen it, and teachers can't reach the office's setup.
    expect((await asTeacher(FAROUK, 'get', `/events/${eventId}`)).status).toBe(403);
  });

  it('the office books for a family, moves and cancels; the family is told each time', async () => {
    const { eventId, mon, tue } = await createEvent();
    await office('post', `/events/${eventId}/schedule`).send({});
    await deliverQueuedEmails(pool);
    getResend().emails.send.mockClear();

    const families = await office('get', `/events/${eventId}/families?q=haddad`);
    expect(families.body.data).toHaveLength(1);
    expect(families.body.data[0].children.map((c) => c.firstName)).toEqual(['Adam', 'Lina']);

    const made = await office('post', `/events/${eventId}/bookings`).send({ teacherId: FAROUK, dayId: mon, startMin: H(15, 30), studentIds: [adam, lina] });
    expect(made.status).toBe(201);
    const [bookingId] = made.body.data.bookingIds;
    const board = await office('get', `/events/${eventId}/board?dayId=${mon}`);
    const col = board.body.data.columns.find((c) => c.teacherId === FAROUK);
    expect(col.cells[0]).toMatchObject({ kind: 'booked', booking: { family: 'Haddad', kids: 'Adam & Lina' } });

    expect((await office('patch', `/events/${eventId}/bookings/${bookingId}`).send({ dayId: tue, startMin: H(9, 10) })).status).toBe(200);
    await deliverQueuedEmails(pool);
    const changed = sent().filter((m) => m.to[0] === 'amal.parent@example.com');
    expect(changed).toHaveLength(1);
    expect(changed[0].subject).toBe('The school changed your parent–teacher meetings');
    expect(changed[0].html).toContain('Mr. Omar Farouk (Adam &amp; Lina): booked for Tue, Feb 2 at 9:10 AM');

    getResend().emails.send.mockClear();
    expect((await office('delete', `/events/${eventId}/bookings/${bookingId}`)).status).toBe(200);
    await deliverQueuedEmails(pool);
    const cancelled = sent().find((m) => m.to[0] === 'amal.parent@example.com');
    expect(cancelled.subject).toBe('Your parent–teacher meetings were cancelled');
    expect(cancelled.attachments.map((a) => a.filename)).toEqual(['cancelled.ics']);
  });

  it('a family can choose a phone call: the number is kept, the teacher sees it, and switching keeps the time', async () => {
    const { eventId, mon } = await createEvent();
    await office('post', `/events/${eventId}/schedule`).send({});
    await deliverQueuedEmails(pool);
    getResend().emails.send.mockClear();
    await pool.query("UPDATE parent_students SET parent_number = '416-555-0100' WHERE parent_id = $1", [AMAL]);

    // The number on file is suggested.
    let view = (await asParent(AMAL, 'get', '/meetings')).body.data.events[0];
    expect(view).toMatchObject({ allowPhone: true, phone: '416-555-0100' });

    const book = (body) => asParent(AMAL, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: SALEH, dayId: mon, startMin: H(15, 30), studentIds: [adam], ...body });
    expect((await book({ mode: 'phone' })).body.code).toBe('BAD_PHONE');
    expect((await book({ mode: 'phone', phone: 'call me' })).body.code).toBe('BAD_PHONE');
    expect((await book({ mode: 'video' })).body.code).toBe('BAD_MODE');
    const made = await book({ mode: 'phone', phone: ' 647 555  0199 ' });
    expect(made.status).toBe(201);
    const [bookingId] = made.body.data.bookingIds;
    expect(made.body.data.event.bookings[0]).toMatchObject({ bookingId, mode: 'phone', phone: '647 555 0199', room: null });
    // Next time, the number they gave.
    expect(made.body.data.event.phone).toBe('647 555 0199');

    // The teacher sees the number to call.
    const mine = (await asTeacher(SALEH, 'get', '/mine')).body.data.events[0];
    const slot = mine.days[0].slots.find((s) => s.start === H(15, 30));
    expect(slot.booking).toMatchObject({ mode: 'phone', phone: '647 555 0199', room: null });

    await deliverQueuedEmails(pool);
    const confirm = sent().find((m) => m.to[0] === 'amal.parent@example.com');
    expect(confirm.html).toContain('Adam · Phone call to 647 555 0199');
    const ics = confirm.attachments.find((a) => a.filename === 'meetings.ics').content.toString();
    expect(ics).toContain('LOCATION:Phone call to 647 555 0199');
    expect(ics).toContain('DESCRIPTION:Ms. Layla Saleh will call you at 647 555 0199.');

    // Switching to in person keeps the time; the email says what changed.
    getResend().emails.send.mockClear();
    const switched = await asParent(AMAL, 'patch', `/meetings/${eventId}/bookings/${bookingId}`).send({ mode: 'in_person' });
    expect(switched.status).toBe(200);
    expect(switched.body.data.event.bookings[0]).toMatchObject({ start: H(15, 30), mode: 'in_person', phone: null, room: 'Grade 5 room' });
    await deliverQueuedEmails(pool);
    const update = sent().find((m) => m.to[0] === 'amal.parent@example.com');
    // A parent's own change lists their meetings as they now stand.
    expect(update.html).toContain('Adam · Grade 5 room');
    expect(update.html).not.toContain('Phone call');

    // The teacher calls the family; a teacher's own number is never shown, even one on their account.
    await pool.query("UPDATE users SET phone = '905-555-0111' WHERE user_id = $1", [SALEH]);
    await asParent(AMAL, 'patch', `/meetings/${eventId}/bookings/${bookingId}`).send({ mode: 'phone', phone: '647 555 0199' });
    const mine2 = (await asParent(AMAL, 'get', '/meetings')).body.data.events[0];
    expect(mine2.bookings[0]).toMatchObject({ mode: 'phone', phone: '647 555 0199' });
    expect(JSON.stringify(mine2)).not.toContain('905-555-0111');
    expect((await asTeacher(SALEH, 'put', `/events/${eventId}/my-call-from`).send({ callFrom: '905-555-0122' })).status).toBe(404);
    const setupNow = (await office('get', `/events/${eventId}`)).body.data;
    expect(JSON.stringify(setupNow.teachers)).not.toContain('905-555-0111');
    getResend().emails.send.mockClear();
    await deliverQueuedEmails(pool);
    const noFrom = sent().find((m) => m.to[0] === 'amal.parent@example.com');
    expect(noFrom.html).toContain('Phone call to 647 555 0199');
    expect(noFrom.html).not.toContain('905-555-0111');
    expect(noFrom.attachments.find((a) => a.filename === 'meetings.ics').content.toString().replace(/\r?\n[ \t]/g, ''))
      .toContain('DESCRIPTION:Ms. Layla Saleh will call you at 647 555 0199.');
    // Back to in person for the rest.
    await asParent(AMAL, 'patch', `/meetings/${eventId}/bookings/${bookingId}`).send({ mode: 'in_person' });
    await deliverQueuedEmails(pool);

    // The office turns phone calls off: parents can't choose one; the office still can.
    expect((await office('put', `/events/${eventId}`).send({ allowPhone: false })).status).toBe(200);
    view = (await asParent(AMAL, 'get', '/meetings')).body.data.events[0];
    expect(view.allowPhone).toBe(false);
    const refused = await asParent(AMAL, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: FAROUK, dayId: mon, startMin: H(15, 30), studentIds: [adam], mode: 'phone', phone: '416-555-0100' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NO_PHONE');
    const byOffice = await office('post', `/events/${eventId}/bookings`).send({ teacherId: FAROUK, dayId: mon, startMin: H(15, 40), studentIds: [adam, lina], mode: 'phone', phone: '416-555-0100' });
    expect(byOffice.status).toBe(201);
    const board = await office('get', `/events/${eventId}/board?dayId=${mon}`);
    const cell = board.body.data.columns.find((c) => c.teacherId === FAROUK).cells.find((c) => c.start === H(15, 40));
    expect(cell.booking).toMatchObject({ mode: 'phone', phone: '416-555-0100', room: null });

    // The office switches it to in person: the family is told what changed.
    await deliverQueuedEmails(pool);
    getResend().emails.send.mockClear();
    const [officeBookingId] = byOffice.body.data.bookingIds;
    expect((await office('patch', `/events/${eventId}/bookings/${officeBookingId}`).send({ mode: 'in_person' })).status).toBe(200);
    await deliverQueuedEmails(pool);
    const told = sent().find((m) => m.to[0] === 'amal.parent@example.com');
    expect(told.html).toContain('Mr. Omar Farouk (Adam &amp; Lina), Mon, Feb 1 at 3:40 PM: now in person');
  });

  it('sends the evening-before reminder, the teachers\' lists and "times still open" once each', async () => {
    const { eventId, mon } = await createEvent();
    await office('put', `/events/${eventId}`).send({ lastCallAt: torontoAt('2027-01-31', H(10)).toISOString() });
    await office('post', `/events/${eventId}/schedule`).send({});
    await asParent(AMAL, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: SALEH, dayId: mon, startMin: H(15, 30), studentIds: [adam] });
    await deliverQueuedEmails(pool);
    getResend().emails.send.mockClear();
    scheduler.resetScheduleState();

    // Sunday 10 AM: the families with no meetings yet.
    await scheduler.runSchedule(torontoAt('2027-01-31', H(10, 1)));
    await scheduler.runSchedule(torontoAt('2027-01-31', H(10, 2)));
    // (Dina's family too: the opening made Karima an account.)
    expect((await outbox('ptm_last_call')).map((r) => r.email).sort()).toEqual(['karima.mansour@example.com', 'rasha.parent@example.com']);
    // Sunday 6 PM: Amal's reminder; 8 PM: Ms. Saleh's list.
    await scheduler.runSchedule(torontoAt('2027-01-31', H(18, 1)));
    await scheduler.runSchedule(torontoAt('2027-01-31', H(20, 1)));
    await scheduler.runSchedule(torontoAt('2027-01-31', H(20, 2)));
    expect((await outbox('ptm_reminder')).map((r) => r.email)).toEqual(['amal.parent@example.com']);
    expect((await outbox('ptm_teacher_list')).map((r) => r.email)).toEqual(['saleh.teacher@example.com']);
    await deliverQueuedEmails(pool);
    const mail = sent();
    expect(mail.find((m) => m.to[0] === 'amal.parent@example.com').subject).toBe('Tomorrow: your meetings start at 3:30 PM');
    const list = mail.find((m) => m.to[0] === 'saleh.teacher@example.com');
    expect(list.subject).toBe('Your 1 parent–teacher meeting tomorrow');
    expect(list.html).toContain('Adam Haddad · Homeroom, Math');
    expect(list.html).toContain(`/my-meetings?event=${eventId}&amp;day=${mon}&amp;print=1`);
    const rasha = mail.find((m) => m.to[0] === 'rasha.parent@example.com');
    expect(rasha.subject).toBe('Times are still open for parent–teacher meetings');
  });

  it('a day only for some teachers: their families see and book it, the other families never hear of it', async () => {
    const WED = '2027-02-03';
    const { eventId, mon, tue } = await createEvent();
    const wedBody = { date: WED, start: H(9), end: H(10), everyone: false };

    // A day for some teachers names them, and each has families to meet.
    expect((await office('post', `/events/${eventId}/days`).send(wedBody)).body.code).toBe('PICK_TEACHERS');
    expect((await office('post', `/events/${eventId}/days`).send({ ...wedBody, teacherIds: [SALAAT_ONLY] })).body.code).toBe('TEACHER_NOT_FOUND');
    const added = await office('post', `/events/${eventId}/days`).send({ ...wedBody, teacherIds: [KHALIL] });
    expect(added.status).toBe(201);
    const wed = added.body.data.dayId;

    // Ms. Khalil is part time: not in on Monday or Tuesday.
    const off = await office('put', `/events/${eventId}/teachers/${KHALIL}`).send({ days: [{ dayId: mon, works: false }, { dayId: tue, works: false }] });
    expect(off.status).toBe(200);
    const day = (setup) => setup.days.find((d) => d.dayId === wed);
    const works = (setup, teacherId) => setup.teachers.find((t) => t.teacherId === teacherId).days.find((d) => d.dayId === wed).works;
    expect(day(off.body.data)).toMatchObject({ everyone: false, teacherIds: [KHALIL] });
    expect([KHALIL, SALEH, FAROUK].map((id) => works(off.body.data, id))).toEqual([true, false, false]);

    await office('post', `/events/${eventId}/schedule`).send({});
    await deliverQueuedEmails(pool);
    // The Nassers' teachers don't meet on Wednesday; Lina Haddad's homeroom teacher does.
    expect(sent().find((m) => m.to[0] === 'rasha.parent@example.com').subject).toBe('Book your parent–teacher meetings · Mon Feb 1 & Tue Feb 2');
    expect(sent().find((m) => m.to[0] === 'amal.parent@example.com').subject).toBe('Book your parent–teacher meetings · Mon Feb 1, Tue Feb 2 & Wed Feb 3');
    const pageFor = async (id) => (await asParent(id, 'get', '/meetings')).body.data.events[0];
    expect((await pageFor(RASHA)).days.map((d) => d.date)).toEqual([MON, TUE]);
    const amal = await pageFor(AMAL);
    expect(amal.days.map((d) => d.date)).toEqual([MON, TUE, WED]);
    expect(amal.teachers.find((t) => t.teacherId === KHALIL).days.map((d) => d.works)).toEqual([false, false, true]);

    const refused = await asParent(RASHA, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: SALEH, dayId: wed, startMin: H(9), studentIds: [kareem] });
    expect(refused.body.code).toBe('TIME_GONE');
    const booked = await asParent(AMAL, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: KHALIL, dayId: wed, startMin: H(9), studentIds: [lina] });
    expect(booked.status).toBe(201);

    // Changing who the day is for never strands the booked family, and keeps a teacher's own hours.
    const dayUrl = `/events/${eventId}/days/${wed}`;
    const without = await office('put', dayUrl).send({ everyone: false, teacherIds: [FAROUK] });
    expect(without.status).toBe(409);
    expect(without.body.code).toBe('BOOKED_TIMES');
    expect((await office('put', `/events/${eventId}/teachers/${KHALIL}`).send({ days: [{ dayId: wed, works: true, start: H(9), end: H(9, 30) }] })).status).toBe(200);
    expect((await office('put', dayUrl).send({ everyone: false, teacherIds: [KHALIL, FAROUK] })).status).toBe(200);
    let setup = (await office('get', `/events/${eventId}`)).body.data;
    expect(day(setup).teacherIds.sort()).toEqual([FAROUK, KHALIL].sort());
    expect(setup.teachers.find((t) => t.teacherId === KHALIL).days.find((d) => d.dayId === wed)).toMatchObject({ works: true, ownHours: true, end: H(9, 30) });
    expect((await pageFor(RASHA)).days.map((d) => d.date)).toEqual([MON, TUE, WED]);

    // Every teacher's day after all, then back to Ms. Khalil alone (the teachers have to be named).
    expect((await office('put', dayUrl).send({ everyone: true })).status).toBe(200);
    expect((await office('put', dayUrl).send({ everyone: false })).body.code).toBe('PICK_TEACHERS');
    setup = (await office('get', `/events/${eventId}`)).body.data;
    expect(day(setup)).toMatchObject({ everyone: true, teacherIds: [] });
    expect([KHALIL, SALEH, FAROUK].map((id) => works(setup, id))).toEqual([true, true, true]);
    expect((await pool.query('SELECT teacher_id FROM ptm_teacher_days WHERE day_id = $1', [wed])).rows).toEqual([{ teacher_id: KHALIL }]);
    expect((await office('put', dayUrl).send({ everyone: false, teacherIds: [KHALIL] })).status).toBe(200);
    setup = (await office('get', `/events/${eventId}`)).body.data;
    expect([KHALIL, SALEH, FAROUK].map((id) => works(setup, id))).toEqual([true, false, false]);
    expect((await pageFor(RASHA)).days.map((d) => d.date)).toEqual([MON, TUE]);
  });

  it('deleting the meetings cancels every booking and tells each family', async () => {
    const { eventId, mon } = await createEvent();
    await office('post', `/events/${eventId}/schedule`).send({});
    await asParent(AMAL, 'post', `/meetings/${eventId}/bookings`).send({ teacherId: SALEH, dayId: mon, startMin: H(15, 30), studentIds: [adam] });
    await deliverQueuedEmails(pool);
    getResend().emails.send.mockClear();

    const res = await office('delete', `/events/${eventId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.cancelled).toBe(1);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM ptm_bookings')).rows[0].n).toBe(0);
    await deliverQueuedEmails(pool);
    const mail = sent().find((m) => m.to[0] === 'amal.parent@example.com');
    expect(mail.subject).toBe('Your parent–teacher meetings were cancelled');
    expect(mail.html).toContain('Ms. Layla Saleh (Adam), Mon, Feb 1 at 3:30 PM: cancelled');
    expect((await asParent(AMAL, 'get', '/meetings')).body.data.events).toEqual([]);
  });
});
