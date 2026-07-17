const express = require("express")
require("dotenv").config();
const cors = require("cors");
const rateLimit = require('express-rate-limit');
const verifyUser = require('./middleware/verifyUserMiddleware');
const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const studentRoutes = require("./routes/student.routes")
const classRoutes = require("./routes/class.routes")
const assessmentRoutes = require("./routes/assessment.routes")
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
const schedulePublicRoutes = require("./routes/schedulePublic.routes")
const studentViewRoutes = require("./routes/studentView.routes")
const analyticsRoutes = require("./routes/analytics.routes")
const schoolCalendarRoutes = require("./routes/schoolCalendar.routes")
const agendaRoutes = require("./routes/agenda.routes")
const schedulePlannerRoutes = require("./routes/schedulePlanner.routes")
// const schoolYearRoutes = require("./routes/schoolYear.routes"); // created in Task 3
// const resolveSchoolYear = require("./middleware/resolveSchoolYear");

const logger = require('./logger')
const httpLogger = require("./middleware/httpLogger")
const errorHandler = require("./middleware/errorHandler")

// instantiating
const app = express();

const corsOptions = {
  origin: process.env.CROSS_ORIGIN_URL,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// core modules
app.use(cors(corsOptions));
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
app.use("/api/schedule/public", schedulePublicRoutes);

app.use(verifyUser);

// app.use("/api/school-years", schoolYearRoutes); // year mgmt itself needs no year context
// app.use(resolveSchoolYear);

app.use("/api/users", userRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/classes", classRoutes);
app.use("/api/assessments", assessmentRoutes);
app.use("/api/teachers", teacherRoutes);
app.use('/api/studentAssessments', studentAssessmentRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/report-cards", reportCardRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/parent-students", parentStudentRoutes);
app.use("/api/parents", parentRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/schools", schoolRoutes);
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
}