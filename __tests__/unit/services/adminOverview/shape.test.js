// The admin overview's pure shapers (services/adminOverview/shape.js): which
// term is current, which meetings event the office sees (and its phase at a
// fixed moment), QuickBooks' flags, and the counting rules the blocks lean on.

const S = require('../../../../services/adminOverview/shape');
const { torontoAt } = require('../../../../services/meetings/time');

const term = (id, name, start, end) => ({ term_id: id, name, start_date: start, end_date: end });

describe('torontoDate', () => {
  it("is the calendar day in Toronto, not UTC's", () => {
    // 02:30 UTC on Nov 24 is still the evening of Nov 23 in Toronto.
    expect(S.torontoDate(new Date('2026-11-24T02:30:00Z'))).toBe('2026-11-23');
    expect(S.torontoDate(new Date('2026-11-24T06:00:00Z'))).toBe('2026-11-24');
  });
});

describe('pickTerms', () => {
  const terms = [
    term('t1', 'Term 1', '2026-09-02', '2027-01-29'),
    term('t2', 'Term 2', '2027-02-01', '2027-06-25'),
  ];

  it('is the term that covers today, with no next term', () => {
    expect(S.pickTerms(terms, '2026-11-23')).toEqual({
      currentTerm: { termId: 't1', name: 'Term 1', startDate: '2026-09-02', endDate: '2027-01-29' },
      nextTerm: null,
    });
  });

  it('counts the first and last days as inside the term', () => {
    expect(S.pickTerms(terms, '2026-09-02').currentTerm.termId).toBe('t1');
    expect(S.pickTerms(terms, '2027-01-29').currentTerm.termId).toBe('t1');
    expect(S.pickTerms(terms, '2027-02-01').currentTerm.termId).toBe('t2');
  });

  it('between terms, is the next one to start', () => {
    expect(S.pickTerms(terms, '2027-01-30')).toEqual({
      currentTerm: null,
      nextTerm: { termId: 't2', name: 'Term 2', startDate: '2027-02-01' },
    });
    expect(S.pickTerms([terms[1], terms[0]], '2026-08-15').nextTerm.termId).toBe('t1');
  });

  it('after the last term, or with no terms, is nothing', () => {
    expect(S.pickTerms(terms, '2027-07-01')).toEqual({ currentTerm: null, nextTerm: null });
    expect(S.pickTerms([], '2026-11-23')).toEqual({ currentTerm: null, nextTerm: null });
  });

  it('when two terms overlap today, is the one that started last', () => {
    const overlapping = [term('year', 'Full year', '2026-09-02', '2027-06-25'), ...terms];
    expect(S.pickTerms(overlapping, '2027-03-01').currentTerm.termId).toBe('t2');
  });
});

describe('pickMeeting', () => {
  // cutoff_min null: families book until each meeting starts.
  const event = (id, { status = 'open', days = [], createdAt = '2026-10-01T12:00:00Z', ...rest } = {}) => ({
    event_id: id,
    title: `Meetings ${id}`,
    status,
    cutoff_min: null,
    opens_at: null,
    last_call_at: null,
    created_at: createdAt,
    days,
    bookings: 0,
    students_booked: 0,
    ...rest,
  });
  const day = (date, start = 15 * 60, end = 20 * 60) => ({ day_date: date, start_min: start, end_min: end });
  const now = torontoAt('2026-11-23', 12 * 60); // noon, Nov 23, Toronto

  it('is null with no events', () => {
    expect(S.pickMeeting([], now)).toEqual({ event: null });
  });

  it('is the first event not finished, by its first day', () => {
    const events = [
      event('later', { days: [day('2026-12-10')] }),
      event('sooner', { days: [day('2026-11-26'), day('2026-11-27')] }),
      event('past', { days: [day('2026-10-15')] }),
    ];
    const { event: picked } = S.pickMeeting(events, now);
    expect(picked).toMatchObject({ eventId: 'sooner', phase: 'open', firstDay: '2026-11-26', lastDay: '2026-11-27' });
  });

  it('puts an event with no days yet after the dated ones', () => {
    const events = [
      event('undated', { status: 'draft' }),
      event('dated', { status: 'scheduled', days: [day('2027-02-10')], opens_at: '2027-01-20T14:00:00Z' }),
    ];
    expect(S.pickMeeting(events, now).event).toMatchObject({ eventId: 'dated', phase: 'scheduled', opensAt: '2027-01-20T14:00:00.000Z' });
    expect(S.pickMeeting([events[0]], now).event).toMatchObject({ eventId: 'undated', phase: 'draft', firstDay: null, lastDay: null });
  });

  it('when everything is finished, is the one that ended last', () => {
    const events = [
      event('spring', { days: [day('2026-04-10')] }),
      event('fall', { days: [day('2026-10-14'), day('2026-10-15')] }),
    ];
    expect(S.pickMeeting(events, now).event).toMatchObject({ eventId: 'fall', phase: 'finished', lastDay: '2026-10-15' });
  });

  it('reads the phase at the given moment: closed after the cutoff, finished after the last meeting', () => {
    // Cutoff 8 pm the evening before; the day runs 3 pm to 8 pm.
    const e = event('e', { cutoff_min: 20 * 60, days: [day('2026-11-24')] });
    expect(S.pickMeeting([e], torontoAt('2026-11-23', 19 * 60)).event.phase).toBe('open');
    expect(S.pickMeeting([e], torontoAt('2026-11-23', 21 * 60)).event.phase).toBe('closed');
    expect(S.pickMeeting([e], torontoAt('2026-11-24', 20 * 60 + 1)).event.phase).toBe('finished');
  });

  it('carries the counts and instants as facts', () => {
    const e = event('e', {
      days: [day('2026-11-26')],
      bookings: 42,
      students_booked: 37,
      last_call_at: new Date('2026-11-25T14:00:00Z'),
    });
    expect(S.pickMeeting([e], now)).toEqual({
      event: {
        eventId: 'e',
        title: 'Meetings e',
        phase: 'open',
        opensAt: null,
        lastCallAt: '2026-11-25T14:00:00.000Z',
        firstDay: '2026-11-26',
        lastDay: '2026-11-26',
        bookings: 42,
        studentsBooked: 37,
      },
    });
  });
});

describe('shapeFinance', () => {
  const conn = (over = {}) => ({
    status: 'active', last_success_at: new Date('2026-11-23T10:00:00Z'), last_error: null, consecutive_failures: 0, ...over,
  });

  it('with no connection row, is not connected and nothing else', () => {
    expect(S.shapeFinance(null, { state: 'running' })).toEqual({
      connected: false, needsReconnect: false, syncing: false, lastSuccessAt: null, lastError: null, consecutiveFailures: 0,
    });
  });

  it('a healthy connection with no job is connected and idle', () => {
    expect(S.shapeFinance(conn(), null)).toEqual({
      connected: true, needsReconnect: false, syncing: false,
      lastSuccessAt: '2026-11-23T10:00:00.000Z', lastError: null, consecutiveFailures: 0,
    });
  });

  it('is syncing while the latest job is pending or running, not when it failed', () => {
    expect(S.shapeFinance(conn(), { state: 'pending' }).syncing).toBe(true);
    expect(S.shapeFinance(conn(), { state: 'running' }).syncing).toBe(true);
    expect(S.shapeFinance(conn(), { state: 'failed' }).syncing).toBe(false);
  });

  it('needs reconnecting while still counting as connected', () => {
    const f = S.shapeFinance(conn({ status: 'needs_reconnect', last_error: 'invalid_grant', consecutive_failures: 3 }), null);
    expect(f).toMatchObject({ connected: true, needsReconnect: true, lastError: 'invalid_grant', consecutiveFailures: 3 });
  });

  it('a disconnected school is not connected', () => {
    expect(S.shapeFinance(conn({ status: 'disconnected' }), null)).toMatchObject({ connected: false, needsReconnect: false });
  });
});

describe('countStudentAccounts', () => {
  it("counts the page's chips: three statuses, plus needs attention across them", () => {
    const rows = [
      { status: 'not_invited', needsAttention: false },
      { status: 'not_invited', needsAttention: false },
      { status: 'invited', needsAttention: true },
      { status: 'invited', needsAttention: false },
      { status: 'active', needsAttention: true },
      { status: 'archived', needsAttention: false },
      { status: 'not_eligible', needsAttention: false },
    ];
    expect(S.countStudentAccounts(rows)).toEqual({ students: 7, notInvited: 2, invited: 2, active: 1, needsAttention: 2 });
  });
});

describe('shapeForms', () => {
  const form = (slug, newSubmissions, status = 'published') => ({ slug, title: `Form ${slug}`, status, new_submissions: newSubmissions });

  it('names the form with the most new submissions', () => {
    const f = S.shapeForms('7', [form('a', 2), form('b', 5, 'closed'), form('c', 0, 'draft')]);
    expect(f).toEqual({
      newSubmissions: 7, formsWithNew: 2, topForm: { slug: 'b', name: 'Form b', newSubmissions: 5 }, openForms: 1, total: 3,
    });
  });

  it('on a tie, is the newest form (the rows come newest first)', () => {
    expect(S.shapeForms(4, [form('new', 2), form('old', 2)]).topForm.slug).toBe('new');
  });

  it('with nothing new, has no top form', () => {
    expect(S.shapeForms(0, [form('a', 0)])).toEqual({ newSubmissions: 0, formsWithNew: 0, topForm: null, openForms: 1, total: 1 });
    expect(S.shapeForms(null, [])).toEqual({ newSubmissions: 0, formsWithNew: 0, topForm: null, openForms: 0, total: 0 });
  });
});

describe('shapePlanner', () => {
  const schedule = (id, over = {}) => ({
    schedule_id: id, name: `Schedule ${id}`, status: 'draft', published_at: null, go_live_status: null,
    go_live_on: null, effective_from: null, updated_at: '2026-11-01T12:00:00Z', ...over,
  });

  it('is the live timetable, the draft going live soonest and the failed go-lives', () => {
    const rows = [
      schedule('live', { status: 'published', published_at: '2026-09-01T12:00:00Z', effective_from: '2026-09-02' }),
      schedule('march', { go_live_status: 'pending', go_live_on: '2027-03-02' }),
      schedule('winter', { go_live_status: 'running', go_live_on: '2026-11-30' }),
      schedule('broken', { go_live_status: 'failed', go_live_on: '2026-11-02' }),
    ];
    expect(S.shapePlanner(rows)).toEqual({
      live: { scheduleId: 'live', name: 'Schedule live', effectiveFrom: '2026-09-02' },
      nextDraft: { scheduleId: 'winter', name: 'Schedule winter', goLiveOn: '2026-11-30' },
      goLiveFailures: [{ scheduleId: 'broken', name: 'Schedule broken' }],
    });
  });

  it('with nothing published or planned, is empty', () => {
    expect(S.shapePlanner([])).toEqual({ live: null, nextDraft: null, goLiveFailures: [] });
  });
});

describe('the small shapers', () => {
  it('turn missing rows into zeros and nulls, never undefined', () => {
    expect(S.shapeApprovals(null, null)).toEqual({ pendingSignups: 0, unverifiedSignups: 0, pendingStudentRequests: 0 });
    expect(S.shapeUsers(null)).toEqual({ admins: 0, teachers: 0, parents: 0, invitedNotSignedIn: 0 });
    expect(S.shapeAssets(null)).toEqual({ logo: false, signature: false, stamp: false });
    expect(S.shapeClosure(null)).toEqual({ nextClosure: null });
    expect(S.shapeAgenda(null)).toEqual({ latest: null });
    expect(S.shapePatchNotes(null)).toEqual({ lastPublishedAt: null, scheduled: 0 });
  });
});
