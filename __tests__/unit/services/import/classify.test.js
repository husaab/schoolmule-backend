const { classifyBatch, mapAnswers } = require('../../../../services/import/classify');
const target = require('../../../../services/import/studentImportTarget');

// ─── Fixtures ─────────────────────────────────────────────────────────
// Field IDs mirror the real Al Haadi "New Students" form shape: answers are a
// JSONB blob keyed by field UUID.
const F = {
  name: '62e82959-01d3-43af-960d-b7f052ef18f5',
  grade: 'f67b0c39-110d-4619-b8d8-afa6d8b3dce5',
  dob: 'b8befeaf-2385-4bf6-99ce-53d122726631',
  parentEmail: '812261e5-d39f-4aaf-8aa6-120bf76d7979',
  parentPhone: '0b2c15d1-7cc1-4cae-a20f-34e271df3ebf',
  medical: '7e494f75-e809-413f-8210-9dfd4aa0bd2a',
};

const GRADE_VALUE_MAP = {
  'Junior Kindergarten (born in 2022)': 'JK',
  'Senior Kindergarten': 'SK',
  'Grade 1': '1',
  'Grade 2': '2',
  'Grade 3': '3',
};

const mappings = [
  { field_id: F.name, target_field: 'name', value_map: null },
  { field_id: F.grade, target_field: 'grade', value_map: GRADE_VALUE_MAP },
  { field_id: F.dob, target_field: 'dateOfBirth', value_map: null },
  { field_id: F.parentEmail, target_field: 'motherEmail', value_map: null },
  { field_id: F.parentPhone, target_field: 'motherPhone', value_map: null },
  { field_id: F.medical, target_field: 'medicalNotes', value_map: null },
];

function submission(id, answers, overrides = {}) {
  return {
    submission_id: id,
    submitted_at: '2026-08-25T00:00:00Z',
    answers,
    imported_student_id: null,
    ...overrides,
  };
}

function student(id, name, grade, overrides = {}) {
  return {
    student_id: id,
    name,
    grade,
    oen: null,
    date_of_birth: null,
    address: null,
    health_card_number: null,
    medical_notes: null,
    emergency_contact: null,
    mother_name: null,
    mother_email: null,
    mother_number: null,
    father_name: null,
    father_email: null,
    father_number: null,
    ...overrides,
  };
}

const fullAnswers = {
  [F.name]: 'Ahmad Hamze',
  [F.grade]: 'Grade 2',
  [F.dob]: '2019-04-11',
  [F.parentEmail]: 'parent@example.com',
  [F.parentPhone]: '416-555-0142',
  [F.medical]: 'Peanut allergy',
};

const run = (submissions, candidates = [], opts = {}) =>
  classifyBatch({ submissions, mappings, candidates, target, ...opts });

// ─── mapAnswers ───────────────────────────────────────────────────────

describe('mapAnswers', () => {
  it('translates a choice option to its grade enum token', () => {
    const { values, errors } = mapAnswers(submission('s1', fullAnswers), mappings, target);
    expect(errors).toEqual([]);
    expect(values.grade).toBe('2');
    expect(values.name).toBe('Ahmad Hamze');
    expect(values.dateOfBirth).toBe('2019-04-11');
    expect(values.motherEmail).toBe('parent@example.com');
  });

  it('maps kindergarten options to JK and SK', () => {
    const jk = mapAnswers(
      submission('s1', { ...fullAnswers, [F.grade]: 'Junior Kindergarten (born in 2022)' }),
      mappings, target,
    );
    expect(jk.values.grade).toBe('JK');

    const sk = mapAnswers(
      submission('s2', { ...fullAnswers, [F.grade]: 'Senior Kindergarten' }),
      mappings, target,
    );
    expect(sk.values.grade).toBe('SK');
  });

  it('reports an option that has no grade translation instead of dropping it', () => {
    const { errors } = mapAnswers(
      submission('s1', { ...fullAnswers, [F.grade]: 'Grade 9' }),
      mappings, target,
    );
    expect(errors.map(e => e.message).join(' ')).toMatch(/Grade 9.*not mapped/);
  });

  it('reports a required field that is mapped but empty', () => {
    const { errors } = mapAnswers(submission('s1', { ...fullAnswers, [F.name]: '  ' }), mappings, target);
    expect(errors.map(e => e.message).join(' ')).toMatch(/Student name is empty/);
  });

  it('reports a required field that was never mapped', () => {
    const partial = mappings.filter(m => m.target_field !== 'grade');
    const { errors } = mapAnswers(submission('s1', fullAnswers), partial, target);
    expect(errors.map(e => e.message).join(' ')).toMatch(/Grade is not mapped/);
  });

  it('rejects a malformed email rather than writing it', () => {
    const { errors } = mapAnswers(
      submission('s1', { ...fullAnswers, [F.parentEmail]: 'not-an-email' }),
      mappings, target,
    );
    expect(errors.map(e => e.message).join(' ')).toMatch(/not a valid email/);
  });

  it('normalizes a D/M/Y date to ISO', () => {
    const { values } = mapAnswers(
      submission('s1', { ...fullAnswers, [F.dob]: '11/04/2019' }),
      mappings, target,
    );
    expect(values.dateOfBirth).toBe('2019-04-11');
  });

  it('treats blank optional answers as absent, not as empty strings', () => {
    const { values, errors } = mapAnswers(
      submission('s1', { ...fullAnswers, [F.medical]: '' }),
      mappings, target,
    );
    expect(errors).toEqual([]);
    expect(values.medicalNotes).toBeUndefined();
  });
});

// ─── Classification ───────────────────────────────────────────────────

describe('classifyBatch', () => {
  it('creates a student when nothing matches', () => {
    const { rows, summary } = run([submission('s1', fullAnswers)]);
    expect(rows[0].action).toBe('create');
    expect(rows[0].matchTier).toBe('none');
    expect(summary.create).toBe(1);
  });

  it('skips when name and grade both match an existing student', () => {
    const { rows, summary } = run(
      [submission('s1', fullAnswers)],
      [student('st1', 'Ahmad Hamze', '2')],
    );
    expect(rows[0].action).toBe('skip');
    expect(rows[0].matchTier).toBe('exact');
    expect(rows[0].reason).toMatch(/Already a student/);
    expect(summary.skip).toBe(1);
  });

  it('matches ignoring case and whitespace', () => {
    const { rows } = run(
      [submission('s1', { ...fullAnswers, [F.name]: '  ahmad   HAMZE ' })],
      [student('st1', 'Ahmad Hamze', '2')],
    );
    expect(rows[0].matchTier).toBe('exact');
  });

  it('flags a same-name-different-grade match for review rather than guessing', () => {
    const { rows, summary } = run(
      [submission('s1', fullAnswers)],
      [student('st1', 'Ahmad Hamze', '5')],
    );
    expect(rows[0].action).toBe('skip');
    expect(rows[0].matchTier).toBe('near');
    expect(rows[0].needsReview).toBe(true);
    expect(summary.needsReview).toBe(1);
  });

  it('flags a close name variant for review', () => {
    const { rows } = run(
      [submission('s1', fullAnswers)],
      [student('st1', 'Ahmed Hamze', '2')],
    );
    expect(rows[0].matchTier).toBe('near');
    expect(rows[0].needsReview).toBe(true);
  });

  it('flags two identically-named students in the same grade rather than picking one', () => {
    const { rows } = run(
      [submission('s1', fullAnswers)],
      [student('st1', 'Ahmad Hamze', '2'), student('st2', 'Ahmad Hamze', '2')],
    );
    expect(rows[0].matchTier).toBe('near');
    expect(rows[0].needsReview).toBe(true);
    expect(rows[0].matchCandidates).toHaveLength(2);
  });

  it('always skips an already-imported submission and ignores any override', () => {
    const sub = submission('s1', fullAnswers, { imported_student_id: 'st1' });
    const { rows } = run([sub], [student('st1', 'Ahmad Hamze', '2')], {
      overrides: { s1: 'create' },
    });
    expect(rows[0].action).toBe('skip');
    expect(rows[0].matchTier).toBe('linked');
    expect(rows[0].locked).toBe(true);
  });

  it('marks a row with a validation error as non-importable', () => {
    const { rows, summary } = run([submission('s1', { ...fullAnswers, [F.grade]: 'Grade 9' })]);
    expect(rows[0].action).toBe('error');
    expect(rows[0].locked).toBe(true);
    expect(summary.error).toBe(1);
  });

  it('does not let an override rescue a row that failed validation', () => {
    const { rows } = run(
      [submission('s1', { ...fullAnswers, [F.name]: '' })],
      [],
      { overrides: { s1: 'create' } },
    );
    expect(rows[0].action).toBe('error');
  });

  describe('overrides', () => {
    it('promotes an exact match to an update when the admin asks', () => {
      const { rows } = run(
        [submission('s1', fullAnswers)],
        [student('st1', 'Ahmad Hamze', '2')],
        { overrides: { s1: 'update' } },
      );
      expect(rows[0].action).toBe('update');
      expect(rows[0].matchedEntityId).toBe('st1');
    });

    it('lets the admin force a create over an exact match (siblings)', () => {
      const { rows } = run(
        [submission('s1', fullAnswers)],
        [student('st1', 'Ahmad Hamze', '2')],
        { overrides: { s1: 'create' } },
      );
      expect(rows[0].action).toBe('create');
    });

    it('requires an explicit match choice when several candidates exist', () => {
      const { rows } = run(
        [submission('s1', fullAnswers)],
        [student('st1', 'Ahmad Hamze', '2'), student('st2', 'Ahmad Hamze', '2')],
        { overrides: { s1: 'update' } },
      );
      expect(rows[0].action).toBe('error');
      expect(rows[0].reason).toMatch(/Choose which existing student/);
    });

    it('uses the admin-chosen match when one is supplied', () => {
      const { rows } = run(
        [submission('s1', fullAnswers)],
        [student('st1', 'Ahmad Hamze', '2'), student('st2', 'Ahmad Hamze', '2')],
        { overrides: { s1: 'update' }, overrideMatchIds: { s1: 'st2' } },
      );
      expect(rows[0].action).toBe('update');
      expect(rows[0].matchedEntityId).toBe('st2');
    });
  });

  describe('fill-blanks-only updates', () => {
    it('only proposes fields that are currently empty', () => {
      const existing = student('st1', 'Ahmad Hamze', '2', {
        mother_number: '416-555-0198', // already set — must not be overwritten
      });
      const { rows } = run([submission('s1', fullAnswers)], [existing], {
        overrides: { s1: 'update' },
      });

      const changed = rows[0].diff.map(d => d.targetField);
      expect(changed).toContain('motherEmail');
      expect(changed).toContain('dateOfBirth');
      expect(changed).toContain('medicalNotes');
      expect(changed).not.toContain('motherPhone'); // already had a value
      expect(changed).not.toContain('name');        // unchanged
    });

    it('treats a whitespace-only value as blank and fills it', () => {
      const existing = student('st1', 'Ahmad Hamze', '2', { mother_email: '   ' });
      const { rows } = run([submission('s1', fullAnswers)], [existing], {
        overrides: { s1: 'update' },
      });
      expect(rows[0].diff.map(d => d.targetField)).toContain('motherEmail');
    });

    it('downgrades a no-op update to a skip with a reason', () => {
      const existing = student('st1', 'Ahmad Hamze', '2', {
        date_of_birth: '2019-04-11',
        mother_email: 'parent@example.com',
        mother_number: '416-555-0142',
        medical_notes: 'Peanut allergy',
      });
      const { rows } = run([submission('s1', fullAnswers)], [existing], {
        overrides: { s1: 'update' },
      });
      expect(rows[0].action).toBe('skip');
      expect(rows[0].reason).toMatch(/Nothing to fill in/);
    });
  });

  it('summarizes a mixed batch', () => {
    const { summary } = run(
      [
        submission('s1', fullAnswers),                                            // create
        submission('s2', { ...fullAnswers, [F.name]: 'Zaynab Assi' }),            // create
        submission('s3', { ...fullAnswers, [F.name]: 'Yousuf Farhat' }),          // exact → skip
        submission('s4', { ...fullAnswers, [F.grade]: 'Grade 9' }),               // error
        submission('s5', fullAnswers, { imported_student_id: 'st9' }),            // linked → skip
      ],
      [student('st3', 'Yousuf Farhat', '2')],
    );
    expect(summary).toMatchObject({ create: 2, skip: 2, error: 1, total: 5 });
  });
});

// ─── The same child twice in one batch ────────────────────────────────

describe('classifyBatch: duplicates inside one batch', () => {
  it('creates the first submission for a child and skips the second', () => {
    const { rows, summary } = run([
      submission('s1', fullAnswers),
      submission('s2', { ...fullAnswers, [F.medical]: 'None' }),
    ]);
    expect(rows.map(r => r.action)).toEqual(['create', 'skip']);
    expect(rows[1]).toMatchObject({
      matchTier: 'batch',
      needsReview: false,
      reason: 'Same student as an earlier submission in this import',
    });
    expect(rows[1].locked).toBeUndefined(); // the admin may still decide otherwise
    expect(summary).toMatchObject({ create: 1, skip: 1 });
  });

  it('matches the name loosely, the way existing students are matched', () => {
    const { rows } = run([
      submission('s1', fullAnswers),
      submission('s2', { ...fullAnswers, [F.name]: '  ahmad   HAMZE ' }),
      submission('s3', { ...fullAnswers, [F.name]: 'Hamze Ahmad' }),
    ]);
    expect(rows[1]).toMatchObject({ action: 'skip', matchTier: 'batch', needsReview: false });
    // Same words in another order is only a possible match: a person decides.
    expect(rows[2]).toMatchObject({ action: 'skip', matchTier: 'batch', needsReview: true });
    expect(rows[2].reason).toContain('Ahmad Hamze');
  });

  it('lets the admin create both, for two children who share a name', () => {
    const { rows } = run(
      [submission('s1', fullAnswers), submission('s2', fullAnswers)],
      [],
      { overrides: { s2: 'create' } },
    );
    expect(rows.map(r => r.action)).toEqual(['create', 'create']);
  });

  it('does not hold a name against later rows when its own row is not created', () => {
    const { rows } = run(
      [submission('s1', fullAnswers), submission('s2', fullAnswers)],
      [],
      { overrides: { s1: 'skip' } },
    );
    expect(rows.map(r => r.action)).toEqual(['skip', 'create']);
  });

  it('keeps different children apart', () => {
    const { rows } = run([
      submission('s1', fullAnswers),
      submission('s2', { ...fullAnswers, [F.name]: 'Layla Hamze' }),
    ]);
    expect(rows.map(r => r.action)).toEqual(['create', 'create']);
  });

  it('cannot update a student that this import has not created yet', () => {
    const { rows } = run(
      [submission('s1', fullAnswers), submission('s2', fullAnswers)],
      [],
      { overrides: { s2: 'update' } },
    );
    expect(rows[1]).toMatchObject({ action: 'error', matchTier: 'batch' });
    expect(rows[1].matchCandidates).toEqual([]);
  });

  it('prefers the existing student over the batch when both match', () => {
    const { rows } = run(
      [submission('s1', fullAnswers), submission('s2', fullAnswers)],
      [student('stu-1', 'Ahmad Hamze', '2')],
    );
    expect(rows.map(r => r.matchTier)).toEqual(['exact', 'exact']);
  });
});

// ─── Custom fields ────────────────────────────────────────────────────

describe('classifyBatch: custom fields', () => {
  const BUS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const Q_BUS = '11111111-1111-4111-8111-111111111111';
  const withBus = [
    ...mappings,
    {
      field_id: Q_BUS, target_field: 'custom', value_map: null,
      custom_field_id: BUS, custom_label: 'Bus route', custom_type: 'select', custom_options: ['Route 4', 'Walks'],
    },
  ];
  const classify = (submissions, candidates = [], opts = {}) =>
    classifyBatch({ submissions, mappings: withBus, candidates, target, ...opts });

  it('carries the answer into the row and labels it for the preview', () => {
    const { rows } = classify([submission('s1', { ...fullAnswers, [Q_BUS]: 'Route 4' })]);
    expect(rows[0].action).toBe('create');
    expect(rows[0].values[`custom:${BUS}`]).toBe('Route 4');
    expect(rows[0].extras).toEqual([{ fieldId: BUS, label: 'Bus route', display: 'Route 4' }]);
  });

  it('leaves the field out when the question was not answered', () => {
    const { rows } = classify([submission('s1', fullAnswers)]);
    expect(rows[0].action).toBe('create');
    expect(rows[0].extras).toEqual([]);
  });

  it('blocks only the row whose answer the field cannot hold', () => {
    const { rows } = classify([
      submission('s1', { ...fullAnswers, [Q_BUS]: 'Helicopter' }),
      submission('s2', { ...fullAnswers, [F.name]: 'Layla Hamze', [Q_BUS]: 'Walks' }),
    ]);
    expect(rows[0]).toMatchObject({ action: 'error', reason: '"Helicopter" is not one of the choices for Bus route' });
    expect(rows[1].action).toBe('create');
  });

  it('fills the field on an existing student only when it is empty', () => {
    const answers = { ...fullAnswers, [Q_BUS]: 'Route 4' };
    const empty = student('stu-1', 'Ahmad Hamze', '2', { custom_fields: { values: {}, notes: [] } });
    const filled = student('stu-1', 'Ahmad Hamze', '2', { custom_fields: { values: { [BUS]: 'Walks' }, notes: [] } });

    const toEmpty = classify([submission('s1', answers)], [empty], { overrides: { s1: 'update' } }).rows[0];
    expect(toEmpty.diff.find(d => d.targetField === `custom:${BUS}`)).toMatchObject({ label: 'Bus route', to: 'Route 4', value: 'Route 4' });

    const toFilled = classify([submission('s1', answers)], [filled], { overrides: { s1: 'update' } }).rows[0];
    expect(toFilled.diff.some(d => d.targetField === `custom:${BUS}`)).toBe(false);
  });
});

describe('mapAnswers: every problem with a row', () => {
  it('reports an impossible date as that row\'s error', () => {
    const { errors } = mapAnswers(submission('s1', { ...fullAnswers, [F.dob]: '2019-02-31' }), mappings, target);
    expect(errors).toEqual([{ targetField: 'dateOfBirth', message: '"2019-02-31" is not a real date' }]);
  });
});
