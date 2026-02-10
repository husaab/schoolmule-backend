// src/controllers/dashboard.controller.js

const db = require('../config/database');
const dashboardQueries = require('../queries/dashboard.queries');
const logger = require('../logger');
const { calculateStudentGrade } = require('../utils/gradeCalculator');

// Simple in-memory cache with TTL for school average grades
// Railway server runs continuously, so this persists between requests
const gradeCache = new Map(); // key: school, value: { average, timestamp }
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms

/**
 * Calculate school-wide average grade using proper grade calculation
 * Handles exclusions, parent/child hierarchy, max_score conversion, and weight scaling
 *
 * @param {string} school - The school enum value
 * @returns {Promise<number|null>} Average grade percentage or null if no data
 */
async function calculateSchoolAverageGrade(school) {
  // 1. Fetch all data in parallel for efficiency
  const [enrollmentsRes, assessmentsRes, scoresRes] = await Promise.all([
    db.query(dashboardQueries.selectStudentClassEnrollments, [school]),
    db.query(dashboardQueries.selectAssessmentsBySchool, [school]),
    db.query(dashboardQueries.selectStudentScoresBySchool, [school])
  ]);

  const enrollments = enrollmentsRes.rows;
  const allAssessments = assessmentsRes.rows;
  const allScores = scoresRes.rows;

  if (enrollments.length === 0) return null;

  // 2. Group assessments by class_id for quick lookup
  const assessmentsByClass = {};
  allAssessments.forEach(a => {
    if (!assessmentsByClass[a.class_id]) assessmentsByClass[a.class_id] = [];
    assessmentsByClass[a.class_id].push(a);
  });

  // 3. Group scores by student_id and class_id for quick lookup
  const scoresByStudentAndClass = {};
  allScores.forEach(s => {
    const key = `${s.student_id}:${s.class_id}`;
    if (!scoresByStudentAndClass[key]) scoresByStudentAndClass[key] = [];
    scoresByStudentAndClass[key].push(s);
  });

  // 4. Calculate grades for each student-class combination
  const allGrades = [];

  for (const enrollment of enrollments) {
    const classAssessments = assessmentsByClass[enrollment.class_id] || [];
    const key = `${enrollment.student_id}:${enrollment.class_id}`;
    const studentScores = scoresByStudentAndClass[key] || [];

    if (classAssessments.length === 0) continue;

    // Calculate grade using shared utility (handles all edge cases)
    const grade = calculateStudentGrade(classAssessments, studentScores);
    allGrades.push(grade);
  }

  // 5. Calculate school-wide average
  if (allGrades.length === 0) return null;

  const sum = allGrades.reduce((acc, g) => acc + g, 0);
  return sum / allGrades.length;
}

/**
 * Get school average grade with 24-hour caching
 *
 * @param {string} school - The school enum value
 * @returns {Promise<number|null>} Cached or freshly calculated average
 */
async function getSchoolAverageGrade(school) {
  const cached = gradeCache.get(school);
  const now = Date.now();

  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    return cached.average;
  }

  // Calculate fresh and cache the result
  const average = await calculateSchoolAverageGrade(school);
  gradeCache.set(school, { average, timestamp: now });
  return average;
}

/**
 * GET /api/dashboard/summary
 * Query params: school, term, date (YYYY-MM-DD)
 */
const getSummary = async (req, res) => {
  const { school, term, date } = req.query;
  if (!school) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: school' });
  }
  if (!term) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: term' });
  }
  if (!date) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: date' });
  }

  try {
    // Parallel queries for performance, now including date for attendance queries
    // Note: Average grade uses JavaScript calculation with caching (separate from SQL queries)
    const [
      totalStudentsRes,
      totalTeachersRes,
      totalClassesRes,
      todaysAttRes,
      weeklyAttRes,
      monthlyAttRes,
      reportCardsRes,
      avgClassSizeRes,
      averageGrade
    ] = await Promise.all([
      db.query(dashboardQueries.selectTotalStudents, [school]),
      db.query(dashboardQueries.selectTotalTeachers, [school]),
      db.query(dashboardQueries.selectTotalClasses, [school]),
      db.query(dashboardQueries.selectTodaysAttendanceRate, [school, date]),
      db.query(dashboardQueries.selectWeeklyAttendanceRate, [school, date]),
      db.query(dashboardQueries.selectMonthlyAttendanceRate, [school, date]),
      db.query(dashboardQueries.selectReportCardsCount, [school, term]),
      db.query(dashboardQueries.selectAverageClassSize, [school]),
      getSchoolAverageGrade(school)
    ]);

    const totalStudents       = totalStudentsRes.rows[0].count;
    const totalTeachers       = totalTeachersRes.rows[0].count;
    const totalClasses        = totalClassesRes.rows[0].count;
    const todaysAttendance    = parseFloat(todaysAttRes.rows[0].rate);
    const weeklyAttendance    = parseFloat(weeklyAttRes.rows[0].rate);
    const monthlyAttendance   = parseFloat(monthlyAttRes.rows[0].rate);
    const averageStudentGrade = averageGrade !== null ? parseFloat(averageGrade.toFixed(2)) : null;
    const reportCardsCount    = reportCardsRes.rows[0].count;
    const avgClassSize = parseFloat(avgClassSizeRes.rows[0].avg_class_size);

    return res.status(200).json({
      status: 'success',
      data: {
        totalStudents,
        totalTeachers,
        totalClasses,
        todaysAttendance,
        weeklyAttendance,
        monthlyAttendance,
        averageStudentGrade,
        reportCardsCount,
        avgClassSize
      },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching dashboard summary' });
  }
};

/**
 * GET /api/dashboard/attendance/today
 * Query params: school, date
 */
const getTodaysAttendanceRate = async (req, res) => {
  const { school, date } = req.query;
  if (!school) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: school' });
  }
  if (!date) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: date' });
  }
  try {
    const { rows } = await db.query(dashboardQueries.selectTodaysAttendanceRate, [school, date]);
    return res.status(200).json({ status: 'success', data: { rate: parseFloat(rows[0].rate) } });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching today\'s attendance rate' });
  }
};

/**
 * GET /api/dashboard/attendance/weekly
 * Query params: school, endDate
 */
const getWeeklyAttendanceRate = async (req, res) => {
  const { school, endDate } = req.query;
  if (!school) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: school' });
  }
  if (!endDate) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: endDate' });
  }
  try {
    const { rows } = await db.query(dashboardQueries.selectWeeklyAttendanceRate, [school, endDate]);
    return res.status(200).json({ status: 'success', data: { rate: parseFloat(rows[0].rate) } });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching weekly attendance rate' });
  }
};

/**
 * GET /api/dashboard/attendance/monthly
 * Query params: school, referenceDate
 */
const getMonthlyAttendanceRate = async (req, res) => {
  const { school, referenceDate } = req.query;
  if (!school) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: school' });
  }
  if (!referenceDate) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: referenceDate' });
  }
  try {
    const { rows } = await db.query(dashboardQueries.selectMonthlyAttendanceRate, [school, referenceDate]);
    return res.status(200).json({ status: 'success', data: { rate: parseFloat(rows[0].rate) } });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching monthly attendance rate' });
  }
};

/**
 * GET /api/dashboard/attendance/trend
 * Query params:
 *   - school     (required)
 *   - days       (optional, default = 7)
 *   - endDate    (optional, YYYY-MM-DD; default = CURRENT_DATE)
 */
const getAttendanceTrend = async (req, res) => {
  const { school, days = 7, endDate } = req.query;
  if (!school) {
    return res.status(400).json({ status: 'failed', message: 'Missing school' });
  }

  // We'll treat `refDate` as a date string or fallback to CURRENT_DATE
  // Passing it in as text, so cast to date in SQL
  const sql = `
    WITH params AS (
      SELECT
        $1::public.school   AS school,
        $2::int             AS days,
        COALESCE($3::date, CURRENT_DATE) AS end_dt
    ),
    total_students AS (
      SELECT COUNT(*) AS cnt
      FROM students s
      JOIN params p ON p.school = s.school
    ),
    dates AS (
      SELECT generate_series(
        (SELECT end_dt FROM params) - ((SELECT days FROM params) - 1),
        (SELECT end_dt FROM params),
        '1 day'
      )::date AS dt
    ),
    attendance_counts AS (
      SELECT
        ga.attendance_date,
        COUNT(*) FILTER (WHERE ga.status IN ('PRESENT','LATE')) AS present_count
      FROM general_attendance ga
      JOIN students s
        ON ga.student_id = s.student_id
      JOIN params p
        ON s.school = p.school
      WHERE ga.attendance_date
        BETWEEN (SELECT end_dt FROM params) - ((SELECT days FROM params) - 1)
            AND (SELECT end_dt FROM params)
      GROUP BY ga.attendance_date
    )
    SELECT
      to_char(d.dt, 'YYYY-MM-DD') AS date,
      -- divide by the fixed total enrolled students
      COALESCE(ac.present_count::float / ts.cnt, 0) AS rate
    FROM dates d
    CROSS JOIN total_students ts
    LEFT JOIN attendance_counts ac
      ON ac.attendance_date = d.dt
    ORDER BY d.dt;
  `;

  try {
    const { rows } = await db.query(sql, [school, days, endDate || null]);
    return res.status(200).json({ status: 'success', data: rows });
  } catch (err) {
    logger.error(err);
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error fetching attendance trend' });
  }
};

/**
 * GET /api/dashboard/financial
 * Query params: school
 */
const getFinancialOverview = async (req, res) => {
  const { school } = req.query;
  if (!school) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: school' });
  }

  try {
    // Parallel queries for performance
    const [
      totalRevenueRes,
      totalOutstandingRes,
      statusCountsRes,
      studentsWithInvoicesRes,
      monthlyTrendsRes,
      averagePaymentRes
    ] = await Promise.all([
      db.query(dashboardQueries.selectTotalRevenue, [school]),
      db.query(dashboardQueries.selectTotalOutstanding, [school]),
      db.query(dashboardQueries.selectInvoiceStatusCounts, [school]),
      db.query(dashboardQueries.selectStudentsWithInvoices, [school]),
      db.query(dashboardQueries.selectMonthlyRevenueTrends, [school]),
      db.query(dashboardQueries.selectAveragePayment, [school])
    ]);

    // Process status counts into an object
    const statusCounts = {};
    statusCountsRes.rows.forEach(row => {
      statusCounts[row.status] = row.count;
    });

    // Ensure all status types are present with 0 if not found
    const allStatuses = ['pending', 'paid', 'overdue', 'cancelled'];
    allStatuses.forEach(status => {
      if (!statusCounts[status]) {
        statusCounts[status] = 0;
      }
    });

    // Process monthly trends
    const monthlyTrends = monthlyTrendsRes.rows.map(row => ({
      month: row.month,
      revenue: parseFloat(row.revenue),
      invoiceCount: row.invoice_count
    }));

    const totalRevenue = parseFloat(totalRevenueRes.rows[0].total_revenue);
    const totalOutstanding = parseFloat(totalOutstandingRes.rows[0].total_outstanding);
    const studentsWithInvoices = studentsWithInvoicesRes.rows[0].count;
    const averagePayment = parseFloat(averagePaymentRes.rows[0]?.average_payment || 0);

    return res.status(200).json({
      status: 'success',
      data: {
        totalRevenue,
        totalOutstanding,
        statusCounts,
        studentsWithInvoices,
        monthlyTrends,
        averagePayment
      },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching financial overview' });
  }
};

/**
 * POST /api/dashboard/refresh-grade-cache
 * Query params: school
 * Manually invalidates the grade cache for a school (useful after bulk grade uploads)
 */
const refreshGradeCache = async (req, res) => {
  const { school } = req.query;
  if (!school) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: school' });
  }

  try {
    // Invalidate cached value by deleting it
    gradeCache.delete(school);

    // Recalculate immediately so the next request is fast
    const average = await calculateSchoolAverageGrade(school);
    gradeCache.set(school, { average, timestamp: Date.now() });

    return res.status(200).json({
      status: 'success',
      message: 'Grade cache refreshed',
      data: { averageStudentGrade: average !== null ? parseFloat(average.toFixed(2)) : null }
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error refreshing grade cache' });
  }
};

module.exports = {
  getSummary,
  getTodaysAttendanceRate,
  getWeeklyAttendanceRate,
  getMonthlyAttendanceRate,
  getAttendanceTrend,
  getFinancialOverview,
  refreshGradeCache
};
