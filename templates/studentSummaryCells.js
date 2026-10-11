// Shared cell rendering for the student summary templates (portrait and
// landscape). Both templates show the same text, percentage and letter badge
// for a cell; only the surrounding table markup differs.

const { computeAssessmentForStudent, cellState } = require('../services/gradeEngine');

/**
 * Get letter grade and color based on percentage
 * Uses Ontario grading scale
 */
function getLetterGrade(percentage) {
  if (percentage >= 90) return { letter: 'A+', color: '#10b981', bg: '#d1fae5' };
  if (percentage >= 85) return { letter: 'A', color: '#10b981', bg: '#d1fae5' };
  if (percentage >= 80) return { letter: 'A-', color: '#10b981', bg: '#d1fae5' };
  if (percentage >= 77) return { letter: 'B+', color: '#3b82f6', bg: '#dbeafe' };
  if (percentage >= 73) return { letter: 'B', color: '#3b82f6', bg: '#dbeafe' };
  if (percentage >= 70) return { letter: 'B-', color: '#3b82f6', bg: '#dbeafe' };
  if (percentage >= 67) return { letter: 'C+', color: '#f59e0b', bg: '#fef3c7' };
  if (percentage >= 63) return { letter: 'C', color: '#f59e0b', bg: '#fef3c7' };
  if (percentage >= 60) return { letter: 'C-', color: '#f59e0b', bg: '#fef3c7' };
  if (percentage >= 57) return { letter: 'D+', color: '#f97316', bg: '#ffedd5' };
  if (percentage >= 53) return { letter: 'D', color: '#f97316', bg: '#ffedd5' };
  if (percentage >= 50) return { letter: 'D-', color: '#f97316', bg: '#ffedd5' };
  return { letter: 'R', color: '#ef4444', bg: '#fee2e2' };
}

const STATE_LABEL = { blank: 'Not yet graded', missing: 'Missing', excused: 'Excused' };

function letterBadge(percentage) {
  const lg = getLetterGrade(percentage);
  return `<span class="letter-badge" style="background: ${lg.bg}; color: ${lg.color};">${lg.letter}</span>`;
}

/**
 * One leaf cell (standalone or child assessment).
 *   graded  -> "17/20" (or "88%" without a max), percentage, letter badge
 *   missing -> "Missing", 0%, letter badge for 0
 *   excused / blank -> label only
 * @returns {{ scoreDisplay: string, percentage: number|null, letterGradeHtml: string }}
 */
function renderLeafCell(assessment, studentScore) {
  const state = cellState(studentScore);
  if (state === 'missing') {
    return { scoreDisplay: STATE_LABEL.missing, percentage: 0, letterGradeHtml: letterBadge(0) };
  }
  if (state === 'graded') {
    const percentage = assessment.max_score
      ? (studentScore.score / assessment.max_score) * 100
      : studentScore.score;
    const scoreDisplay = assessment.max_score
      ? `${studentScore.score}/${assessment.max_score}`
      : `${studentScore.score}%`;
    return { scoreDisplay, percentage, letterGradeHtml: letterBadge(percentage) };
  }
  return { scoreDisplay: STATE_LABEL[state] || STATE_LABEL.blank, percentage: null, letterGradeHtml: '' };
}

/**
 * Category rollup cell via the shared engine (counted children only).
 * @returns {{ scoreDisplay: string, percentage: number|null, letterGradeHtml: string }}
 */
function renderParentCell(parent, assessments, scoreLookup) {
  const rollup = computeAssessmentForStudent(parent, assessments, scoreLookup);
  if (!rollup.isCounted) {
    const scoreDisplay = rollup.state === 'excused' ? STATE_LABEL.excused : STATE_LABEL.blank;
    return { scoreDisplay, percentage: null, letterGradeHtml: '' };
  }
  return {
    scoreDisplay: `${rollup.pct.toFixed(1)}%`,
    percentage: rollup.pct,
    letterGradeHtml: letterBadge(rollup.pct),
  };
}

module.exports = { getLetterGrade, renderLeafCell, renderParentCell };
