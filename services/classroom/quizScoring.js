// services/classroom/quizScoring.js
//
// Quiz scoring (T23), pure: what the machine awards for one answer, the
// attempt's totals, and the builder's validation. Auto-grading is
// deterministic, so re-running it (a submit retried, an answer key changed)
// always gives the same points. Effective points are
// COALESCE(teacher_points, auto_points): a regrade never wipes an override.
//
// Rows are the quiz_questions / quiz_answers columns (snake_case).

const round2 = (n) => Math.round(n * 100) / 100;
const normalizeShort = (s) => String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Points the machine can award; null = a teacher must grade it (written answers). */
function autoPoints(q, answer) {
  const pts = Number(q.points);
  const correct = Array.isArray(q.correct) ? q.correct : [];
  switch (q.kind) {
    case 'one':
      return answer && correct.includes(answer.choice) ? pts : 0;
    case 'many': {
      const picked = new Set(Array.isArray(answer?.choices) ? answer.choices : []);
      const right = [...picked].filter((c) => correct.includes(c)).length;
      if (!q.partial_credit) return right === correct.length && picked.size === correct.length ? pts : 0;
      const wrong = picked.size - right;
      return correct.length ? round2(Math.max(0, (right - wrong) / correct.length) * pts) : 0;
    }
    case 'short': {
      const a = normalizeShort(answer?.text);
      return a !== '' && (q.accepted || []).some((x) => normalizeShort(x) === a) ? pts : 0;
    }
    case 'long':
      return null;
    default:
      return 0;
  }
}
const effectivePoints = (a) => (a.teacher_points != null ? Number(a.teacher_points) : a.auto_points != null ? Number(a.auto_points) : null);

/** earned/possible over every question; needsReview while any answer has no points yet. */
function attemptTotals(questions, answers) {
  const byQ = new Map(answers.map((a) => [a.question_id, a]));
  let earned = 0; let possible = 0; let needsReview = false;
  for (const q of questions) {
    possible += Number(q.points);
    const a = byQ.get(q.question_id);
    const p = a ? effectivePoints(a) : q.kind === 'long' ? null : 0;
    if (p == null) needsReview = true; else earned += p;
  }
  return { earned: round2(earned), possible: round2(possible), needsReview };
}
const canReleaseOnSubmit = (questions) => questions.every((q) => q.kind !== 'long');
const ON_SUBMIT_MESSAGE = 'Release right after submit only works when every question is auto-graded.';

// ── The builder's validation ──────────────────────────────────────────────

const KINDS = Object.freeze(['one', 'many', 'short', 'long']);
const MAX_QUESTIONS = 50;
const PROMPT_MAX = 1000;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;
const OPTION_TEXT_MAX = 300;
const MAX_ACCEPTED = 10;
const ACCEPTED_MAX = 300;
const POINTS_MAX = 100;
const OPTION_ID_RE = /^[a-h]$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A stored object path: no "..", no leading slash, plain characters only.
const SAFE_PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null;

/** One question's options → [{ id, text }], or an error string. */
function checkOptions(raw, n) {
  if (!Array.isArray(raw) || raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) {
    return `Question ${n}: give it ${MIN_OPTIONS} to ${MAX_OPTIONS} choices`;
  }
  const ids = new Set();
  const options = [];
  for (const o of raw) {
    if (!isObject(o) || typeof o.id !== 'string' || !OPTION_ID_RE.test(o.id)) return `Question ${n}: choice ids are the letters a to h`;
    if (ids.has(o.id)) return `Question ${n}: two choices share the id "${o.id}"`;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text || text.length > OPTION_TEXT_MAX) return `Question ${n}: every choice needs 1 to ${OPTION_TEXT_MAX} characters`;
    ids.add(o.id);
    options.push({ id: o.id, text });
  }
  return options;
}

/** The right choices, in the options' order, or an error string. */
function checkCorrect(raw, options, kind, n) {
  if (!Array.isArray(raw) || raw.some((c) => typeof c !== 'string')) return `Question ${n}: mark the right answer`;
  const picked = new Set(raw);
  if (picked.size !== raw.length) return `Question ${n}: a right answer is listed twice`;
  if (raw.some((c) => !options.some((o) => o.id === c))) return `Question ${n}: a right answer isn't one of the choices`;
  if (kind === 'one' && picked.size !== 1) return `Question ${n}: mark exactly one right answer`;
  if (kind === 'many' && picked.size < 1) return `Question ${n}: mark at least one right answer`;
  return options.filter((o) => picked.has(o.id)).map((o) => o.id);
}

/** Accepted short answers (trimmed), or an error string. */
function checkAccepted(raw, n) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ACCEPTED) {
    return `Question ${n}: give 1 to ${MAX_ACCEPTED} accepted answers`;
  }
  const out = [];
  for (const a of raw) {
    const text = typeof a === 'string' ? a.trim() : '';
    if (!text || text.length > ACCEPTED_MAX) return `Question ${n}: every accepted answer needs 1 to ${ACCEPTED_MAX} characters`;
    out.push(text);
  }
  return out;
}

/** One QuestionInput → the normalized question, or { error }. */
function checkQuestion(raw, n, { imagePrefix }) {
  if (!isObject(raw)) return { error: `Question ${n} must be an object` };
  let questionId = null;
  if (has(raw, 'questionId')) {
    if (typeof raw.questionId !== 'string' || !UUID_RE.test(raw.questionId)) return { error: `Question ${n} has an unknown id` };
    questionId = raw.questionId.toLowerCase();
  }
  if (!KINDS.includes(raw.kind)) return { error: `Question ${n}: choose one answer, several answers, short text or written answer` };
  const { kind } = raw;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) return { error: `Question ${n}: write the question` };
  if (prompt.length > PROMPT_MAX) return { error: `Question ${n}: keep the question to ${PROMPT_MAX.toLocaleString('en-US')} characters` };

  let imagePath = null;
  if (has(raw, 'imagePath')) {
    const p = raw.imagePath;
    const ok = typeof p === 'string' && SAFE_PATH_RE.test(p) && !p.includes('..') && (!imagePrefix || p.startsWith(imagePrefix));
    if (!ok) return { error: `Question ${n}: upload the image again` };
    imagePath = p;
  }

  const points = raw.points;
  if (typeof points !== 'number' || !Number.isFinite(points) || points < 0 || points > POINTS_MAX) {
    return { error: `Question ${n}: points must be from 0 to ${POINTS_MAX}` };
  }
  if (has(raw, 'partialCredit') && typeof raw.partialCredit !== 'boolean') return { error: `Question ${n}: partialCredit must be true or false` };
  const partialCredit = raw.partialCredit === true;
  if (partialCredit && kind !== 'many') return { error: `Question ${n}: partial points are only for several-answer questions` };

  let options = [];
  let correct = [];
  let accepted = [];
  if (kind === 'one' || kind === 'many') {
    options = checkOptions(raw.options, n);
    if (typeof options === 'string') return { error: options };
    correct = checkCorrect(raw.correct, options, kind, n);
    if (typeof correct === 'string') return { error: correct };
  } else if (kind === 'short') {
    accepted = checkAccepted(raw.accepted, n);
    if (typeof accepted === 'string') return { error: accepted };
  }
  return { value: { questionId, kind, prompt, imagePath, options, correct, accepted, points: round2(points), partialCredit } };
}

/**
 * The builder's question list, checked: 1–50 questions; a prompt of 1–1 000
 * characters; one/many 2–8 choices with unique ids a–h and text of 1–300,
 * one exactly one right answer, many at least one; short 1–10 non-empty
 * accepted answers; points 0–100; partial credit only for many. With
 * `imagePrefix`, an image must be one stored under it (this quiz's folder).
 * @param {object[]} list QuestionInput[]
 * @param {{ imagePrefix?: string }} [opts]
 * @returns {{ value: object[] } | { error: string }}
 */
function validateQuestions(list, { imagePrefix = null } = {}) {
  if (!Array.isArray(list) || list.length === 0) return { error: 'Add at least one question' };
  if (list.length > MAX_QUESTIONS) return { error: `A quiz holds at most ${MAX_QUESTIONS} questions` };
  const ids = new Set();
  const value = [];
  for (let i = 0; i < list.length; i += 1) {
    const checked = checkQuestion(list[i], i + 1, { imagePrefix });
    if (checked.error) return checked;
    const { questionId } = checked.value;
    if (questionId && ids.has(questionId)) return { error: `Question ${i + 1} is listed twice` };
    if (questionId) ids.add(questionId);
    value.push(checked.value);
  }
  return { value };
}

module.exports = {
  normalizeShort, autoPoints, effectivePoints, attemptTotals, canReleaseOnSubmit, validateQuestions, ON_SUBMIT_MESSAGE,
};
