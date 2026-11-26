const {
  LIMITS,
  readCustomFields,
  validateNewField,
  validateFieldChange,
  normalizeValue,
  displayValue,
  normalizeCustomFieldsInput,
} = require('../../../../services/customFields/values');

const BUS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONSENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SIBLINGS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STARTED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOTES = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const field = (fieldId, label, type, options = null) => ({ fieldId, label, type, options });
const bus = field(BUS, 'Bus route', 'select', ['Route 4', 'Walks']);
const consent = field(CONSENT, 'Photo consent', 'boolean');
const siblings = field(SIBLINGS, 'Siblings', 'number');
const started = field(STARTED, 'Started on', 'date');
const longNotes = field(NOTES, 'Pickup notes', 'textarea');
const text = field('ffffffff-ffff-4fff-8fff-ffffffffffff', 'Locker', 'text');

const defs = new Map([bus, consent, siblings, started, longNotes, text].map((f) => [f.fieldId, f]));

describe('validateNewField', () => {
  it('trims the name and keeps only a dropdown\'s choices', () => {
    expect(validateNewField({ label: '  Bus   route ', type: 'text', options: ['x'] }))
      .toEqual({ value: { label: 'Bus route', type: 'text', options: null } });
  });

  it('cleans a dropdown\'s choices: trimmed, blanks and repeats dropped, order kept', () => {
    expect(validateNewField({ label: 'Bus', type: 'select', options: [' Route 4 ', '', 'Walks', 'route 4'] }))
      .toEqual({ value: { label: 'Bus', type: 'select', options: ['Route 4', 'Walks'] } });
  });

  it.each([
    [{ type: 'text' }, 'Give the field a name'],
    [{ label: '   ', type: 'text' }, 'Give the field a name'],
    [{ label: 'x'.repeat(LIMITS.label + 1), type: 'text' }, `A field name can be at most ${LIMITS.label} characters`],
    [{ label: 'Bus', type: 'colour' }, 'Choose what kind of field this is'],
    [{ label: 'Bus', type: 'select' }, 'A dropdown needs at least one choice'],
    [{ label: 'Bus', type: 'select', options: ['  '] }, 'A dropdown needs at least one choice'],
    [{ label: 'Bus', type: 'select', options: [4] }, 'Each dropdown choice must be text'],
    [null, 'Give the field a name'],
  ])('refuses %j', (body, error) => {
    expect(validateNewField(body)).toEqual({ error });
  });

  it('caps the number of choices', () => {
    const options = Array.from({ length: LIMITS.options + 1 }, (_, i) => `Choice ${i}`);
    expect(validateNewField({ label: 'Bus', type: 'select', options }).error).toMatch(/at most/);
  });
});

describe('validateFieldChange', () => {
  it('returns only what the body carried', () => {
    expect(validateFieldChange({ label: ' Bus stop ' }, 'text')).toEqual({ value: { label: 'Bus stop' } });
    expect(validateFieldChange({ options: ['A', 'B'] }, 'select')).toEqual({ value: { options: ['A', 'B'] } });
    expect(validateFieldChange({}, 'text')).toEqual({ value: {} });
  });

  it('never changes the type', () => {
    expect(validateFieldChange({ type: 'number' }, 'text').error).toMatch(/type can't be changed/);
    expect(validateFieldChange({ type: 'text', label: 'Same' }, 'text')).toEqual({ value: { label: 'Same' } });
  });

  it('refuses choices on anything but a dropdown', () => {
    expect(validateFieldChange({ options: ['A'] }, 'text')).toEqual({ error: 'Only a dropdown has choices' });
  });
});

describe('normalizeValue', () => {
  it('reads nothing as no value, for every type', () => {
    for (const def of defs.values()) {
      expect(normalizeValue(def, null)).toEqual({ ok: true, value: null });
      expect(normalizeValue(def, undefined)).toEqual({ ok: true, value: null });
      expect(normalizeValue(def, '   ')).toEqual({ ok: true, value: null });
    }
  });

  it('text: trimmed, within the limit', () => {
    expect(normalizeValue(text, '  B14 ')).toEqual({ ok: true, value: 'B14' });
    expect(normalizeValue(text, 14)).toEqual({ ok: true, value: '14' });
    expect(normalizeValue(text, 'x'.repeat(LIMITS.text + 1)).ok).toBe(false);
    expect(normalizeValue(longNotes, 'x'.repeat(LIMITS.text + 1)).ok).toBe(true);
  });

  it('number: a number, or a string that is plainly one', () => {
    expect(normalizeValue(siblings, 2)).toEqual({ ok: true, value: 2 });
    expect(normalizeValue(siblings, ' -2.5 ')).toEqual({ ok: true, value: -2.5 });
    expect(normalizeValue(siblings, 0)).toEqual({ ok: true, value: 0 });
    expect(normalizeValue(siblings, 'two').ok).toBe(false);
    expect(normalizeValue(siblings, '1,200').ok).toBe(false);
    expect(normalizeValue(siblings, Infinity).ok).toBe(false);
    expect(normalizeValue(siblings, 1e15).ok).toBe(false);
  });

  it('date: a real day, stored as YYYY-MM-DD', () => {
    expect(normalizeValue(started, '2026-09-01')).toEqual({ ok: true, value: '2026-09-01' });
    expect(normalizeValue(started, '1/9/2026')).toEqual({ ok: true, value: '2026-09-01' });
    expect(normalizeValue(started, '2026-02-30')).toEqual({ ok: false, error: '"2026-02-30" is not a real date' });
    expect(normalizeValue(started, 20260901).ok).toBe(false);
  });

  it('dropdown: one of the choices, in the school\'s spelling', () => {
    expect(normalizeValue(bus, 'route 4')).toEqual({ ok: true, value: 'Route 4' });
    expect(normalizeValue(bus, 'Helicopter')).toEqual({ ok: false, error: '"Helicopter" is not one of the choices for Bus route' });
  });

  it('yes/no: a boolean, or the words a parent would type', () => {
    expect(normalizeValue(consent, true)).toEqual({ ok: true, value: true });
    expect(normalizeValue(consent, false)).toEqual({ ok: true, value: false });
    for (const word of ['Yes', 'y', 'TRUE', '1']) expect(normalizeValue(consent, word)).toEqual({ ok: true, value: true });
    for (const word of ['No', 'n', 'false', '0']) expect(normalizeValue(consent, word)).toEqual({ ok: true, value: false });
    expect(normalizeValue(consent, 'maybe').ok).toBe(false);
  });

  it('refuses a value that is not a single thing', () => {
    expect(normalizeValue(text, { a: 1 }).ok).toBe(false);
    expect(normalizeValue(text, ['a']).ok).toBe(false);
  });
});

describe('displayValue', () => {
  it('writes yes/no in words and everything else as it is', () => {
    expect(displayValue(consent, true)).toBe('Yes');
    expect(displayValue(consent, false)).toBe('No');
    expect(displayValue(siblings, 0)).toBe('0');
    expect(displayValue(bus, 'Walks')).toBe('Walks');
    expect(displayValue(bus, null)).toBe('');
  });
});

describe('normalizeCustomFieldsInput', () => {
  it('keeps only the keys the body carried, with null for a cleared field', () => {
    expect(normalizeCustomFieldsInput({ values: { [BUS]: 'walks', [SIBLINGS]: null, [CONSENT]: false } }, defs))
      .toEqual({ patch: { values: { [BUS]: 'Walks', [SIBLINGS]: null, [CONSENT]: false } } });
  });

  it('treats an emptied input as a cleared field', () => {
    expect(normalizeCustomFieldsInput({ values: { [BUS]: '' } }, defs)).toEqual({ patch: { values: { [BUS]: null } } });
  });

  it('carries nothing it was not given', () => {
    expect(normalizeCustomFieldsInput({}, defs)).toEqual({ patch: {} });
    expect(normalizeCustomFieldsInput({ notes: [] }, defs)).toEqual({ patch: { notes: [] } });
  });

  it('refuses a field the school does not have', () => {
    const unknown = '99999999-9999-4999-8999-999999999999';
    expect(normalizeCustomFieldsInput({ values: { [unknown]: 'x' } }, defs).error).toMatch(/no longer exists/);
    expect(normalizeCustomFieldsInput({ values: { 'not-an-id': 'x' } }, defs).error).toMatch(/no longer exists/);
    expect(normalizeCustomFieldsInput({ values: { __proto__: 'x', constructor: 'x' } }, defs).error).toMatch(/no longer exists/);
  });

  it('names the field whose value is wrong', () => {
    expect(normalizeCustomFieldsInput({ values: { [SIBLINGS]: 'lots' } }, defs).error).toMatch(/^Siblings needs a number/);
  });

  it('cleans notes: trimmed, empty rows dropped', () => {
    expect(normalizeCustomFieldsInput({
      notes: [
        { label: '  Locker ', value: ' B14 ' },
        { label: '', value: '' },
        { label: 'Empty label kept out', value: '   ' },
      ],
    }, defs)).toEqual({ patch: { notes: [{ label: 'Locker', value: 'B14' }] } });
  });

  it('refuses a note with a value and no label, and too many notes', () => {
    expect(normalizeCustomFieldsInput({ notes: [{ label: ' ', value: 'B14' }] }, defs)).toEqual({ error: 'Give each note a label' });
    const many = Array.from({ length: LIMITS.notes + 1 }, (_, i) => ({ label: `Note ${i}`, value: 'x' }));
    expect(normalizeCustomFieldsInput({ notes: many }, defs).error).toMatch(/at most/);
  });

  it.each([null, 'x', [], 4])('refuses %p as the whole object', (input) => {
    expect(normalizeCustomFieldsInput(input, defs).error).toBeDefined();
  });

  it('refuses values or notes of the wrong shape', () => {
    expect(normalizeCustomFieldsInput({ values: [] }, defs).error).toBeDefined();
    expect(normalizeCustomFieldsInput({ notes: {} }, defs).error).toBeDefined();
    expect(normalizeCustomFieldsInput({ notes: ['x'] }, defs).error).toBeDefined();
  });
});

describe('readCustomFields', () => {
  it('always returns values and notes', () => {
    expect(readCustomFields(null)).toEqual({ values: {}, notes: [] });
    expect(readCustomFields({})).toEqual({ values: {}, notes: [] });
    expect(readCustomFields('garbage')).toEqual({ values: {}, notes: [] });
    expect(readCustomFields({ values: { [BUS]: 'Walks' }, notes: [{ label: 'Locker', value: 'B14' }] }))
      .toEqual({ values: { [BUS]: 'Walks' }, notes: [{ label: 'Locker', value: 'B14' }] });
  });

  it('drops notes that are not notes', () => {
    expect(readCustomFields({ notes: ['x', null, { value: 'no label' }, { label: 'Kept', value: null }] }))
      .toEqual({ values: {}, notes: [{ label: 'Kept', value: '' }] });
  });
});
