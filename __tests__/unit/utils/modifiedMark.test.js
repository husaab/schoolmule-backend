const {
  MODIFIED_LABEL_MAX,
  MODIFIED_LABEL_ERROR,
  modifiedSummary,
  normalizeModifiedLabel,
  validateModifiedLabel,
  isEffectivelyModified,
  modifiedNote,
  modifiedEmailLine,
  modifiedExplainer,
} = require('../../../utils/modifiedMark');

describe('normalizeModifiedLabel', () => {
  it('trims and collapses inner whitespace', () => {
    expect(normalizeModifiedLabel('  Grade   3 level ')).toBe('Grade 3 level');
  });

  it('treats an empty label as no label', () => {
    expect(normalizeModifiedLabel('   ')).toBeNull();
    expect(normalizeModifiedLabel('')).toBeNull();
    expect(normalizeModifiedLabel(null)).toBeNull();
    expect(normalizeModifiedLabel(undefined)).toBeNull();
  });
});

describe('validateModifiedLabel', () => {
  it('allows up to the limit and no label at all', () => {
    expect(MODIFIED_LABEL_MAX).toBe(80);
    expect(validateModifiedLabel('x'.repeat(80))).toBeNull();
    expect(validateModifiedLabel(null)).toBeNull();
  });

  it('refuses a label over the limit', () => {
    expect(validateModifiedLabel('x'.repeat(81))).toBe(MODIFIED_LABEL_ERROR);
  });

  it.each(['iep test', 'IEP', 'on an Iep plan', 'plan (IEP)'])('refuses %s', (label) => {
    expect(validateModifiedLabel(label)).toBe(MODIFIED_LABEL_ERROR);
  });

  it('only refuses the whole word', () => {
    expect(validateModifiedLabel('Recipe test')).toBeNull();
  });

  it('says what to do without naming the word', () => {
    expect(MODIFIED_LABEL_ERROR).toBe('Use plain words about the test. Families read this label.');
  });
});

describe('isEffectivelyModified', () => {
  it('is true for a flagged graded score, including a real 0', () => {
    expect(isEffectivelyModified({ is_modified: true, status: 'graded', score: 40 })).toBe(true);
    expect(isEffectivelyModified({ is_modified: true, status: 'graded', score: 0 })).toBe(true);
  });

  it('is false for a blank, missing or excused cell, whatever the flag', () => {
    expect(isEffectivelyModified({ is_modified: true, status: 'graded', score: null })).toBe(false);
    expect(isEffectivelyModified({ is_modified: true, status: 'missing', score: null })).toBe(false);
    expect(isEffectivelyModified({ is_modified: true, status: 'excused', score: 40 })).toBe(false);
  });

  it('is false without the flag', () => {
    expect(isEffectivelyModified({ status: 'graded', score: 40 })).toBe(false);
    expect(isEffectivelyModified({ is_modified: false, status: 'graded', score: 40 })).toBe(false);
    expect(isEffectivelyModified(null)).toBe(false);
  });
});

describe('modifiedNote', () => {
  it('stops at the sentence with no labels', () => {
    expect(modifiedNote([])).toBe('* Includes modified assessments');
  });

  it('prints one or two labels, ignoring case and spacing when it removes repeats', () => {
    expect(modifiedNote(['A'])).toBe('* Includes modified assessments: A');
    expect(modifiedNote(['A', ' a ', 'B'])).toBe('* Includes modified assessments: A; B');
  });

  it('stops at the sentence with more than two labels', () => {
    expect(modifiedNote(['A', 'B', 'C'])).toBe('* Includes modified assessments');
  });

  it('ignores an unlabelled mark beside a labelled one', () => {
    expect(modifiedNote(['A', null])).toBe('* Includes modified assessments: A');
  });
});

describe('modifiedSummary', () => {
  const graded = (label) => ({ is_modified: true, modified_label: label, status: 'graded', score: 40 });

  it('collects the labels of the real modified marks', () => {
    expect(modifiedSummary([graded('A'), graded(null), { status: 'graded', score: 40 }])).toEqual({ modified: true, labels: ['A'] });
  });

  it('ignores flags on cells with no real mark', () => {
    expect(modifiedSummary([
      { is_modified: true, modified_label: 'A', status: 'missing', score: null },
      { is_modified: true, modified_label: 'B', status: 'excused', score: 40 },
      { is_modified: true, modified_label: 'C', status: 'graded', score: null },
    ])).toEqual({ modified: false, labels: [] });
  });
});

describe('modifiedEmailLine', () => {
  it('names the label when there is one', () => {
    expect(modifiedEmailLine('Grade 3 level')).toBe('Modified assessment · Grade 3 level');
  });

  it('stands alone without one', () => {
    expect(modifiedEmailLine(null)).toBe('Modified assessment');
  });
});

describe('modifiedExplainer', () => {
  it('uses the first name in the agreed wording', () => {
    expect(modifiedExplainer('Adam')).toBe(
      "Modified means Adam wrote a different version of this assessment, set by the teacher. The mark shows how Adam did on that version, so it can't be compared directly to the class's test.",
    );
  });
});
