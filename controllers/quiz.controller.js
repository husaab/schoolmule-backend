/*
  controllers/quiz.controller.js
  Quizzes (T23). Teacher routes (/api/classroom, staff only) run
  requireClassroomResource('item') or ('quizAnswer'); student routes
  (/api/student) run requireStudent and key every read and write on the
  caller's own req.student.studentId, never on an id from the client. The
  flows live in services/classroom/quizzes.js.
*/

const crypto = require('crypto');
const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const engine = require('../services/analyticsEngine');
const quizzes = require('../services/classroom/quizzes');
const { afterPublish } = require('../services/classroom/publish');
const { sendGradeDigest } = require('./assessmentPublish.controller');
const { BUCKET, signedUrlMap, removeObjects } = require('../utils/attachmentUpload');

const NOTE_MAX = 2000;

const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });
const has = (body, key) => Boolean(body) && Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

/** A service error (httpError, maybe with a code) answers as itself; anything else is logged as a 500. */
function fail(res, error, userMessage, context) {
  if (error && error.expose && error.status) {
    return res.status(error.status).json({ status: 'failed', message: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  logger.error({ err: error, ...context }, userMessage);
  return failed(res, 500, userMessage);
}

// ── The teacher's builder ─────────────────────────────────────────────────

// GET /api/classroom/items/:itemId/questions
// → { questions, settings: { release, shuffle, showAnswers }, hasSubmissions, totalPoints }
const getQuestions = async (req, res) => {
  try {
    return ok(res, await quizzes.loadBuilder(req.item.itemId));
  } catch (error) {
    return fail(res, error, 'Error loading the questions', { itemId: req.item.itemId });
  }
};

// PUT /api/classroom/items/:itemId/questions  { questions: QuestionInput[] }
// Upsert by questionId, delete the rest (409 once a student turned it in);
// the column's "out of" follows; an answer-key change regrades.
const putQuestions = async (req, res) => {
  const { itemId } = req.item;
  const { school } = req.class;
  if (!req.body || !Array.isArray(req.body.questions)) return failed(res, 400, 'Send the questions as a list');
  try {
    const { gradebookChanged, removedImages } = await quizzes.saveQuestions({
      itemId, school, userId: req.user.userId, input: req.body.questions,
    });
    if (gradebookChanged) engine.invalidateCache(school);
    await removeObjects(removedImages);
    return ok(res, await quizzes.loadBuilder(itemId));
  } catch (error) {
    return fail(res, error, 'Error saving the questions', { itemId });
  }
};

// POST /api/classroom/items/:itemId/question-images  multipart "image" (JPEG, PNG, WebP ≤ 3 MB)
// → { imagePath, url }: stored under the quiz's folder; a question points at it on the next PUT.
const uploadQuestionImage = async (req, res) => {
  const { itemId } = req.item;
  const { school } = req.class;
  try {
    await quizzes.loadQuizItem(db, itemId); // 400 when the item isn't a quiz
    const imagePath = `${quizzes.imagePrefixOf(school, itemId)}${crypto.randomUUID()}.${req.image.ext}`;
    const { error } = await supabase.storage.from(BUCKET).upload(imagePath, req.image.buffer, { contentType: req.image.contentType, upsert: false });
    if (error) throw new Error(`Upload failed: ${error.message}`);
    const urls = await signedUrlMap([imagePath]);
    return ok(res, { imagePath, url: urls.get(imagePath) ?? null }, 201);
  } catch (error) {
    return fail(res, error, 'Error uploading the image', { itemId });
  }
};

/** The PATCH body: teacherPoints (0 or more, or null) and an optional note. */
function parseOverride(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !has(body, 'teacherPoints')) {
    return { error: 'Send teacherPoints (a number, or null to use the automatic points)' };
  }
  const p = body.teacherPoints;
  if (p !== null && (typeof p !== 'number' || !Number.isFinite(p) || p < 0)) return { error: 'Points must be 0 or more' };
  let note = null;
  if (has(body, 'teacherNote') && body.teacherNote !== null) {
    if (typeof body.teacherNote !== 'string') return { error: 'teacherNote must be text' };
    note = body.teacherNote.trim() || null;
    if (note && note.length > NOTE_MAX) return { error: `Keep the note to ${NOTE_MAX.toLocaleString('en-US')} characters` };
  }
  return { value: { teacherPoints: p === null ? null : Math.round(p * 100) / 100, setNote: has(body, 'teacherNote'), teacherNote: note } };
}

// PATCH /api/classroom/quiz-answers/:answerId  { teacherPoints: number | null, teacherNote? }
// → { answer, totals: { earned, possible, needsReview }, scoreSetByTeacher }
// (scoreSetByTeacher: a typed score holds the student's grade, so the new
// total did not replace it; POST …/submissions/:studentId/quiz-score does).
const updateQuizAnswer = async (req, res) => {
  const { answerId, itemId } = req.quizAnswer;
  const { school } = req.class;
  const parsed = parseOverride(req.body);
  if (parsed.error) return failed(res, 400, parsed.error);
  try {
    const { answer, totals, wroteLive, scoreSetByTeacher } = await quizzes.overrideAnswer({
      answerId, itemId, userId: req.user.userId, ...parsed.value,
    });
    if (wroteLive) engine.invalidateCache(school);
    return ok(res, { answer, totals, scoreSetByTeacher });
  } catch (error) {
    return fail(res, error, 'Error saving the points', { answerId });
  }
};

// ── The student's attempt ─────────────────────────────────────────────────

const mine = (req) => ({ studentId: req.student.studentId, school: req.user.school, itemId: req.params.itemId.toLowerCase() });

// GET /api/student/items/:itemId/quiz → StudentQuiz
const getStudentQuiz = async (req, res) => {
  try {
    return ok(res, await quizzes.buildStudentQuiz(mine(req)));
  } catch (error) {
    return fail(res, error, 'Error loading the quiz', { itemId: req.params.itemId });
  }
};

// POST /api/student/items/:itemId/quiz/start → StudentQuiz (idempotent)
const startStudentQuiz = async (req, res) => {
  try {
    return ok(res, await quizzes.startQuiz(mine(req)));
  } catch (error) {
    return fail(res, error, 'Error starting the quiz', { itemId: req.params.itemId });
  }
};

// PUT /api/student/items/:itemId/quiz-answers  { answers: [{ questionId, answer }] } → { savedAt }
const saveStudentAnswers = async (req, res) => {
  try {
    const answers = quizzes.parseAnswersBody(req.body);
    return ok(res, await quizzes.saveAnswers({ ...mine(req), answers }));
  } catch (error) {
    return fail(res, error, 'Error saving your answers', { itemId: req.params.itemId });
  }
};

// POST /api/student/items/:itemId/quiz-submit → StudentQuiz
// Released on submit: published for this student at once, and after COMMIT
// the same bookkeeping and emails as any Publish (the student's graded
// email, the parents' publish digest).
const submitStudentQuiz = async (req, res) => {
  const p = mine(req);
  try {
    const { item, published } = await quizzes.submitQuiz(p);
    if (published.publishedStudentIds.length > 0) {
      await afterPublish({ school: p.school, studentIds: published.publishedStudentIds, itemId: p.itemId });
      if (item.assessment_id) {
        await sendGradeDigest({
          classId: item.class_id, school: p.school, userId: item.release_by ?? null, batchId: published.batchId,
          assessmentIds: [item.assessment_id], studentIds: published.publishedStudentIds,
        });
      }
    }
    return ok(res, await quizzes.buildStudentQuiz(p));
  } catch (error) {
    return fail(res, error, 'Error turning in your quiz', { itemId: req.params.itemId });
  }
};

module.exports = {
  getQuestions, putQuestions, uploadQuestionImage, updateQuizAnswer,
  getStudentQuiz, startStudentQuiz, saveStudentAnswers, submitStudentQuiz,
};
