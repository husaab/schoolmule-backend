// services/classroom/quizzes.js
//
// Quizzes (T23): the teacher's builder (questions, images, the answer-key
// change that regrades), the student's one attempt (start, autosaved
// answers, a confirmed submit) and the teacher's per-answer override.
//
// Scores follow the turn-in rules (D3, D17): a quiz's score is a draft on the
// student's submission until Publish (publish.js, the one publish path); a
// quiz released "on submit" is published for the student as they submit.
// A teacher's override on a published column goes live as it saves, as a
// typed score in the grading view does (D17). An answer-key change keeps
// each student where they are: published students' grades follow it live,
// the others' drafts are updated. A quiz with no gradebook column has no
// score anywhere but its own: its results are released by the same Publish.
//
// The answer key never reaches a student before their grade is visible:
// their reads use selectStudentQuestions (no key columns), and the results,
// key included only when the teacher shows answers, come once the grade is
// visible (spec 0.8; with no column, once the work is published).
//
// Lock order (every quiz writer): the item, its column, the attempt, its
// answers, the submission.

const crypto = require('crypto');
const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/quiz.queries');
const gradingQ = require('../../queries/grading.queries');
const workQ = require('../../queries/classworkSubmission.queries');
const scoring = require('./quizScoring');
const { httpError, inTransaction } = require('./classworkItems');
const { publishSubmissions, ensurePublishBatch } = require('./publish');
const { toWork } = require('./studentWork');
const { signedUrlMap } = require('../../utils/attachmentUpload');

const SHORT_ANSWER_MAX = 300;
const LONG_ANSWER_MAX = 20000;

const MESSAGES = Object.freeze({
  ITEM_NOT_FOUND: 'Item not found',
  ANSWER_NOT_FOUND: 'Answer not found',
  NOT_A_QUIZ: 'Only a quiz has questions.',
  QUIZ_TAKEN: 'Students have already taken this quiz. You can change wording, answers and points, but not remove questions.',
  UNKNOWN_QUESTION: "Some of these questions aren't in this quiz.",
  KIND_LOCKED: (n) => `Students have already answered question ${n}, so its type can't change.`,
  OVERRIDE_ABOVE: (n, points) => `A score you gave on question ${n} is above its ${points} points. Change it first.`,
  NOT_SUBMITTED: "This quiz isn't turned in yet.",
  POINTS_RANGE: (max) => `Points must be from 0 to ${max}`,
  KEPT_ABOVE: (total) => `Some grades on students' work are above ${total}, the quiz's new total. Change them in the grading view first.`,
  NO_COLUMN: "This quiz isn't in the gradebook, so it has no score to use.",
  STILL_TO_GRADE: 'Grade the written answers first, then use the quiz score.',
  STUDENT_NOT_FOUND: 'Student not found',
  // The student's.
  STUDENT_NOT_A_QUIZ: "This isn't a quiz.",
  SUBMITTED: "You've already turned in this quiz.",
  CLOSED: 'This quiz is closed. Ask your teacher.',
  EXCUSED: 'Your teacher excused you from this one.',
  GRADED: 'Your teacher has already graded this.',
  NO_QUESTIONS: 'This quiz has no questions yet. Ask your teacher.',
  BAD_ANSWER: "One of your answers couldn't be saved. Reload the quiz and try again.",
  SHORT_TOO_LONG: `Keep a short answer to ${SHORT_ANSWER_MAX} characters.`,
  LONG_TOO_LONG: `Keep your answer to ${LONG_ANSWER_MAX.toLocaleString('en-US')} characters.`,
});

const HINTS = Object.freeze({ many: 'Pick all that apply.', long: 'Your teacher grades this one.' });
const MAX_ANSWERS_PER_SAVE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (value) => (value ? new Date(value).toISOString() : null);
const num = (value) => (value === null || value === undefined ? null : Number(value));
const round2 = (n) => Math.round(n * 100) / 100;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const totalPointsOf = (questions) => round2(questions.reduce((s, qq) => s + Number(qq.points), 0));

/** Where a quiz's question images live (bucket message-attachments). */
const imagePrefixOf = (school, itemId) => `${school}/classwork/${itemId}/questions/`;

/** The machine's share of an attempt: the sum of its auto points (null when nothing is auto-graded). */
function autoScoreOf(answers) {
  const auto = answers.map((a) => num(a.auto_points)).filter((p) => p !== null);
  return auto.length ? round2(auto.reduce((s, p) => s + p, 0)) : null;
}

/** A uniform shuffle (Fisher–Yates over crypto randomness). */
function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The attempt's order: its stored (shuffled) order, then any question added since; else the quiz's own. */
function orderQuestions(questions, order) {
  if (!Array.isArray(order) || order.length === 0) return questions;
  const byId = new Map(questions.map((qq) => [qq.question_id, qq]));
  const seen = new Set();
  const out = [];
  for (const id of order) {
    const qq = byId.get(id);
    if (qq && !seen.has(id)) { out.push(qq); seen.add(id); }
  }
  for (const qq of questions) if (!seen.has(qq.question_id)) out.push(qq);
  return out;
}

const toOptions = (options) => (Array.isArray(options) ? options.map((o) => ({ id: o.id, text: o.text })) : []);

// ── Shapes ────────────────────────────────────────────────────────────────

/** A quiz_questions row → Question (the teacher's builder: the key included). */
const toQuestion = (r, imageUrl = null) => ({
  questionId: r.question_id,
  kind: r.kind,
  prompt: r.prompt,
  imagePath: r.image_path ?? null,
  imageUrl,
  options: toOptions(r.options),
  correct: Array.isArray(r.correct) ? r.correct : [],
  accepted: Array.isArray(r.accepted) ? r.accepted : [],
  points: Number(r.points),
  partialCredit: Boolean(r.partial_credit),
  sortOrder: Number(r.sort_order) || 0,
});

/** One answer as the teacher grades it (the grading detail and the override reply). */
const toTeacherAnswer = (qq, a) => ({
  answerId: a?.answer_id ?? null,
  questionId: qq.question_id,
  kind: qq.kind,
  prompt: qq.prompt,
  points: Number(qq.points),
  answer: a?.answer ?? null,
  autoPoints: num(a?.auto_points),
  teacherPoints: num(a?.teacher_points),
  teacherNote: a?.teacher_note ?? null,
  correct: Array.isArray(qq.correct) ? qq.correct : [],
  accepted: Array.isArray(qq.accepted) ? qq.accepted : [],
});

/** Signed URLs (1 h) for the questions' images. */
async function imageUrls(rows) {
  const paths = rows.map((r) => r.image_path).filter(Boolean);
  return paths.length ? signedUrlMap(paths) : new Map();
}

// ── The teacher's builder ─────────────────────────────────────────────────

/** The quiz item, or an httpError (404 gone, 400 not a quiz). */
async function loadQuizItem(runner, itemId) {
  const { rows: [item] } = await runner.query(q.selectQuizItem, [itemId]);
  if (!item) throw httpError(404, MESSAGES.ITEM_NOT_FOUND);
  if (item.kind !== 'quiz') throw httpError(400, MESSAGES.NOT_A_QUIZ);
  return item;
}

/** GET …/questions: { questions, settings, hasSubmissions, totalPoints }. */
async function loadBuilder(itemId, runner = db) {
  const item = await loadQuizItem(runner, itemId);
  const [{ rows }, { rows: [count] }] = await Promise.all([
    runner.query(q.selectQuestions, [itemId]),
    runner.query(q.countSubmitted, [itemId]),
  ]);
  const urls = await imageUrls(rows);
  return {
    questions: rows.map((r) => toQuestion(r, r.image_path ? urls.get(r.image_path) ?? null : null)),
    settings: { release: item.quiz_release, shuffle: Boolean(item.quiz_shuffle), showAnswers: Boolean(item.quiz_show_answers) },
    hasSubmissions: (count?.n ?? 0) > 0,
    totalPoints: totalPointsOf(rows),
  };
}

const sameList = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Does the edit change what the machine awards on this question? */
const scoringChanged = (old, next) => old.kind !== next.kind || !sameList(old.correct, next.correct)
  || !sameList(old.accepted, next.accepted) || Number(old.points) !== Number(next.points)
  || Boolean(old.partial_credit) !== Boolean(next.partial_credit);

const groupByAttempt = (answers) => answers.reduce((m, a) => m.set(a.attempt_id, [...(m.get(a.attempt_id) || []), a]), new Map());
const sameTotals = (x, y) => Boolean(x) && Boolean(y) && x.earned === y.earned && x.needsReview === y.needsReview;

/**
 * The score a quiz leaves for one student, in the caller's transaction (the
 * column already locked), once nothing is left to grade by hand (`earned`
 * null: nothing is written, the cell is left as it is). `mode`: 'submit'
 * (always a draft: the score waits for Publish), 'override' (live on a
 * published column, D17, as a typed score), 'regrade' (live only for a
 * student whose grade is already published; otherwise their draft follows).
 * A score a teacher typed (score_set_by_teacher) always wins: the quiz never
 * overwrites it (fix round 1; POST …/quiz-score goes back to the quiz's
 * score). An excused student keeps the excuse. Nothing for a quiz with no
 * column or a student the item is not for.
 * @returns {Promise<{ live: boolean, kept: boolean, wrote: boolean }>}
 *   live: the gradebook was written live; kept: a teacher's typed score stayed
 */
async function writeScore(client, { item, studentId, isPublished, earned, mode, userId = null }) {
  const none = { live: false, kept: false, wrote: false };
  if (!item.assessment_id || earned === null) return none;
  const { rows: [inAudience] } = await client.query(gradingQ.selectAudienceIds, [item.item_id, [studentId]]);
  if (!inAudience) return none;
  await client.query(gradingQ.ensureSubmission, [item.item_id, studentId]);
  const { rows: [cur] } = await client.query(gradingQ.lockSubmission, [item.item_id, studentId]);
  // A typed score holds only while there is one (Mark missing clears both).
  if (cur.score_set_by_teacher && cur.draft_score !== null) return { ...none, kept: true };
  if (cur.draft_status === 'excused' || cur.live_status === 'excused') return none;
  const live = isPublished && (mode === 'override' || (mode === 'regrade' && Boolean(cur.published_at)));
  if (live) {
    const { rows: [cell] } = await client.query(gradingQ.upsertStudentAssessment, [studentId, item.assessment_id, earned, 'graded']);
    await client.query(q.syncQuizLive, [item.item_id, studentId, cell.score, cell.status, userId]);
    return { live: true, kept: false, wrote: true };
  }
  await client.query(q.writeQuizDraft, [item.item_id, studentId, earned, 'graded', userId]);
  return { live: false, kept: false, wrote: true };
}

/** The machine's points for these answers, written where they changed; returns the answers with them. */
async function scoreAnswers(client, questions, answers, onlyQuestionIds = null) {
  const byQ = new Map(questions.map((qq) => [qq.question_id, qq]));
  const ids = [];
  const points = [];
  const out = answers.map((a) => {
    const qq = byQ.get(a.question_id);
    if (!qq || (onlyQuestionIds && !onlyQuestionIds.has(a.question_id))) return a;
    const pts = scoring.autoPoints(qq, a.answer);
    if (num(a.auto_points) !== pts) { ids.push(a.answer_id); points.push(pts); }
    return { ...a, auto_points: pts };
  });
  if (ids.length) await client.query(q.setAutoPoints, [ids, points]);
  return out;
}

/**
 * After an answer-key change (inside PUT's transaction): every turned-in
 * attempt gets a row for each question added since, auto points are re-run
 * on the questions whose key or points changed (teacher overrides are never
 * touched), and each student whose total changed has their score refreshed
 * once nothing is left to grade by hand.
 * @returns {Promise<boolean>} whether the gradebook was written live
 */
async function regrade(client, { item, isPublished, before, beforeQuestions, questions, userId }) {
  const existing = new Map(beforeQuestions.map((qq) => [qq.question_id, qq]));
  const added = questions.filter((qq) => !existing.has(qq.question_id)).map((qq) => qq.question_id);
  const changed = new Set(questions.filter((qq) => existing.has(qq.question_id) && scoringChanged(existing.get(qq.question_id), qq))
    .map((qq) => qq.question_id));
  const { rows: attempts } = await client.query(q.selectSubmittedAttempts, [item.item_id]);
  if (added.length) {
    for (const a of attempts) await client.query(q.insertBlankAnswers, [a.attempt_id, added]);
  }
  const rescore = new Set([...changed, ...added]);
  if (rescore.size === 0) return false;
  const { rows: answers } = await client.query(q.selectSubmittedAnswers, [item.item_id]);
  const scored = await scoreAnswers(client, questions, answers, rescore);
  const byAttempt = groupByAttempt(scored);

  let wroteLive = false;
  for (const attempt of attempts) {
    const mine = byAttempt.get(attempt.attempt_id) || [];
    const autoScore = autoScoreOf(mine);
    if (num(attempt.auto_score) !== autoScore) await client.query(q.updateAutoScore, [attempt.attempt_id, autoScore]);
    const totals = scoring.attemptTotals(questions, mine);
    if (sameTotals(before.get(attempt.attempt_id), totals) || totals.needsReview) continue;
    const { live } = await writeScore(client, { item, studentId: attempt.student_id, isPublished, earned: totals.earned, mode: 'regrade', userId });
    wroteLive = wroteLive || live;
  }
  return wroteLive;
}

/**
 * PUT …/questions: upserts by questionId (sort order = list order) and
 * deletes the rest. Once any student has turned it in, a question can be
 * changed but not removed (409 QUIZ_TAKEN), nor change type; an answer-key
 * change regrades. A linked column's "out of" becomes the quiz's points.
 * @returns {Promise<{ gradebookChanged: boolean, removedImages: string[] }>}
 */
async function saveQuestions({ itemId, school, userId, input }) {
  const checked = scoring.validateQuestions(input, { imagePrefix: imagePrefixOf(school, itemId) });
  if (checked.error) throw httpError(400, checked.error);
  const list = checked.value;

  return inTransaction(async (client) => {
    const { rows: [locked] } = await client.query(q.lockItemUpdate, [itemId]);
    if (!locked) throw httpError(404, MESSAGES.ITEM_NOT_FOUND);
    const item = await loadQuizItem(client, itemId);
    let isPublished = false;
    if (item.assessment_id) {
      const { rows: [a] } = await client.query(gradingQ.lockAssessmentUpdate, [item.assessment_id]);
      isPublished = Boolean(a?.is_published);
    }
    if (item.quiz_release === 'on_submit' && !scoring.canReleaseOnSubmit(list)) throw httpError(400, scoring.ON_SUBMIT_MESSAGE);

    const { rows: beforeQuestions } = await client.query(q.selectQuestions, [itemId]);
    const existing = new Map(beforeQuestions.map((qq) => [qq.question_id, qq]));
    if (list.some((v) => v.questionId && !existing.has(v.questionId))) throw httpError(400, MESSAGES.UNKNOWN_QUESTION);
    const kept = new Set(list.filter((v) => v.questionId).map((v) => v.questionId));
    const removed = beforeQuestions.filter((qq) => !kept.has(qq.question_id));
    const { rows: [{ n: submitted }] } = await client.query(q.countSubmitted, [itemId]);
    if (removed.length && submitted > 0) throw httpError(409, MESSAGES.QUIZ_TAKEN, 'QUIZ_TAKEN');

    // What turned-in students answered: a type change would orphan their
    // answers, and a points cut must not leave an override above the new points.
    const { rows: answered } = submitted > 0 ? await client.query(q.selectSubmittedAnswers, [itemId]) : { rows: [] };
    list.forEach((v, idx) => {
      if (!v.questionId) return;
      const theirs = answered.filter((a) => a.question_id === v.questionId);
      if (!theirs.length) return;
      if (existing.get(v.questionId).kind !== v.kind) throw httpError(409, MESSAGES.KIND_LOCKED(idx + 1), 'QUIZ_TAKEN');
      if (theirs.some((a) => a.teacher_points !== null && Number(a.teacher_points) > v.points)) {
        throw httpError(409, MESSAGES.OVERRIDE_ABOVE(idx + 1, v.points), 'OVERRIDE_ABOVE_POINTS');
      }
    });
    const before = new Map([...groupByAttempt(answered)].map(([attemptId, rows]) => [attemptId, scoring.attemptTotals(beforeQuestions, rows)]));

    const ids = [];
    for (const [idx, v] of list.entries()) {
      const params = [v.kind, v.prompt, v.imagePath, JSON.stringify(v.options), JSON.stringify(v.correct), v.accepted, v.points, v.partialCredit, idx];
      if (v.questionId) {
        await client.query(q.updateQuestion, [v.questionId, itemId, ...params]);
        ids.push(v.questionId);
      } else {
        const { rows: [row] } = await client.query(q.insertQuestion, [itemId, ...params]);
        ids.push(row.question_id);
      }
    }
    if (removed.length) await client.query(q.deleteQuestionsExcept, [itemId, ids]);
    const { rows: questions } = await client.query(q.selectQuestions, [itemId]);

    let gradebookChanged = false;
    const total = totalPointsOf(questions);
    if (item.assessment_id && total > 0) {
      // A score the quiz won't recompute (typed by a teacher, or a grid grade
      // with no attempt) must fit the new "out of" (T16's DRAFT_ABOVE_MAX).
      const { rows: [kept] } = await client.query(q.selectKeptTop, [itemId, item.assessment_id]);
      if (kept?.top !== null && kept?.top !== undefined && kept.top > total) {
        throw httpError(409, MESSAGES.KEPT_ABOVE(total), 'DRAFT_ABOVE_MAX');
      }
      const { rows } = await client.query(q.setColumnMax, [item.assessment_id, total]);
      gradebookChanged = rows.length > 0;
    }
    if (submitted > 0) {
      const live = await regrade(client, { item, isPublished, before, beforeQuestions, questions, userId });
      gradebookChanged = gradebookChanged || live;
    }
    const stillUsed = new Set(questions.map((qq) => qq.image_path).filter(Boolean));
    const removedImages = [...new Set(beforeQuestions.map((qq) => qq.image_path).filter((p) => p && !stillUsed.has(p)))];
    return { gradebookChanged, removedImages };
  });
}

/**
 * PATCH /quiz-answers/:answerId: the teacher's points for one answer (null
 * clears the override, back to the machine's) and note. Once nothing is
 * left to grade by hand, the student's score is the quiz total (live on a
 * published column, D17; else a draft).
 * @returns {Promise<{ answer, totals, wroteLive }>}
 */
async function overrideAnswer({ answerId, itemId, userId, teacherPoints, setNote, teacherNote }) {
  return inTransaction(async (client) => {
    const { rows: [locked] } = await client.query(q.lockItemShare, [itemId]);
    if (!locked) throw httpError(404, MESSAGES.ANSWER_NOT_FOUND);
    const item = await loadQuizItem(client, itemId);
    let isPublished = false;
    if (item.assessment_id) {
      // FOR UPDATE (see submitQuiz): a Grades publish waits for the override.
      const { rows: [a] } = await client.query(gradingQ.lockAssessmentUpdate, [item.assessment_id]);
      isPublished = Boolean(a?.is_published);
    }
    const { rows: [target] } = await client.query(q.selectAnswerTarget, [answerId]);
    if (!target || target.item_id !== itemId) throw httpError(404, MESSAGES.ANSWER_NOT_FOUND);
    const { rows: [attempt] } = await client.query(q.lockAttemptById, [target.attempt_id]);
    await client.query(q.lockAnswer, [answerId]);
    if (!attempt.submitted_at) throw httpError(409, MESSAGES.NOT_SUBMITTED);
    const max = Number(target.question_points);
    if (teacherPoints !== null && teacherPoints > max) throw httpError(400, MESSAGES.POINTS_RANGE(max));

    await client.query(q.setTeacherPoints, [answerId, teacherPoints, setNote, teacherNote, userId]);
    const [{ rows: questions }, { rows: answers }] = await Promise.all([
      client.query(q.selectQuestions, [itemId]),
      client.query(q.selectAttemptAnswers, [attempt.attempt_id]),
    ]);
    const totals = scoring.attemptTotals(questions, answers);
    const { live: wroteLive } = await writeScore(client, {
      item, studentId: attempt.student_id, isPublished, earned: totals.needsReview ? null : totals.earned, mode: 'override', userId,
    });
    const scoreSetByTeacher = await scoreSetByTeacherOf(client, item, attempt.student_id);
    const answer = answers.find((a) => a.answer_id === answerId);
    const question = questions.find((qq) => qq.question_id === answer.question_id);
    return { answer: toTeacherAnswer(question, answer), totals, wroteLive, scoreSetByTeacher };
  });
}

/** Whether a teacher's typed score holds the student's quiz score (only with a gradebook column). */
async function scoreSetByTeacherOf(runner, item, studentId) {
  if (!item.assessment_id) return false;
  const { rows: [r] } = await runner.query(q.selectScoreSetByTeacher, [item.item_id, studentId]);
  return Boolean(r?.score_set_by_teacher);
}

/**
 * POST …/submissions/:studentId/quiz-score: back to the quiz's own score.
 * The teacher's typed score stops winning, and the quiz total applies now
 * (live on a published column, D17, as an override; else a draft). Needs a
 * turned-in attempt with nothing left to grade by hand.
 * @returns {Promise<{ wroteLive: boolean }>}
 */
async function useQuizScore({ itemId, studentId, userId }) {
  return inTransaction(async (client) => {
    const { rows: [locked] } = await client.query(q.lockItemShare, [itemId]);
    if (!locked) throw httpError(404, MESSAGES.ITEM_NOT_FOUND);
    const item = await loadQuizItem(client, itemId);
    if (!item.assessment_id) throw httpError(400, MESSAGES.NO_COLUMN);
    const { rows: [a] } = await client.query(gradingQ.lockAssessmentUpdate, [item.assessment_id]);
    const isPublished = Boolean(a?.is_published);
    const { rows: [inAudience] } = await client.query(gradingQ.selectAudienceIds, [itemId, [studentId]]);
    if (!inAudience) throw httpError(404, MESSAGES.STUDENT_NOT_FOUND);
    const { rows: [attempt] } = await client.query(q.lockAttempt, [itemId, studentId]);
    if (!attempt?.submitted_at) throw httpError(409, MESSAGES.NOT_SUBMITTED);
    const [{ rows: questions }, { rows: answers }] = await Promise.all([
      client.query(q.selectQuestions, [itemId]),
      client.query(q.selectAttemptAnswers, [attempt.attempt_id]),
    ]);
    const totals = scoring.attemptTotals(questions, answers);
    if (totals.needsReview) throw httpError(409, MESSAGES.STILL_TO_GRADE);
    await client.query(gradingQ.ensureSubmission, [itemId, studentId]);
    await client.query(gradingQ.lockSubmission, [itemId, studentId]);
    await client.query(q.clearTeacherScore, [itemId, studentId]);
    const { live } = await writeScore(client, { item, studentId, isPublished, earned: totals.earned, mode: 'override', userId });
    return { wroteLive: live };
  });
}

/**
 * The quiz's own score for one student: { earned, needsReview } of their
 * turned-in attempt, or null (not turned in). Un-excuse restores it (fix
 * round 2) rather than the score from before the excuse.
 */
async function quizTotalFor(runner, itemId, studentId) {
  const { rows: [attempt] } = await runner.query(q.selectAttempt, [itemId, studentId]);
  if (!attempt?.submitted_at) return null;
  const [{ rows: questions }, { rows: answers }] = await Promise.all([
    runner.query(q.selectQuestions, [itemId]),
    runner.query(q.selectAttemptAnswers, [attempt.attempt_id]),
  ]);
  const { earned, needsReview } = scoring.attemptTotals(questions, answers);
  return { earned, needsReview };
}

/** The grading detail's quiz block for one student, or null when they haven't started. */
async function loadQuizDetail(itemId, studentId, runner = db) {
  const { rows: [attempt] } = await runner.query(q.selectAttempt, [itemId, studentId]);
  if (!attempt) return null;
  const [{ rows: questions }, { rows: answers }] = await Promise.all([
    runner.query(q.selectQuestions, [itemId]),
    runner.query(q.selectAttemptAnswers, [attempt.attempt_id]),
  ]);
  const byQ = new Map(answers.map((a) => [a.question_id, a]));
  const totals = scoring.attemptTotals(questions, answers);
  const { rows: [item] } = await runner.query(q.selectQuizItem, [itemId]);
  return {
    attemptId: attempt.attempt_id,
    submittedAt: iso(attempt.submitted_at),
    earned: totals.earned,
    possible: totals.possible,
    needsReview: totals.needsReview,
    // A typed score holds the gradebook cell; `earned` is still the quiz's own total.
    scoreSetByTeacher: item ? await scoreSetByTeacherOf(runner, item, studentId) : false,
    answers: orderQuestions(questions, attempt.question_order).map((qq) => toTeacherAnswer(qq, byQ.get(qq.question_id))),
  };
}

// ── The student's attempt ─────────────────────────────────────────────────

/** The item the student can see (ITEM_VISIBLE, their own row), as a quiz; else an httpError. */
async function loadStudentQuiz(runner, { studentId, school, itemId }) {
  const { rows: [row] } = await runner.query(workQ.selectStudentItem, [studentId, school, itemId]);
  if (!row) throw httpError(404, MESSAGES.ITEM_NOT_FOUND);
  if (row.kind !== 'quiz') throw httpError(400, MESSAGES.STUDENT_NOT_A_QUIZ);
  const { rows: [quiz] } = await runner.query(q.selectQuizItem, [itemId]);
  if (!quiz) throw httpError(404, MESSAGES.ITEM_NOT_FOUND);
  return { row, quiz };
}

/** The 409s for an answer or a submit: turned in, closed, excused or already graded. */
function assertOpen(row, attempt) {
  if (attempt?.submitted_at) throw httpError(409, MESSAGES.SUBMITTED, 'ALREADY_SUBMITTED');
  if (row.closed) throw httpError(409, MESSAGES.CLOSED, 'ITEM_CLOSED');
  if (row.work_status === 'excused') throw httpError(409, MESSAGES.EXCUSED, 'ITEM_CLOSED');
  if (row.work_status === 'graded') throw httpError(409, MESSAGES.GRADED, 'ITEM_CLOSED');
}

/**
 * The student's one attempt, locked; created on first use (with its shuffled
 * order when the quiz shuffles, and the submission opened), only while the
 * quiz is open and has questions. Inside the caller's transaction, after the
 * item lock.
 */
async function ensureAttempt(client, { row, quiz, studentId }) {
  const itemId = row.item_id;
  const { rows: [found] } = await client.query(q.lockAttempt, [itemId, studentId]);
  if (found) return found;
  assertOpen(row, null);
  const { rows: questions } = await client.query(q.selectStudentQuestions, [itemId]);
  if (!questions.length) throw httpError(409, MESSAGES.NO_QUESTIONS);
  const order = quiz.quiz_shuffle ? shuffled(questions.map((qq) => qq.question_id)) : [];
  await client.query(q.insertAttempt, [itemId, studentId, order]);
  await client.query(workQ.openSubmission, [itemId, studentId]);
  const { rows: [attempt] } = await client.query(q.lockAttempt, [itemId, studentId]);
  return attempt;
}

/**
 * Results (score, per-question points, the key) are released only by a
 * Publish for this student AFTER the attempt was turned in (controller
 * ruling, fix round 1): whatever was published before it (feedback, a
 * confirmed Missing) never releases them. An on-submit release is such a
 * Publish (publishSubmissions in the submit's transaction). With a column,
 * the grade must be visible too (spec 0.8): unpublished in Grades, hidden.
 * `released` is selectRelease's, compared in SQL.
 */
function resultsVisible(row, release) {
  if (!release?.released) return false;
  if (row.assessment_id) return Boolean(row.grade_visible) && row.grade_status === 'graded';
  return true;
}

/**
 * StudentQuiz for the caller's own row. Questions in the attempt's order,
 * with no answer key; results only once visible, the key in them only when
 * the teacher shows answers.
 */
async function buildStudentQuiz({ studentId, school, itemId }, runner = db) {
  const { row, quiz } = await loadStudentQuiz(runner, { studentId, school, itemId });
  const [{ rows: questions }, { rows: [attempt] }] = await Promise.all([
    runner.query(q.selectStudentQuestions, [itemId]),
    runner.query(q.selectAttempt, [itemId, studentId]),
  ]);
  const [answers, release] = attempt ? await Promise.all([
    runner.query(q.selectAttemptAnswers, [attempt.attempt_id]).then((r) => r.rows),
    runner.query(q.selectRelease, [itemId, studentId]).then((r) => r.rows[0]),
  ]) : [[], null];
  const ordered = orderQuestions(questions, attempt?.question_order);
  const urls = await imageUrls(ordered);
  const w = toWork(row);

  let results = null;
  if (resultsVisible(row, release)) {
    const totals = scoring.attemptTotals(questions, answers);
    const byQ = new Map(answers.map((a) => [a.question_id, a]));
    const key = quiz.quiz_show_answers
      ? new Map((await runner.query(q.selectQuestions, [itemId])).rows.map((k) => [k.question_id, k]))
      : null;
    const setByTeacher = Boolean(row.assessment_id && release.score_set_by_teacher);
    results = {
      earned: totals.earned,
      possible: totals.possible,
      // The score that counts (the published grade; with no column, the
      // quiz's total), and whether the teacher set it by hand.
      score: row.assessment_id ? num(row.grade_score) : totals.earned,
      scoreSetByTeacher: setByTeacher,
      perQuestion: ordered.map((qq) => {
        const a = byQ.get(qq.question_id);
        const out = { questionId: qq.question_id, points: a ? scoring.effectivePoints(a) : null, note: a?.teacher_note ?? null };
        const k = key?.get(qq.question_id);
        if (k && qq.kind !== 'long') out.correct = qq.kind === 'short' ? (k.accepted || []) : (k.correct || []);
        return out;
      }),
    };
  }

  return {
    quiz: {
      itemId,
      title: w.title,
      subject: w.subject,
      teacher: w.teacher,
      totalPoints: totalPointsOf(questions),
      questionCount: questions.length,
      dueAt: w.dueAt,
      release: quiz.quiz_release,
      attemptsAllowed: 1,
    },
    attempt: attempt ? {
      attemptId: attempt.attempt_id,
      startedAt: iso(attempt.started_at),
      submittedAt: iso(attempt.submitted_at),
      answers: Object.fromEntries(answers.filter((a) => a.answer !== null).map((a) => [a.question_id, a.answer])),
    } : null,
    questions: ordered.map((qq) => ({
      questionId: qq.question_id,
      kind: qq.kind,
      prompt: qq.prompt,
      imageUrl: qq.image_path ? urls.get(qq.image_path) ?? null : null,
      options: toOptions(qq.options),
      points: Number(qq.points),
      hint: HINTS[qq.kind] ?? null,
    })),
    results,
  };
}

/** POST …/quiz/start: the attempt, created once. */
async function startQuiz({ studentId, school, itemId }) {
  await inTransaction(async (client) => {
    await client.query(q.lockItemShare, [itemId]);
    const { row, quiz } = await loadStudentQuiz(client, { studentId, school, itemId });
    const { rows: [found] } = await client.query(q.selectAttempt, [itemId, studentId]);
    if (!found) await ensureAttempt(client, { row, quiz, studentId });
  });
  return buildStudentQuiz({ studentId, school, itemId });
}

/** A PUT …/quiz-answers body → [{ questionId, answer }], or an httpError. */
function parseAnswersBody(body) {
  const list = body?.answers;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ANSWERS_PER_SAVE) {
    throw httpError(400, `Send 1 to ${MAX_ANSWERS_PER_SAVE} answers`);
  }
  const seen = new Set();
  return list.map((a) => {
    if (!isObject(a) || typeof a.questionId !== 'string' || !UUID_RE.test(a.questionId)) throw httpError(400, MESSAGES.BAD_ANSWER);
    const questionId = a.questionId.toLowerCase();
    if (seen.has(questionId)) throw httpError(400, MESSAGES.BAD_ANSWER);
    seen.add(questionId);
    return { questionId, answer: a.answer === undefined ? null : a.answer };
  });
}

/** One answer, checked against its question's type and choices: the stored JSON (null clears). */
function normalizeAnswer(question, raw) {
  if (raw === null) return null;
  if (!isObject(raw)) throw httpError(400, MESSAGES.BAD_ANSWER);
  const ids = toOptions(question.options).map((o) => o.id);
  switch (question.kind) {
    case 'one':
      if (raw.choice === null || raw.choice === undefined) return null;
      if (typeof raw.choice !== 'string' || !ids.includes(raw.choice)) throw httpError(400, MESSAGES.BAD_ANSWER);
      return { choice: raw.choice };
    case 'many': {
      const picked = raw.choices;
      if (!Array.isArray(picked) || picked.some((c) => typeof c !== 'string' || !ids.includes(c)) || new Set(picked).size !== picked.length) {
        throw httpError(400, MESSAGES.BAD_ANSWER);
      }
      return { choices: ids.filter((id) => picked.includes(id)) };
    }
    case 'short':
    case 'long': {
      if (raw.text === null || raw.text === undefined) return null;
      if (typeof raw.text !== 'string') throw httpError(400, MESSAGES.BAD_ANSWER);
      if (question.kind === 'short' && raw.text.length > SHORT_ANSWER_MAX) throw httpError(400, MESSAGES.SHORT_TOO_LONG);
      if (question.kind === 'long' && raw.text.length > LONG_ANSWER_MAX) throw httpError(400, MESSAGES.LONG_TOO_LONG);
      return { text: raw.text };
    }
    default:
      throw httpError(400, MESSAGES.BAD_ANSWER);
  }
}

/** PUT …/quiz-answers: autosave, while the attempt is open. @returns {{ savedAt }} */
async function saveAnswers({ studentId, school, itemId, answers }) {
  return inTransaction(async (client) => {
    await client.query(q.lockItemShare, [itemId]);
    const { row, quiz } = await loadStudentQuiz(client, { studentId, school, itemId });
    const attempt = await ensureAttempt(client, { row, quiz, studentId });
    assertOpen(row, attempt);
    // The key stays in the server: only the type and choice ids are read.
    const { rows: questions } = await client.query(q.selectStudentQuestions, [itemId]);
    const byId = new Map(questions.map((qq) => [qq.question_id, qq]));
    if (answers.some((a) => !byId.has(a.questionId))) throw httpError(400, MESSAGES.UNKNOWN_QUESTION);
    const values = answers.map((a) => normalizeAnswer(byId.get(a.questionId), a.answer));
    const { rows } = await client.query(q.saveAnswers, [
      attempt.attempt_id, answers.map((a) => a.questionId), values.map((v) => (v === null ? null : JSON.stringify(v))),
    ]);
    return { savedAt: iso(rows[0]?.saved_at ?? new Date()) };
  });
}

/**
 * POST …/quiz-submit: every question gets an answer row (blank if skipped),
 * auto points are computed, the attempt and the submission are turned in
 * (late past the due time). The score is a draft (null while a written
 * answer waits for the teacher). Released "on submit", it is published for
 * this student at once through publishSubmissions (unless the column's
 * first per-student Publish is refused: then it stays a draft).
 * @returns {Promise<{ item, published }>} for the caller's after-COMMIT work
 */
async function submitQuiz({ studentId, school, itemId }) {
  return inTransaction(async (client) => {
    // The item first (the lock order), so the item and its settings read
    // below can't change under the submit.
    await client.query(q.lockItemShare, [itemId]);
    const { row, quiz } = await loadStudentQuiz(client, { studentId, school, itemId });
    const onSubmit = quiz.quiz_release === 'on_submit';
    let isPublished = false;
    if (quiz.assessment_id) {
      // FOR UPDATE, not SHARE: publishing needs it, and a Grades publish of
      // the column (SHARE, then the submissions, then the column) then waits
      // for the submit instead of deadlocking on the submission.
      const { rows: [a] } = await client.query(gradingQ.lockAssessmentUpdate, [quiz.assessment_id]);
      isPublished = Boolean(a?.is_published);
    }
    const attempt = await ensureAttempt(client, { row, quiz, studentId });
    assertOpen(row, attempt);

    const { rows: questions } = await client.query(q.selectQuestions, [itemId]);
    if (!questions.length) throw httpError(409, MESSAGES.NO_QUESTIONS);
    let { rows: answers } = await client.query(q.selectAttemptAnswers, [attempt.attempt_id]);
    const answered = new Set(answers.map((a) => a.question_id));
    const blank = questions.map((qq) => qq.question_id).filter((id) => !answered.has(id));
    if (blank.length) {
      await client.query(q.insertBlankAnswers, [attempt.attempt_id, blank]);
      ({ rows: answers } = await client.query(q.selectAttemptAnswers, [attempt.attempt_id]));
    }
    const scored = await scoreAnswers(client, questions, answers);
    const totals = scoring.attemptTotals(questions, scored);
    await client.query(q.markSubmitted, [attempt.attempt_id, autoScoreOf(scored)]);

    await client.query(workQ.ensureSubmission, [itemId, studentId]);
    const { rows: [sub] } = await client.query(workQ.lockSubmission, [itemId, studentId]);
    await client.query(workQ.turnIn, [sub.submission_id]);
    // The attempt is new work: nothing published before it releases it (I1).
    await client.query(q.unpublishSubmission, [sub.submission_id]);
    const quizScore = await writeScore(client, {
      item: quiz, studentId, isPublished, earned: totals.needsReview ? null : totals.earned, mode: 'submit',
    });

    let published = { publishedStudentIds: [], assessmentPublished: false, batchId: null };
    // Released on submit: published at once, unless a teacher's typed score
    // holds the cell (that stays theirs to publish).
    if (onSubmit && !totals.needsReview && (!quiz.assessment_id || quizScore.wrote)) {
      const item = { item_id: itemId, class_id: quiz.class_id, assessment_id: quiz.assessment_id, is_published: isPublished };
      try {
        published = await publishSubmissions(client, { item, studentIds: [studentId], userId: null, school });
        published.batchId = await ensurePublishBatch(client, { item, school, userId: null, published });
      } catch (error) {
        if (error.code !== 'OUTSIDE_AUDIENCE_GRADES') throw error;
        // The column holds grades of students the quiz isn't for: it must be
        // published in Grades first. The score waits as a draft.
        logger.info({ itemId }, 'Quiz released on submit stays a draft: the column must be published in Grades first');
      }
    }
    return { item: quiz, published };
  });
}

module.exports = {
  imagePrefixOf,
  loadQuizItem,
  loadBuilder,
  saveQuestions,
  overrideAnswer,
  useQuizScore,
  quizTotalFor,
  loadQuizDetail,
  buildStudentQuiz,
  startQuiz,
  parseAnswersBody,
  saveAnswers,
  submitQuiz,
};
