const express = require("express")
require("dotenv").config();
const cors = require("cors");
const rateLimit = require('express-rate-limit');
const verifyUser = require('./middleware/verifyUserMiddleware');
const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const adminUserRoutes = require("./routes/adminUser.routes");
const studentRoutes = require("./routes/student.routes")
const classRoutes = require("./routes/class.routes")
const assessmentRoutes = require("./routes/assessment.routes")
const assessmentPublishRoutes = require("./routes/assessmentPublish.routes")
const teacherRoutes = require("./routes/teacher.routes")
const studentAssessmentRoutes = require("./routes/studentAssessment.routes")
const attendanceRoutes = require("./routes/attendance.routes")
const reportCardRoutes = require('./routes/reportCard.routes');
const dashboardRoutes = require("./routes/dashboard.routes")
const emailRoutes = require("./routes/email.routes")
const parentStudentRoutes = require("./routes/parentStudent.routes")
const parentRoutes = require("./routes/parent.routes")
const staffRoutes = require("./routes/staff.routes")
const schoolRoutes = require("./routes/school.routes")
const termRoutes = require("./routes/term.routes")
const reportsRoutes = require("./routes/reports.routes")
const progressReportsRoutes = require("./routes/progressReports.routes")
const excludedAssessmentRoutes = require("./routes/excludedAssessment.routes")
const schoolAssetRoutes = require("./routes/schoolAssets.routes")
const reportEmailRoutes = require("./routes/reportEmails.routes")
const teacherAttendanceRoutes = require("./routes/teacherAttendance.routes")
const patchNoteRoutes = require("./routes/patchNote.routes")
const jkRoutes = require("./routes/jk.routes")
const skRoutes = require("./routes/sk.routes")
const registrationRoutes = require("./routes/registration.routes")
const registrationPublicRoutes = require("./routes/registrationPublic.routes")
const googleSheetsPublicRoutes = require("./routes/googleSheetsPublic.routes")
const financePublicRoutes = require("./routes/financePublic.routes")
const financeRoutes = require("./routes/finance.routes")
const schedulePublicRoutes = require("./routes/schedulePublic.routes")
const studentViewRoutes = require("./routes/studentView.routes")
const analyticsRoutes = require("./routes/analytics.routes")
const schoolCalendarRoutes = require("./routes/schoolCalendar.routes")
const agendaRoutes = require("./routes/agenda.routes")
const schedulePlannerRoutes = require("./routes/schedulePlanner.routes")
const parentPortalRoutes = require("./routes/parentPortal.routes")
const schoolYearRoutes = require("./routes/schoolYear.routes"); // created in Task 3
const resolveSchoolYear = require("./middleware/resolveSchoolYear");

const logger = require('./logger')
const httpLogger = require("./middleware/httpLogger")
const errorHandler = require("./middleware/errorHandler")

// instantiating
const app = express();

// Local dev is reachable as both localhost and 127.0.0.1; the browser treats
// them as different origins, so allow the twin too. No effect in production.
const allowedOrigins = [
  ...new Set(
    [process.env.CROSS_ORIGIN_URL, process.env.CROSS_ORIGIN_URL?.replace('localhost', '127.0.0.1')].filter(Boolean)
  ),
];

const corsOptions = {
  origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-School-Year'],
  // Lets the browser read download filenames (CSV/PDF exports) across origins.
  exposedHeaders: ['Content-Disposition'],
};

// core modules
app.use(cors(corsOptions));
// The finance roster import posts the whole roster JSON + customer-map CSV
// (~150 KB for Al Haadi), above the 100 KB default. body-parser skips a body
// it has already parsed, so the global parser below leaves this one alone.
app.use("/api/finance/families/import", express.json({ limit: "2mb" }));
app.use(express.json());

const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 1000,
});

// Apply the limiter to all requests
app.use(limiter);
app.use(httpLogger);

app.use("/api/auth", authRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/registration/public", registrationPublicRoutes);
// Google's OAuth callback lands here with no Authorization header, so it must
// be mounted ahead of verifyUser. Non-matching /google/* paths fall through to
// the authenticated registration router below.
app.use("/api/registration/google", googleSheetsPublicRoutes);
// Intuit OAuth callback: no JWT on the redirect, school comes from the signed state.
app.use("/api/finance/qbo", financePublicRoutes);
app.use("/api/schedule/public", schedulePublicRoutes);

app.use(verifyUser);

app.use("/api/school-years", schoolYearRoutes); // year mgmt itself needs no year context
// School entities themselves are also exempt: creating a school is a
// bootstrapping operation (the new school by definition has no years yet),
// and school.controller.js is not school-year-scoped (no req.schoolYear
// usage) — same rationale as /api/school-years above.
app.use("/api/schools", schoolRoutes);
app.use(resolveSchoolYear);

app.use("/api/users", userRoutes);
app.use("/api/admin/users", adminUserRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/classes", classRoutes);
app.use("/api/assessments", assessmentRoutes);
app.use("/api/assessment-publications", assessmentPublishRoutes);
app.use("/api/teachers", teacherRoutes);
app.use('/api/studentAssessments', studentAssessmentRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/report-cards", reportCardRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/parent-students", parentStudentRoutes);
app.use("/api/parents", parentRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/terms", termRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/progress-reports", progressReportsRoutes);
app.use("/api/excluded-assessments", excludedAssessmentRoutes);
app.use("/api/school-assets", schoolAssetRoutes);
app.use("/api/report-emails", reportEmailRoutes);
app.use("/api/teacher-attendance", teacherAttendanceRoutes);
app.use("/api/patch-notes", patchNoteRoutes);
app.use("/api/jk", jkRoutes);
app.use("/api/sk", skRoutes);
app.use("/api/registration", registrationRoutes);
app.use("/api/student-views", studentViewRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/calendar-events", schoolCalendarRoutes);
app.use("/api/agendas", agendaRoutes);
app.use("/api/schedule-planner", schedulePlannerRoutes);
app.use("/api/parent-portal", parentPortalRoutes);
app.use("/api/finance", financeRoutes);

// Global error handler — must be after all routes
app.use(errorHandler);

// Export app for testing
module.exports = app;

// Only start the server if this file is run directly
if (require.main === module) {
  // app start up
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
      logger.info(`server is running on port ${PORT}`)
      logger.info(`cross origin enabled for ${process.env.CROSS_ORIGIN_URL}`)
  });

  // Drains the Google Sheets sync outbox. Deliberately started here rather
  // than at module load: every test suite requires this file, and a poller
  // started on import would leave timers running across the whole suite.
  require("./services/google/sheetSyncWorker").startWorker();
  require("./services/finance/financeSyncWorker").startWorker();
}