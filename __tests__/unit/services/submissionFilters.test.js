const {
  UUID_REGEX,
  buildSubmissionsQuery,
  buildFieldSortClause,
  findGradeField,
  findStudentNameField,
  buildSubmissionsSort,
  parseSorts,
  parseFieldFilters,
  parseImportState,
  buildSubmissionsWhere,
} = require('../../../services/submissionFilters');

// ─── Fixtures ─────────────────────────────────────────────────────────
const F = {
  name: '62e82959-01d3-43af-960d-b7f052ef18f5',
  grade: 'f67b0c39-110d-4619-b8d8-afa6d8b3dce5',
  email: '812261e5-d39f-4aaf-8aa6-120bf76d7979',
  notes: '7e494f75-e809-413f-8210-9dfd4aa0bd2a',
  emptySelect: '0b2c15d1-7cc1-4cae-a20f-34e271df3ebf',
};

const fields = [
  { field_id: F.name, field_type: 'text', label: 'Name of Student', options: null },
  { field_id: F.grade, field_type: 'radio', label: 'Grade', options: ['JK', 'SK', 'Grade 1', 'Grade 2'] },
  { field_id: F.email, field_type: 'email', label: 'Parent Email', options: null },
  { field_id: F.notes, field_type: 'textarea', label: 'Medical notes', options: null },
  // A choice field with no options falls back to plain text comparison.
  { field_id: F.emptySelect, field_type: 'select', label: 'Campus', options: [] },
];

// ─── buildFieldSortClause ─────────────────────────────────────────────
describe('buildFieldSortClause', () => {
  it('rejects a malformed field_id', () => {
    expect(() => buildFieldSortClause({ field_id: 'nope', field_type: 'text' }, 'asc', [])).toThrow(
      'Invalid field_id format'
    );
  });

  it('sorts choice fields by option position and binds the options array', () => {
    const params = ['existing'];
    const sql = buildFieldSortClause(fields[1], 'desc', params);
    expect(sql).toBe(`array_position($2::text[], answers->>'${F.grade}') DESC NULLS LAST`);
    expect(params).toEqual(['existing', ['JK', 'SK', 'Grade 1', 'Grade 2']]);
  });

  it('defaults to ASC for anything other than desc', () => {
    const params = [];
    expect(buildFieldSortClause(fields[1], 'sideways', params)).toContain(' ASC NULLS LAST');
    expect(buildFieldSortClause(fields[1], undefined, params)).toContain(' ASC NULLS LAST');
  });

  it('uses a case-insensitive text comparison for non-choice fields', () => {
    const params = [];
    expect(buildFieldSortClause(fields[0], 'asc', params)).toBe(
      `LOWER(answers->>'${F.name}') ASC NULLS LAST`
    );
    expect(params).toEqual([]);
  });

  it('falls back to text comparison for a choice field with no options', () => {
    const params = [];
    expect(buildFieldSortClause(fields[4], 'asc', params)).toBe(
      `LOWER(answers->>'${F.emptySelect}') ASC NULLS LAST`
    );
    expect(buildFieldSortClause({ ...fields[4], options: 'not-an-array' }, 'asc', params)).toContain('LOWER(');
    expect(params).toEqual([]);
  });
});

// ─── findGradeField / findStudentNameField ────────────────────────────
describe('field heuristics', () => {
  it('finds the grade field only among choice fields', () => {
    expect(findGradeField(fields)).toBe(fields[1]);
    expect(findGradeField([{ field_id: F.name, field_type: 'text', label: 'Grade' }])).toBeNull();
    expect(findGradeField([{ field_id: F.grade, field_type: 'select', label: 'Kindergarten year' }])).not.toBeNull();
  });

  it('tolerates fields without a label', () => {
    expect(findGradeField([{ field_id: F.grade, field_type: 'radio' }])).toBeNull();
    expect(findStudentNameField([{ field_id: F.name, field_type: 'text' }])).toBeNull();
  });

  it('finds the student name field by label', () => {
    expect(findStudentNameField(fields)).toBe(fields[0]);
    expect(findStudentNameField([])).toBeNull();
  });
});

// ─── buildSubmissionsSort ─────────────────────────────────────────────
describe('buildSubmissionsSort', () => {
  it('defaults to newest first with no sorts and no export default', () => {
    expect(buildSubmissionsSort(fields, undefined, false)).toEqual({ clause: 'submitted_at DESC', params: [] });
    expect(buildSubmissionsSort(fields, 'not-an-array', false)).toEqual({ clause: 'submitted_at DESC', params: [] });
  });

  it('appends a stable date tiebreaker when the user sorts by a field', () => {
    const { clause, params } = buildSubmissionsSort(fields, [{ fieldId: F.name, dir: 'asc' }], false);
    expect(clause).toBe(`LOWER(answers->>'${F.name}') ASC NULLS LAST, submitted_at DESC`);
    expect(params).toEqual([]);
  });

  it('does not add the tiebreaker when submittedAt is already in the sort', () => {
    const { clause } = buildSubmissionsSort(
      fields,
      [{ fieldId: F.grade, dir: 'desc' }, { fieldId: 'submittedAt', dir: 'asc' }],
      false
    );
    expect(clause).toBe(`array_position($1::text[], answers->>'${F.grade}') DESC NULLS LAST, submitted_at ASC`);
  });

  it('treats any submittedAt direction other than asc as DESC', () => {
    expect(buildSubmissionsSort(fields, [{ fieldId: 'submittedAt', dir: 'desc' }], false).clause).toBe('submitted_at DESC');
    expect(buildSubmissionsSort(fields, [{ fieldId: 'submittedAt' }], false).clause).toBe('submitted_at DESC');
  });

  it('ignores sorts on unknown fields', () => {
    const unknown = '11111111-1111-1111-1111-111111111111';
    expect(buildSubmissionsSort(fields, [{ fieldId: unknown, dir: 'asc' }], false)).toEqual({
      clause: 'submitted_at DESC',
      params: [],
    });
  });

  it('uses Grade ASC, Name ASC for the export default', () => {
    const { clause, params } = buildSubmissionsSort(fields, [], true);
    expect(clause).toBe(
      `array_position($1::text[], answers->>'${F.grade}') ASC NULLS LAST, ` +
        `LOWER(answers->>'${F.name}') ASC NULLS LAST, submitted_at DESC`
    );
    expect(params).toEqual([['JK', 'SK', 'Grade 1', 'Grade 2']]);
  });

  it('export default copes with only one of the heuristic fields present', () => {
    expect(buildSubmissionsSort([fields[0]], [], true).clause).toBe(
      `LOWER(answers->>'${F.name}') ASC NULLS LAST, submitted_at DESC`
    );
    expect(buildSubmissionsSort([fields[1]], [], true).clause).toContain('array_position');
  });

  it('export default falls back to date when neither heuristic field exists', () => {
    expect(buildSubmissionsSort([fields[2]], [], true)).toEqual({ clause: 'submitted_at DESC', params: [] });
  });
});

// ─── parseSorts ───────────────────────────────────────────────────────
describe('parseSorts', () => {
  it('parses the multi-sort param and normalizes directions', () => {
    expect(parseSorts({ sort: `${F.grade}:desc,${F.name}:asc,submittedAt:bogus` })).toEqual([
      { fieldId: F.grade, dir: 'desc' },
      { fieldId: F.name, dir: 'asc' },
      { fieldId: 'submittedAt', dir: 'asc' },
    ]);
  });

  it('drops empty pairs and trims whitespace', () => {
    expect(parseSorts({ sort: ` ${F.name} :desc,,:asc` })).toEqual([{ fieldId: F.name, dir: 'desc' }]);
  });

  it('falls back to the legacy single-sort params', () => {
    expect(parseSorts({ sortFieldId: F.name, sortDir: 'desc' })).toEqual([{ fieldId: F.name, dir: 'desc' }]);
    expect(parseSorts({ sortFieldId: F.name })).toEqual([{ fieldId: F.name, dir: 'asc' }]);
  });

  it('prefers sort over the legacy params and returns [] with neither', () => {
    expect(parseSorts({ sort: `${F.name}:asc`, sortFieldId: F.grade, sortDir: 'desc' })).toEqual([
      { fieldId: F.name, dir: 'asc' },
    ]);
    expect(parseSorts({})).toEqual([]);
  });
});

// ─── parseFieldFilters ────────────────────────────────────────────────
describe('parseFieldFilters', () => {
  it('returns [] when absent, malformed, or not an array', () => {
    expect(parseFieldFilters({})).toEqual([]);
    expect(parseFieldFilters({ fieldFilters: '{not json' })).toEqual([]);
    expect(parseFieldFilters({ fieldFilters: '{"fieldId":"x","values":[]}' })).toEqual([]);
  });

  it('keeps only well-formed entries and stringifies values', () => {
    const raw = JSON.stringify([
      { fieldId: F.grade, values: ['JK', 2] },
      { fieldId: 42, values: ['x'] },
      { fieldId: F.name, values: 'not-array' },
      null,
    ]);
    expect(parseFieldFilters({ fieldFilters: raw })).toEqual([{ fieldId: F.grade, values: ['JK', '2'] }]);
  });
});

// ─── parseImportState ─────────────────────────────────────────────────
describe('parseImportState', () => {
  it('accepts only the two known states', () => {
    expect(parseImportState({ importState: 'imported' })).toBe('imported');
    expect(parseImportState({ importState: 'not_imported' })).toBe('not_imported');
    expect(parseImportState({ importState: 'all' })).toBeNull();
    expect(parseImportState({})).toBeNull();
  });
});

// ─── buildSubmissionsWhere ────────────────────────────────────────────
describe('buildSubmissionsWhere', () => {
  it('always binds status and date range as nullable params after form_id', () => {
    const { clause, params } = buildSubmissionsWhere(fields, {});
    expect(params).toEqual([null, null, null]);
    expect(clause).toContain('form_id = $1');
    expect(clause).toContain('($2::varchar IS NULL OR status = $2)');
    expect(clause).toContain('($3::timestamptz IS NULL OR submitted_at >= $3)');
    expect(clause).toContain('($4::timestamptz IS NULL OR submitted_at <= $4)');
    expect(clause).not.toContain('imported_student_id');
  });

  it('passes supplied status and dates through', () => {
    const { params } = buildSubmissionsWhere(fields, { status: 'new', dateFrom: '2026-01-01', dateTo: '2026-02-01' });
    expect(params).toEqual(['new', '2026-01-01', '2026-02-01']);
  });

  it('inlines the import-state condition', () => {
    expect(buildSubmissionsWhere(fields, { importState: 'imported' }).clause).toContain('imported_student_id IS NOT NULL');
    expect(buildSubmissionsWhere(fields, { importState: 'not_imported' }).clause).toContain('imported_student_id IS NULL');
    expect(buildSubmissionsWhere(fields, { importState: 'weird' }).clause).not.toContain('imported_student_id');
  });

  it('matches choice fields with ANY over the selected values', () => {
    const { clause, params } = buildSubmissionsWhere(fields, {
      fieldFilters: [{ fieldId: F.grade, values: ['JK', 'SK'] }],
    });
    expect(clause).toContain(`answers->>'${F.grade}' = ANY($5::text[])`);
    expect(params[3]).toEqual(['JK', 'SK']);
  });

  it('matches text-ish fields with ILIKE contains, one bind per value', () => {
    const { clause, params } = buildSubmissionsWhere(fields, {
      fieldFilters: [{ fieldId: F.name, values: ['ali', 'sara'] }],
    });
    expect(clause).toContain(`(answers->>'${F.name}' ILIKE $5 OR answers->>'${F.name}' ILIKE $6)`);
    expect(params.slice(3)).toEqual(['%ali%', '%sara%']);
  });

  it('numbers binds correctly across several filters', () => {
    const { clause, params } = buildSubmissionsWhere(fields, {
      fieldFilters: [
        { fieldId: F.grade, values: ['JK'] },
        { fieldId: F.email, values: ['@example.com'] },
      ],
    });
    expect(clause).toContain('= ANY($5::text[])');
    expect(clause).toContain('ILIKE $6');
    expect(params).toEqual([null, null, null, ['JK'], '%@example.com%']);
  });

  it('skips unknown, malformed, empty and non-array filters', () => {
    const { clause, params } = buildSubmissionsWhere(fields, {
      fieldFilters: [
        { fieldId: '11111111-1111-1111-1111-111111111111', values: ['x'] }, // unknown field
        { fieldId: F.notes, values: ['', ''] }, // all empty → dropped
        { fieldId: F.grade, values: 'JK' }, // not an array → dropped
        { fieldId: F.name, values: [7] }, // number is stringified
      ],
    });
    expect(params).toEqual([null, null, null, '%7%']);
    expect(clause).not.toContain(F.notes);
    expect(clause).not.toContain(F.grade);
  });

  it('skips a known field whose id is not a UUID', () => {
    const odd = [{ field_id: 'not-a-uuid', field_type: 'text', label: 'X' }];
    const { params } = buildSubmissionsWhere(odd, { fieldFilters: [{ fieldId: 'not-a-uuid', values: ['a'] }] });
    expect(params).toEqual([null, null, null]);
  });

  it('treats a missing fieldFilters list as empty', () => {
    expect(buildSubmissionsWhere(fields, { fieldFilters: null }).params).toEqual([null, null, null]);
  });
});

// ─── buildSubmissionsQuery ────────────────────────────────────────────
describe('buildSubmissionsQuery', () => {
  const formId = '22222222-2222-2222-2222-222222222222';

  it('shifts ORDER BY binds past form_id and the WHERE params', () => {
    const q = buildSubmissionsQuery(
      formId,
      fields,
      { status: 'new', fieldFilters: [{ fieldId: F.name, values: ['a'] }] },
      [{ fieldId: F.grade, dir: 'asc' }]
    );
    // $1 form, $2 status, $3 from, $4 to, $5 ILIKE, then the options array is $6
    expect(q.orderClause).toBe(`array_position($6::text[], answers->>'${F.grade}') ASC NULLS LAST, submitted_at DESC`);
    expect(q.params).toEqual([formId, 'new', null, null, '%a%', ['JK', 'SK', 'Grade 1', 'Grade 2']]);
    expect(q.countParams).toEqual([formId, 'new', null, null, '%a%']);
    expect(q.nextParamIndex).toBe(7);
    expect(q.whereClause).toContain('form_id = $1');
  });

  it('defaults useExportDefault to false', () => {
    const q = buildSubmissionsQuery(formId, fields, {}, []);
    expect(q.orderClause).toBe('submitted_at DESC');
    expect(q.params).toEqual([formId, null, null, null]);
    expect(q.nextParamIndex).toBe(5);
  });

  it('applies the export default ordering when asked', () => {
    const q = buildSubmissionsQuery(formId, fields, {}, [], true);
    expect(q.orderClause).toContain('array_position($5::text[]');
    expect(q.params).toHaveLength(5);
  });
});

describe('UUID_REGEX', () => {
  it('is case-insensitive and anchored', () => {
    expect(UUID_REGEX.test(F.name.toUpperCase())).toBe(true);
    expect(UUID_REGEX.test(`${F.name}x`)).toBe(false);
  });
});
