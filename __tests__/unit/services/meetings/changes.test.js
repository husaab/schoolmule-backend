// The family's update email: changes netted out per meeting, including a
// switch between in person and a phone call (services/meetings/emails.js).
const { collapseChanges } = require('../../../../services/meetings/emails');
const { cleanPhone, howOf } = require('../../../../services/meetings/booking');

const base = {
  bookingId: 'b1', teacherName: 'Ms. Saleh', studentNames: 'Adam', day: '2027-02-01', start: 930, end: 940, mode: 'in_person', phone: null,
};
const moved = (over) => ({ ...base, type: 'moved', fromDay: '2027-02-01', fromStart: 930, fromEnd: 940, fromMode: 'in_person', fromPhone: null, ...over });

describe('collapseChanges', () => {
  it('keeps a switch to a phone call at the same time', () => {
    const out = collapseChanges([moved({ mode: 'phone', phone: '416-555-0100' })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'moved', mode: 'phone', fromMode: 'in_person' });
  });

  it('says nothing when a meeting is switched and switched back', () => {
    const out = collapseChanges([
      moved({ mode: 'phone', phone: '416-555-0100' }),
      moved({ fromMode: 'phone', fromPhone: '416-555-0100' }),
    ]);
    expect(out).toEqual([]);
  });

  it('says nothing when a meeting is moved and moved back', () => {
    const out = collapseChanges([
      moved({ start: 950, end: 1000 }),
      moved({ fromStart: 950, fromEnd: 1000 }),
    ]);
    expect(out).toEqual([]);
  });

  it('booked then switched reads as booked the new way', () => {
    const out = collapseChanges([{ ...base, type: 'booked' }, moved({ mode: 'phone', phone: '416-555-0100' })]);
    expect(out).toEqual([expect.objectContaining({ type: 'booked', mode: 'phone', fromMode: null })]);
  });

  it('a new number on a phone call counts as a change', () => {
    const out = collapseChanges([moved({ mode: 'phone', phone: '647-555-0199', fromMode: 'phone', fromPhone: '416-555-0100' })]);
    expect(out).toHaveLength(1);
  });

  it('older queued changes (no mode) still read as moves', () => {
    const { mode, phone, ...old } = base;
    const out = collapseChanges([{ ...old, type: 'moved', fromDay: '2027-02-01', fromStart: 920, fromEnd: 930 }]);
    expect(out).toHaveLength(1);
  });
});

describe('a phone call meeting', () => {
  const parent = { kind: 'parent' };
  const office = { kind: 'office' };

  it('takes a real number, tidied', () => {
    expect(cleanPhone(' 416  555-0100 ')).toBe('416 555-0100');
    expect(cleanPhone('(416) 555-0100 ext. 12')).toBe('(416) 555-0100 ext. 12');
    expect(cleanPhone('555-01')).toBeNull();
    expect(cleanPhone('call my cell')).toBeNull();
    expect(cleanPhone('')).toBeNull();
  });

  it('defaults to in person and keeps what a change leaves out', () => {
    expect(howOf({}, { allow_phone: true }, parent)).toEqual({ mode: 'in_person', phone: null });
    const current = { mode: 'phone', phone: '416-555-0100' };
    expect(howOf({}, { allow_phone: true }, parent, current)).toEqual(current);
    expect(howOf({ phone: '647-555-0199' }, { allow_phone: true }, parent, current)).toEqual({ mode: 'phone', phone: '647-555-0199' });
  });

  it('is the office\'s to allow for parents; the office can always book one', () => {
    const off = { allow_phone: false };
    expect(() => howOf({ mode: 'phone', phone: '416-555-0100' }, off, parent)).toThrow(expect.objectContaining({ code: 'NO_PHONE' }));
    expect(howOf({ mode: 'phone', phone: '416-555-0100' }, off, office)).toEqual({ mode: 'phone', phone: '416-555-0100' });
    // A phone call booked before the office turned them off can still change its number.
    expect(howOf({ phone: '647-555-0199' }, off, parent, { mode: 'phone', phone: '416-555-0100' }).phone).toBe('647-555-0199');
  });
});
