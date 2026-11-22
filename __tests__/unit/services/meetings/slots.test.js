// services/meetings/slots.js: a teacher's times from their window, length
// and breaks; closed times; bookings a change would orphan; labels.

const { slotsFor, teacherDayPlan, orphanedBookings, timeLabel, rangeLabel } = require('../../../../services/meetings/slots');
const { cutoffAt, phaseOf, torontoAt } = require('../../../../services/meetings/time');
const { calendarFile } = require('../../../../services/meetings/ics');

const H = (h, m = 0) => h * 60 + m;
const starts = (slots) => slots.map((s) => timeLabel(s.start));

describe('slotsFor', () => {
  it('fills the window with 10-minute times', () => {
    const slots = slotsFor(H(15, 30), H(16, 30), 10);
    expect(starts(slots)).toEqual(['3:30 PM', '3:40 PM', '3:50 PM', '4:00 PM', '4:10 PM', '4:20 PM']);
  });

  it('skips a break and starts again at its end', () => {
    // Mon 3:30–7:30 with Maghrib 4:40–5:00: the 22 times of the design.
    const slots = slotsFor(H(15, 30), H(19, 30), 10, [{ start: H(16, 40), end: H(17) }]);
    expect(slots).toHaveLength(22);
    expect(starts(slots).slice(6, 8)).toEqual(['4:30 PM', '5:00 PM']);
  });

  it('realigns longer meetings after a break', () => {
    // 15 minutes from 9:00 with yard duty 11:00–11:20: times resume at 11:20.
    const slots = slotsFor(H(9), H(12), 15, [{ start: H(11), end: H(11, 20) }]);
    expect(starts(slots).slice(-4)).toEqual(['10:30 AM', '10:45 AM', '11:20 AM', '11:35 AM']);
    expect(slots[slots.length - 1].end).toBeLessThanOrEqual(H(12));
    // 15 minutes from 10:50: 10:50–11:05 would overlap, so the next time is 11:20.
    expect(starts(slotsFor(H(10, 50), H(12), 15, [{ start: H(11), end: H(11, 20) }]))).toEqual(['11:20 AM', '11:35 AM']);
  });

  it('never runs past the end, and is empty for a bad window', () => {
    expect(slotsFor(H(9), H(9, 25), 10)).toHaveLength(2);
    expect(slotsFor(H(10), H(9), 10)).toEqual([]);
    expect(slotsFor(H(9), H(10), 0)).toEqual([]);
  });
});

describe('teacherDayPlan', () => {
  const day = { day_id: 'd1', start_min: H(15, 30), end_min: H(19, 30), everyone: true };
  const breaks = [
    { teacher_id: null, start_min: H(16, 40), end_min: H(17), kind: 'break' },
    { teacher_id: 't2', start_min: H(18), end_min: H(18, 30), kind: 'break' },
    { teacher_id: 't1', start_min: H(15, 50), end_min: H(16), kind: 'closed' },
  ];

  it('uses the school hours, everyone\'s breaks, and marks closed times without moving the grid', () => {
    const plan = teacherDayPlan({ day, own: undefined, length: 10, breaks, teacherId: 't1' });
    expect(plan.works).toBe(true);
    expect(plan.slots).toHaveLength(22);
    expect(plan.slots.find((s) => s.start === H(15, 50)).closed).toBe(true);
    expect(plan.slots.filter((s) => s.closed)).toHaveLength(1);
  });

  it('applies the teacher\'s own hours and own breaks only to them', () => {
    const own = { works: true, start_min: H(15, 30), end_min: H(18) };
    const t2 = teacherDayPlan({ day, own, length: 10, breaks, teacherId: 't2' });
    expect(t2.ownHours).toBe(true);
    expect(t2.slots[t2.slots.length - 1].end).toBe(H(18));
    const t2full = teacherDayPlan({ day, own: undefined, length: 10, breaks, teacherId: 't2' });
    expect(starts(t2full.slots)).not.toContain('6:00 PM');
    expect(starts(t2full.slots)).toContain('6:30 PM');
  });

  it('a teacher can be off on an everyone day, or on a day just for some teachers', () => {
    expect(teacherDayPlan({ day, own: { works: false }, length: 10, breaks, teacherId: 't1' }).slots).toEqual([]);
    const makeUp = { ...day, everyone: false };
    expect(teacherDayPlan({ day: makeUp, own: undefined, length: 10, breaks: [], teacherId: 't1' }).works).toBe(false);
    expect(teacherDayPlan({ day: makeUp, own: { works: true, start_min: null, end_min: null }, length: 10, breaks: [], teacherId: 't1' }).slots)
      .toHaveLength(24);
  });
});

describe('orphanedBookings', () => {
  it('finds bookings a new length or shorter hours would leave without a time', () => {
    const slots = slotsFor(H(15, 30), H(17), 10);
    const bookings = [{ start_min: H(15, 40), end_min: H(15, 50) }, { start_min: H(17, 10), end_min: H(17, 20) }];
    expect(orphanedBookings(slots, bookings)).toEqual([bookings[1]]);
    expect(orphanedBookings(slotsFor(H(15, 30), H(17), 15), bookings)).toHaveLength(2);
  });
});

describe('labels', () => {
  it('reads times and ranges the way the designs do', () => {
    expect(timeLabel(H(0))).toBe('12:00 AM');
    expect(timeLabel(H(12, 5))).toBe('12:05 PM');
    expect(rangeLabel(H(15, 30), H(19, 30))).toBe('3:30–7:30 PM');
    expect(rangeLabel(H(9), H(13))).toBe('9:00 AM–1:00 PM');
  });
});

describe('time', () => {
  const day = { day_date: '2026-11-30', start_min: H(15, 30), end_min: H(19, 30) };

  it('cuts off at 8 PM the evening before, Toronto time, or at the meeting start', () => {
    expect(cutoffAt({ cutoff_min: H(20) }, day).toISOString()).toBe('2026-11-30T01:00:00.000Z');
    expect(cutoffAt({ cutoff_min: null }, day).toISOString()).toBe('2026-11-30T20:30:00.000Z');
    // Daylight time: 8 PM EDT is midnight UTC.
    expect(torontoAt('2026-10-01', H(20)).toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });

  it('knows the phase', () => {
    const e = { status: 'open', cutoff_min: H(20) };
    expect(phaseOf(e, [day], new Date('2026-11-25T12:00:00Z'))).toBe('open');
    expect(phaseOf(e, [day], new Date('2026-11-30T12:00:00Z'))).toBe('closed');
    expect(phaseOf(e, [day], new Date('2026-12-01T12:00:00Z'))).toBe('finished');
    expect(phaseOf({ status: 'draft' }, [day])).toBe('draft');
  });
});

describe('calendarFile', () => {
  it('writes one event per meeting with a stable UID and UTC times', () => {
    const ics = calendarFile({
      now: new Date('2026-11-24T00:00:00Z'),
      events: [{ uid: 'b1', sequence: 2, date: '2026-11-30', start: H(16), end: H(16, 10), summary: 'Meeting with Ms. Layla Saleh (Adam)', location: 'Grade 5 room, Playground School' }],
    });
    expect(ics).toContain('METHOD:PUBLISH');
    expect(ics).toContain('UID:b1@ptm.schoolmule.ca');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain('DTSTART:20261130T210000Z');
    expect(ics).toContain('DTEND:20261130T211000Z');
    expect(ics).toContain('LOCATION:Grade 5 room\\, Playground School');
    expect(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    expect(calendarFile({ method: 'CANCEL', events: [] })).toContain('METHOD:CANCEL');
  });
});
