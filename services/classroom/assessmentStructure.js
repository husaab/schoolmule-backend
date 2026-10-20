// services/classroom/assessmentStructure.js
//
// Regrouping gradebook columns from Grades → Assessments & categories: move a
// column into a category, between categories or back out on its own, and turn
// a single assessment into a category (a "multiple assessment") that holds it.
// A column keeps its own points wherever it goes; the categories it leaves and
// joins give up or take on exactly those points, so the class stays at 100
// and a fully scored student's grade does not change. The column keeps its
// id, so its scores, publish state, Classwork row and message threads come
// with it. (Classwork's own "Counts toward" is different: a new column there
// shares its category's fixed points, services/classroom/weights.js.)

const q = require('../../queries/classwork.queries');
const assessmentQueries = require('../../queries/assessment.queries');
const { round2 } = require('./weights');
const { httpError } = require('./classworkItems');

const CATEGORY_MOVE_MESSAGE = "A category can't move. Move the assessments inside it one at a time.";
const NOT_A_CATEGORY_MESSAGE = "Choose one of this class's categories.";
const MAKE_CATEGORY_MESSAGE = 'Only an assessment that counts on its own can become a multiple assessment.';
const NOT_FOUND_MESSAGE = 'That assessment is not in this class.';
const CHANGED_MESSAGE = 'This assessment just changed. Reload the page and try again.';

const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

async function one(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0] ?? null;
}

async function lockColumn(client, classId, assessmentId) {
  const col = await one(client, q.lockColumnInClass, [assessmentId, classId]);
  if (!col) throw httpError(404, NOT_FOUND_MESSAGE);
  return col;
}

const nextSortOrder = (children) => children.reduce((m, c) => Math.max(m, Number(c.sort_order || 0)), 0) + 1;

/**
 * Moves a column into a category (categoryId), or out on its own (null). A
 * category left with nothing in it is removed, and a column coming out takes
 * its old category's place in the list. Returns whether anything changed.
 */
async function moveAssessment(client, { classId, assessmentId, categoryId }) {
  // Categories are locked before the column, in id order, as Classwork's
  // writers lock them (category, then its columns), so the two never deadlock.
  const seen = await one(client, q.selectColumnInClass, [assessmentId, classId]);
  if (!seen) throw httpError(404, NOT_FOUND_MESSAGE);
  if (seen.is_parent) throw httpError(400, CATEGORY_MOVE_MESSAGE);
  const from = lower(seen.parent_assessment_id) || null;
  const to = lower(categoryId) || null;
  if (from === to) return { changed: false };

  await client.query(q.lockCategoriesInOrder, [[from, to].filter(Boolean).sort()]);
  const col = await lockColumn(client, classId, assessmentId);
  if ((lower(col.parent_assessment_id) || null) !== from) throw httpError(409, CHANGED_MESSAGE);
  const points = Number(col.weight_points || 0);
  let sortOrder = col.sort_order;
  if (to) {
    const target = await one(client, q.lockCategory, [to, classId]);
    if (!target) throw httpError(400, NOT_A_CATEGORY_MESSAGE);
    sortOrder = nextSortOrder((await client.query(q.lockChildren, [to])).rows);
    await client.query(q.updateAssessmentWeight, [round2(Number(target.weight_points || 0) + points), to]);
  }
  let emptied = false;
  if (from) {
    const source = await one(client, q.lockCategory, [from, classId]);
    const others = (await client.query(q.lockChildren, [from])).rows.filter((c) => lower(c.assessment_id) !== lower(assessmentId));
    emptied = others.length === 0;
    if (!to) sortOrder = source?.sort_order ?? sortOrder;
    if (source && !emptied) {
      await client.query(q.updateAssessmentWeight, [round2(Math.max(0, Number(source.weight_points || 0) - points)), from]);
    }
  }
  await client.query(q.reparentAssessment, [assessmentId, to, points, sortOrder]);
  // Only after the column is out: deleting a category cascades to what is still in it.
  if (emptied) await client.query(q.deleteAssessment, [from]);
  return { changed: true };
}

/**
 * Turns a single assessment into a category holding it: a new category takes
 * its name, points, date and place in the list, and the column becomes the
 * category's first item. Returns the new category's id.
 */
async function makeCategory(client, { classId, assessmentId }) {
  const col = await lockColumn(client, classId, assessmentId);
  if (col.is_parent || col.parent_assessment_id) throw httpError(400, MAKE_CATEGORY_MESSAGE);
  const { rows } = await client.query(assessmentQueries.createAssessment, [
    classId, col.name, null, null, true, col.sort_order, null, col.weight_points, col.date]);
  const categoryId = rows[0].assessment_id;
  await client.query(q.reparentAssessment, [assessmentId, categoryId, col.weight_points, 1]);
  return { categoryId };
}

/** The shape every assessment route answers with (assessment.controller.js). */
const toAssessmentPayload = (a) => ({
  assessmentId: a.assessment_id,
  classId: a.class_id,
  name: a.name,
  weightPercent: a.weight_percent == null ? null : parseFloat(a.weight_percent),
  createdAt: a.created_at,
  lastModifiedAt: a.last_modified_at,
  parentAssessmentId: a.parent_assessment_id || null,
  isParent: a.is_parent === true,
  sortOrder: a.sort_order,
  maxScore: a.max_score == null ? null : Number(a.max_score),
  weightPoints: a.weight_points == null ? null : Number(a.weight_points),
  date: a.date,
});

async function listClassAssessments(client, classId) {
  const { rows } = await client.query(assessmentQueries.selectAssessmentsByClass, [classId]);
  return rows.map(toAssessmentPayload);
}

module.exports = {
  CATEGORY_MOVE_MESSAGE, NOT_A_CATEGORY_MESSAGE, MAKE_CATEGORY_MESSAGE, NOT_FOUND_MESSAGE, CHANGED_MESSAGE,
  moveAssessment, makeCategory, listClassAssessments, toAssessmentPayload,
};
