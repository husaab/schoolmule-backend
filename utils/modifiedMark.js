// utils/modifiedMark.js
//
// A modified mark: one student's real score on a different version of an
// assessment. The rules and wording that every server surface shares. The web
// and app keep the same rules in src/lib/modifiedMark.ts.
//
// The flag lives in modified_marks, away from the score, so a score write or a
// move between draft and published can't lose it. It only means something on a
// real mark, which is what isEffectivelyModified checks.

const { cellState } = require('../services/gradeEngine');

const MODIFIED_LABEL_MAX = 80;
const MODIFIED_LABEL_ERROR = 'Use plain words about the test. Families read this label.';
const REFUSED_WORD = /\biep\b/i;

/** Trimmed, with inner whitespace collapsed; an empty label is no label. */
function normalizeModifiedLabel(raw) {
  if (raw == null) return null;
  const label = String(raw).trim().replace(/\s+/g, ' ');
  return label === '' ? null : label;
}

/** The error to show for a normalized label, or null when it's fine. */
function validateModifiedLabel(label) {
  if (label == null) return null;
  if (label.length > MODIFIED_LABEL_MAX || REFUSED_WORD.test(label)) return MODIFIED_LABEL_ERROR;
  return null;
}

/** Flagged, and the cell holds a real mark. Blank, missing and excused cells never show it. */
function isEffectivelyModified(row) {
  return Boolean(row?.is_modified) && cellState(row) === 'graded';
}

/** The labels to print: repeats removed ignoring case, unlabelled marks skipped. */
function uniqueLabels(labels) {
  const seen = new Map();
  for (const raw of labels || []) {
    const label = normalizeModifiedLabel(raw);
    if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  }
  return [...seen.values()];
}

/** Whether these score rows hold a real modified mark, and their labels. */
function modifiedSummary(rows) {
  const marks = (rows || []).filter(isEffectivelyModified);
  return { modified: marks.length > 0, labels: uniqueLabels(marks.map((r) => r.modified_label)) };
}

/** The line a report card prints inside a subject's card. */
function modifiedNote(labels) {
  const unique = uniqueLabels(labels);
  const named = unique.length >= 1 && unique.length <= 2;
  return named ? `* Includes modified assessments: ${unique.join('; ')}` : '* Includes modified assessments';
}

/** The line on an email's grade row. */
function modifiedEmailLine(label) {
  return label ? `Modified assessment · ${label}` : 'Modified assessment';
}

/** What the word means, once per email. */
function modifiedExplainer(first) {
  return `Modified means ${first} wrote a different version of this assessment, set by the teacher. The mark shows how ${first} did on that version, so it can't be compared directly to the class's test.`;
}

module.exports = {
  MODIFIED_LABEL_MAX,
  MODIFIED_LABEL_ERROR,
  normalizeModifiedLabel,
  validateModifiedLabel,
  isEffectivelyModified,
  modifiedSummary,
  uniqueLabels,
  modifiedNote,
  modifiedEmailLine,
  modifiedExplainer,
};
