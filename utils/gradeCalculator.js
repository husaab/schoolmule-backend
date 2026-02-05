/**
 * Grade calculation utility matching frontend logic exactly
 * Reference: schoolmule/src/app/(user)/gradebook/[classId]/page.tsx:348-421
 *
 * This utility provides consistent grade calculations across:
 * - Excel export (studentAssessment.controller.js)
 * - Report generation (reports.controller.js)
 * - Any future grade-related features
 */

/**
 * Calculate weighted grade for a student, handling:
 * - Exclusions (is_excluded flag)
 * - Parent/child assessment hierarchy
 * - Raw score to percentage conversion (rawScore / maxScore * 100)
 * - Weight scaling when totalActiveWeight < 100%
 *
 * @param {Array} assessments - All assessments with fields:
 *   - assessment_id, name, weight_points, weight_percent, max_score
 *   - is_parent, parent_assessment_id
 * @param {Array} studentScores - Student's scores with fields:
 *   - assessment_id, score, is_excluded
 * @returns {number} Final grade percentage (0-100)
 */
function calculateStudentGrade(assessments, studentScores) {
  // Build score lookup for quick access
  const scoreLookup = {};
  studentScores.forEach(score => {
    scoreLookup[score.assessment_id] = {
      score: score.score !== null && score.score !== undefined ? parseFloat(score.score) : null,
      isExcluded: Boolean(score.is_excluded)
    };
  });

  // Filter to only top-level assessments (parent + standalone, not children)
  const displayedAssessments = assessments.filter(a => !a.parent_assessment_id);

  let total = 0;
  let totalActiveWeight = 0;

  displayedAssessments.forEach(assessment => {
    const assessmentId = assessment.assessment_id;
    const scoreData = scoreLookup[assessmentId];
    const isExcluded = scoreData?.isExcluded || false;

    // Skip excluded assessments entirely
    if (isExcluded) {
      return;
    }

    // Get assessment weight (weight_points only)
    const assessmentWeight = parseFloat(assessment.weight_points) || 0;
    totalActiveWeight += assessmentWeight;

    let scoreToUse = 0;

    if (assessment.is_parent) {
      // Parent assessment: Calculate score from children
      scoreToUse = calculateParentScore(assessments, assessment, scoreLookup);
    } else {
      // Standalone assessment: Convert raw score to percentage
      scoreToUse = calculateStandaloneScore(assessment, scoreData);
    }

    // Add weighted contribution to total
    total += (scoreToUse * assessmentWeight) / 100;
  });

  // Handle edge cases for excluded assessments
  if (totalActiveWeight === 0) {
    return 0; // All assessments excluded or no assessments
  }

  // Scale up if total active weight < 100% (some assessments excluded)
  if (totalActiveWeight < 100) {
    total = (total / totalActiveWeight) * 100;
  }

  return total;
}

/**
 * Calculate score for a parent assessment by aggregating child scores
 * Matches frontend logic exactly
 */
function calculateParentScore(assessments, parentAssessment, scoreLookup) {
  // Find all children of this parent
  const childAssessments = assessments.filter(
    a => a.parent_assessment_id === parentAssessment.assessment_id
  );

  if (childAssessments.length === 0) {
    return 0;
  }

  let totalPoints = 0;
  let maxPossiblePoints = 0;

  childAssessments.forEach(child => {
    const childScoreData = scoreLookup[child.assessment_id];
    const isChildExcluded = childScoreData?.isExcluded || false;

    // Skip excluded children
    if (isChildExcluded) {
      return;
    }

    // Get raw score (null/undefined treated as 0)
    const rawScore = childScoreData?.score ?? 0;
    const maxScore = parseFloat(child.max_score) || 100; // Safe NaN/null fallback
    const childWeight = parseFloat(child.weight_points) || 0;

    // Convert to percentage and multiply by child weight
    const percentage = maxScore > 0 ? Math.min(rawScore / maxScore, 1) : 0;
    const earnedPoints = percentage * childWeight;

    totalPoints += earnedPoints;
    maxPossiblePoints += childWeight;
  });

  // Return percentage of earned points
  return maxPossiblePoints > 0 ? (totalPoints / maxPossiblePoints) * 100 : 0;
}

/**
 * Calculate score for a standalone (non-parent) assessment
 * Converts raw score to percentage using maxScore
 */
function calculateStandaloneScore(assessment, scoreData) {
  const rawScore = scoreData?.score ?? 0;
  const maxScore = parseFloat(assessment.max_score) || 100; // Safe NaN/null fallback

  return maxScore > 0 ? (rawScore / maxScore) * 100 : 0;
}

/**
 * Calculate grades for all students in a class
 * More efficient than calling calculateStudentGrade for each student
 *
 * @param {Array} assessments - All assessments
 * @param {Array} allScoreRows - All score rows from database (includes student_id)
 * @returns {Map<string, number>} Map of studentId -> grade percentage
 */
function calculateBulkGrades(assessments, allScoreRows) {
  // Group scores by student
  const scoresByStudent = {};
  allScoreRows.forEach(row => {
    const studentId = row.student_id;
    if (!scoresByStudent[studentId]) {
      scoresByStudent[studentId] = [];
    }
    scoresByStudent[studentId].push({
      assessment_id: row.assessment_id,
      score: row.score,
      is_excluded: row.is_excluded
    });
  });

  // Calculate grade for each student
  const grades = new Map();
  Object.keys(scoresByStudent).forEach(studentId => {
    const studentScores = scoresByStudent[studentId];
    const grade = calculateStudentGrade(assessments, studentScores);
    grades.set(studentId, grade);
  });

  return grades;
}

/**
 * Get assessment breakdown for a student (useful for detailed reports)
 * Returns contribution of each assessment to the final grade
 *
 * @param {Array} assessments - All assessments
 * @param {Array} studentScores - Student's scores
 * @returns {Object} { total, totalActiveWeight, breakdown: { assessmentId: { score, weight, contribution } } }
 */
function getGradeBreakdown(assessments, studentScores) {
  const scoreLookup = {};
  studentScores.forEach(score => {
    scoreLookup[score.assessment_id] = {
      score: score.score !== null && score.score !== undefined ? parseFloat(score.score) : null,
      isExcluded: Boolean(score.is_excluded)
    };
  });

  const displayedAssessments = assessments.filter(a => !a.parent_assessment_id);

  let total = 0;
  let totalActiveWeight = 0;
  const breakdown = {};
  const excludedAssessments = [];

  displayedAssessments.forEach(assessment => {
    const assessmentId = assessment.assessment_id;
    const scoreData = scoreLookup[assessmentId];
    const isExcluded = scoreData?.isExcluded || false;

    if (isExcluded) {
      excludedAssessments.push(assessmentId);
      return;
    }

    const assessmentWeight = parseFloat(assessment.weight_points) || 0;
    totalActiveWeight += assessmentWeight;

    let scoreToUse = 0;
    if (assessment.is_parent) {
      scoreToUse = calculateParentScore(assessments, assessment, scoreLookup);
    } else {
      scoreToUse = calculateStandaloneScore(assessment, scoreData);
    }

    const contribution = (scoreToUse * assessmentWeight) / 100;
    total += contribution;

    breakdown[assessmentId] = {
      score: scoreToUse,
      weight: assessmentWeight,
      contribution
    };
  });

  // Scale if needed (when some assessments are excluded)
  let finalGrade = total;
  if (totalActiveWeight === 0) {
    finalGrade = 0; // No active assessments
  } else if (totalActiveWeight < 100) {
    finalGrade = (total / totalActiveWeight) * 100;
  }

  return {
    total: finalGrade,
    totalActiveWeight,
    breakdown,
    excludedAssessments
  };
}

module.exports = {
  calculateStudentGrade,
  calculateBulkGrades,
  getGradeBreakdown,
  // Export internal functions for testing
  calculateParentScore,
  calculateStandaloneScore
};
