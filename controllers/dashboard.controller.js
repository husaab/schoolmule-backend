// src/controllers/dashboard.controller.js

const db = require('../config/database');
const dashboardQueries = require('../queries/dashboard.queries');
const logger = require('../logger');

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
    const [
      totalStudentsRes,
      totalTeachersRes,
      totalClassesRes,
      todaysAttRes,
      weeklyAttRes,
      monthlyAttRes,
      avgGradeRes,
      reportCardsRes,
      avgClassSizeRes
    ] = await Promise.all([
      db.query(dashboardQueries.selectTotalStudents, [school]),
      db.query(dashboardQueries.selectTotalTeachers, [school]),
      db.query(dashboardQueries.selectTotalClasses, [school]),
      db.query(dashboardQueries.selectTodaysAttendanceRate, [school, date]),
      db.query(dashboardQueries.selectWeeklyAttendanceRate, [school, date]),
      db.query(dashboardQueries.selectMonthlyAttendanceRate, [school, date]),
      db.query(dashboardQueries.selectAverageStudentGrade, [school]),
      db.query(dashboardQueries.selectReportCardsCount, [school, term]),
      db.query(dashboardQueries.selectAverageClassSize, [school])
    ]);

    const totalStudents       = totalStudentsRes.rows[0].count;
    const totalTeachers       = totalTeachersRes.rows[0].count;
    const totalClasses        = totalClassesRes.rows[0].count;
    const todaysAttendance    = parseFloat(todaysAttRes.rows[0].rate);
    const weeklyAttendance    = parseFloat(weeklyAttRes.rows[0].rate);
    const monthlyAttendance   = parseFloat(monthlyAttRes.rows[0].rate);
    const averageStudentGrade = parseFloat(avgGradeRes.rows[0].average_grade);
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

module.exports = {
  getSummary,
  getTodaysAttendanceRate,
  getWeeklyAttendanceRate,
  getMonthlyAttendanceRate,
  getAttendanceTrend
};
