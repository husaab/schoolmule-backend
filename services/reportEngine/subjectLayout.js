// services/reportEngine/subjectLayout.js
//
// A school's subject headings on progress reports (report_subject_layouts,
// Report templates → Subject headings). The layout is a list of sections in
// print order, each with its subjects in order:
//
//   [{ heading: 'Religious Studies',
//      subjects: [{ name: 'Quran', classes: ['Quran', 'Quran Teaching'] }, …] }, …]
//
// A subject prints under its own name and covers the classes whose subject is
// one of `classes` (its own name when none are listed). Matching ignores case
// and extra spaces. A class no subject covers prints last, under "Other
// Subjects". A school with no layout prints as before: A to Z, no headings.

const LIMITS = { sections: 20, subjects: 20, classes: 20, text: 80 };
const OTHER_HEADING = 'Other Subjects';

const tidy = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const matchKey = (value) => tidy(value).toLowerCase();

/** The class subjects a layout subject covers (its own name when it lists none). */
const covered = (subject) => (subject.classes.length > 0 ? subject.classes : [subject.name]);

/**
 * The layout as sent by the office, tidied: { value } or { error } (in words
 * for the office). Headings and subject names are needed; empty class names
 * are dropped; a class name may appear only once in the whole layout.
 */
function readSubjectLayout(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Add at least one heading' };
  if (raw.length > LIMITS.sections) return { error: `A report can have at most ${LIMITS.sections} headings` };
  const headings = new Set();
  const claimed = new Map(); // match key → the subject that covers it
  const sections = [];
  for (const section of raw) {
    if (!section || typeof section !== 'object') return { error: 'Each heading needs a name and its subjects' };
    const heading = tidy(section.heading);
    if (!heading) return { error: 'Every heading needs a name' };
    if (heading.length > LIMITS.text) return { error: `"${heading.slice(0, 30)}…" is longer than ${LIMITS.text} characters` };
    if (headings.has(heading.toLowerCase())) return { error: `"${heading}" is in the list twice` };
    headings.add(heading.toLowerCase());
    if (!Array.isArray(section.subjects) || section.subjects.length === 0) return { error: `Add a subject under "${heading}"` };
    if (section.subjects.length > LIMITS.subjects) return { error: `"${heading}" can have at most ${LIMITS.subjects} subjects` };
    const subjects = [];
    for (const subject of section.subjects) {
      if (!subject || typeof subject !== 'object') return { error: `Each subject under "${heading}" needs a name` };
      const name = tidy(subject.name);
      if (!name) return { error: `Every subject under "${heading}" needs a name` };
      if (name.length > LIMITS.text) return { error: `"${name.slice(0, 30)}…" is longer than ${LIMITS.text} characters` };
      if (subject.classes != null && !Array.isArray(subject.classes)) return { error: `The classes for "${name}" must be a list` };
      const classes = [];
      for (const c of subject.classes ?? []) {
        if (typeof c !== 'string') return { error: `The classes for "${name}" must be names` };
        const className = tidy(c);
        if (!className || classes.some((x) => matchKey(x) === matchKey(className))) continue;
        if (className.length > LIMITS.text) return { error: `"${className.slice(0, 30)}…" is longer than ${LIMITS.text} characters` };
        classes.push(className);
      }
      if (classes.length > LIMITS.classes) return { error: `"${name}" can cover at most ${LIMITS.classes} class names` };
      const entry = { name, classes };
      for (const className of covered(entry)) {
        const other = claimed.get(matchKey(className));
        if (other) return { error: `Classes named "${className}" are under both "${other}" and "${name}". Keep them under one.` };
        claimed.set(matchKey(className), name);
      }
      subjects.push(entry);
    }
    sections.push({ heading, subjects });
  }
  return { value: sections };
}

/**
 * The rows in the layout's order. Each row gets `section` (its heading) and
 * the layout's subject name in `field`; rows no subject covers come last under
 * "Other Subjects" in their own order. Without a layout the rows come back as
 * they were, with no `section`.
 */
function applySubjectLayout(rows, sections, field = 'name') {
  if (!Array.isArray(sections) || sections.length === 0) return rows;
  const place = new Map(); // match key → { s, k, heading, name }
  sections.forEach((section, s) =>
    section.subjects.forEach((subject, k) => {
      for (const className of covered(subject)) {
        const key = matchKey(className);
        if (!place.has(key)) place.set(key, { s, k, heading: section.heading, name: subject.name });
      }
    }),
  );
  return rows
    .map((row, i) => {
      const at = place.get(matchKey(row[field]));
      return at
        ? { row: { ...row, [field]: at.name, section: at.heading }, s: at.s, k: at.k, i }
        : { row: { ...row, section: OTHER_HEADING }, s: sections.length, k: 0, i };
    })
    .sort((a, b) => a.s - b.s || a.k - b.k || a.i - b.i)
    .map((x) => x.row);
}

/** The school's saved sections, or null when it has none. */
async function loadSubjectLayout(client, school) {
  const { rows } = await client.query('SELECT sections FROM report_subject_layouts WHERE school = $1', [school]);
  const sections = rows[0] && rows[0].sections;
  return Array.isArray(sections) && sections.length > 0 ? sections : null;
}

module.exports = { LIMITS, OTHER_HEADING, readSubjectLayout, applySubjectLayout, loadSubjectLayout };
