const {
  calculateStudentGrade,
  calculateBulkGrades,
  getGradeBreakdown,
  calculateParentScore,
  calculateStandaloneScore,
} = require('../../../utils/gradeCalculator');

describe('gradeCalculator', () => {
  describe('calculateStandaloneScore', () => {
    it('converts raw score to percentage', () => {
      const assessment = { max_score: 100 };
      const scoreData = { score: 85 };
      expect(calculateStandaloneScore(assessment, scoreData)).toBe(85);
    });

    it('handles max_score less than 100', () => {
      const assessment = { max_score: 50 };
      const scoreData = { score: 25 };
      expect(calculateStandaloneScore(assessment, scoreData)).toBe(50);
    });

    it('returns 0 when score is null', () => {
      const assessment = { max_score: 100 };
      const scoreData = { score: null };
      expect(calculateStandaloneScore(assessment, scoreData)).toBe(0);
    });

    it('returns 0 when scoreData is undefined', () => {
      const assessment = { max_score: 100 };
      expect(calculateStandaloneScore(assessment, undefined)).toBe(0);
    });

    it('falls back to max_score 100 when max_score is 0 (0 is falsy)', () => {
      const assessment = { max_score: 0 };
      const scoreData = { score: 10 };
      // 0 || 100 = 100 (falsy fallback), so 10/100 = 10%
      expect(calculateStandaloneScore(assessment, scoreData)).toBe(10);
    });

    it('falls back to max_score 100 when max_score is null', () => {
      const assessment = { max_score: null };
      const scoreData = { score: 75 };
      expect(calculateStandaloneScore(assessment, scoreData)).toBe(75);
    });
  });

  describe('calculateParentScore', () => {
    it('aggregates child assessment scores', () => {
      const parentId = 'parent-1';
      const assessments = [
        { assessment_id: parentId, is_parent: true, weight_points: 50 },
        { assessment_id: 'child-1', parent_assessment_id: parentId, max_score: 100, weight_points: 50 },
        { assessment_id: 'child-2', parent_assessment_id: parentId, max_score: 100, weight_points: 50 },
      ];
      const parent = assessments[0];
      const scoreLookup = {
        'child-1': { score: 80, isExcluded: false },
        'child-2': { score: 60, isExcluded: false },
      };

      const result = calculateParentScore(assessments, parent, scoreLookup);
      expect(result).toBe(70); // (80*50 + 60*50) / (50+50) = 70%
    });

    it('returns 0 when no children exist', () => {
      const assessments = [
        { assessment_id: 'parent-1', is_parent: true },
      ];
      const scoreLookup = {};

      const result = calculateParentScore(assessments, assessments[0], scoreLookup);
      expect(result).toBe(0);
    });

    it('skips excluded children', () => {
      const parentId = 'parent-1';
      const assessments = [
        { assessment_id: parentId, is_parent: true },
        { assessment_id: 'child-1', parent_assessment_id: parentId, max_score: 100, weight_points: 50 },
        { assessment_id: 'child-2', parent_assessment_id: parentId, max_score: 100, weight_points: 50 },
      ];
      const scoreLookup = {
        'child-1': { score: 80, isExcluded: false },
        'child-2': { score: 60, isExcluded: true },
      };

      const result = calculateParentScore(assessments, assessments[0], scoreLookup);
      expect(result).toBe(80); // Only child-1 counts
    });
  });

  describe('calculateStudentGrade', () => {
    it('calculates grade with standalone assessments', () => {
      const assessments = [
        { assessment_id: 'a1', weight_points: 50, max_score: 100, is_parent: false, parent_assessment_id: null },
        { assessment_id: 'a2', weight_points: 50, max_score: 100, is_parent: false, parent_assessment_id: null },
      ];
      const scores = [
        { assessment_id: 'a1', score: 80, is_excluded: false },
        { assessment_id: 'a2', score: 60, is_excluded: false },
      ];

      const grade = calculateStudentGrade(assessments, scores);
      expect(grade).toBe(70); // (80*50/100 + 60*50/100) = 40+30 = 70
    });

    it('returns 0 when all assessments are excluded', () => {
      const assessments = [
        { assessment_id: 'a1', weight_points: 100, max_score: 100, is_parent: false, parent_assessment_id: null },
      ];
      const scores = [
        { assessment_id: 'a1', score: 90, is_excluded: true },
      ];

      const grade = calculateStudentGrade(assessments, scores);
      expect(grade).toBe(0);
    });

    it('scales up when total active weight is less than 100', () => {
      const assessments = [
        { assessment_id: 'a1', weight_points: 25, max_score: 100, is_parent: false, parent_assessment_id: null },
        { assessment_id: 'a2', weight_points: 25, max_score: 100, is_parent: false, parent_assessment_id: null },
        { assessment_id: 'a3', weight_points: 50, max_score: 100, is_parent: false, parent_assessment_id: null },
      ];
      const scores = [
        { assessment_id: 'a1', score: 80, is_excluded: false },
        { assessment_id: 'a2', score: 80, is_excluded: false },
        { assessment_id: 'a3', score: 90, is_excluded: true }, // excluded, 50% weight removed
      ];

      // Active weight = 25+25 = 50, total = (80*25/100 + 80*25/100) = 40
      // Scaled = 40/50 * 100 = 80
      const grade = calculateStudentGrade(assessments, scores);
      expect(grade).toBe(80);
    });

    it('handles parent/child assessment hierarchy', () => {
      const parentId = 'parent-1';
      const assessments = [
        { assessment_id: parentId, weight_points: 100, is_parent: true, parent_assessment_id: null },
        { assessment_id: 'child-1', parent_assessment_id: parentId, max_score: 50, weight_points: 50 },
        { assessment_id: 'child-2', parent_assessment_id: parentId, max_score: 50, weight_points: 50 },
      ];
      const scores = [
        { assessment_id: 'child-1', score: 40, is_excluded: false },
        { assessment_id: 'child-2', score: 30, is_excluded: false },
      ];

      // Parent score: (40/50*50 + 30/50*50)/(50+50) = (40+30)/100 = 70%
      // Grade: 70*100/100 = 70
      const grade = calculateStudentGrade(assessments, scores);
      expect(grade).toBe(70);
    });

    it('returns 0 with empty assessments', () => {
      expect(calculateStudentGrade([], [])).toBe(0);
    });

    it('handles null scores as 0', () => {
      const assessments = [
        { assessment_id: 'a1', weight_points: 100, max_score: 100, is_parent: false, parent_assessment_id: null },
      ];
      const scores = [
        { assessment_id: 'a1', score: null, is_excluded: false },
      ];

      const grade = calculateStudentGrade(assessments, scores);
      expect(grade).toBe(0);
    });
  });

  describe('calculateBulkGrades', () => {
    it('calculates grades for multiple students', () => {
      const assessments = [
        { assessment_id: 'a1', weight_points: 100, max_score: 100, is_parent: false, parent_assessment_id: null },
      ];
      const allScoreRows = [
        { student_id: 's1', assessment_id: 'a1', score: 90, is_excluded: false },
        { student_id: 's2', assessment_id: 'a1', score: 70, is_excluded: false },
      ];

      const grades = calculateBulkGrades(assessments, allScoreRows);
      expect(grades.get('s1')).toBe(90);
      expect(grades.get('s2')).toBe(70);
    });

    it('returns empty map with no scores', () => {
      const grades = calculateBulkGrades([], []);
      expect(grades.size).toBe(0);
    });
  });

  describe('getGradeBreakdown', () => {
    it('returns breakdown with individual assessment contributions', () => {
      const assessments = [
        { assessment_id: 'a1', weight_points: 60, max_score: 100, is_parent: false, parent_assessment_id: null },
        { assessment_id: 'a2', weight_points: 40, max_score: 100, is_parent: false, parent_assessment_id: null },
      ];
      const scores = [
        { assessment_id: 'a1', score: 80, is_excluded: false },
        { assessment_id: 'a2', score: 90, is_excluded: false },
      ];

      const result = getGradeBreakdown(assessments, scores);
      expect(result.total).toBe(84); // 80*60/100 + 90*40/100 = 48+36 = 84
      expect(result.totalActiveWeight).toBe(100);
      expect(result.breakdown['a1'].score).toBe(80);
      expect(result.breakdown['a1'].weight).toBe(60);
      expect(result.breakdown['a2'].score).toBe(90);
      expect(result.excludedAssessments).toEqual([]);
    });

    it('lists excluded assessments', () => {
      const assessments = [
        { assessment_id: 'a1', weight_points: 100, max_score: 100, is_parent: false, parent_assessment_id: null },
      ];
      const scores = [
        { assessment_id: 'a1', score: 90, is_excluded: true },
      ];

      const result = getGradeBreakdown(assessments, scores);
      expect(result.total).toBe(0);
      expect(result.excludedAssessments).toEqual(['a1']);
    });
  });
});
