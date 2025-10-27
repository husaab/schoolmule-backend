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
const scheduleRoutes = require("./routes/schedule.routes");
const dashboardRoutes = require("./routes/dashboard.routes")
const emailRoutes = require("./routes/email.routes")
const parentStudentRoutes = require("./routes/parentStudent.routes")
const parentRoutes = require("./routes/parent.routes")
const messageRoutes = require("./routes/message.routes")
const feedbackRoutes = require("./routes/feedback.routes")
const staffRoutes = require("./routes/staff.routes")
const tuitionPlanRoutes = require("./routes/tuitionPlan.routes")
const tuitionInvoiceRoutes = require("./routes/tuitionInvoice.routes")
const tuitionInvoiceCommentRoutes = require("./routes/tuitionInvoiceComment.routes")
const schoolRoutes = require("./routes/school.routes")
const termRoutes = require("./routes/term.routes")
const reportsRoutes = require("./routes/reports.routes")
const progressReportsRoutes = require("./routes/progressReports.routes")
const excludedAssessmentRoutes = require("./routes/excludedAssessment.routes")


const logger = require('./logger')
const RequestLogger = require("./middleware/requestLogger")

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
app.use(RequestLogger);

app.use("/api/auth", authRoutes); 
app.use("/api/email", emailRoutes);

app.use(verifyUser);

app.use("/api/users", userRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/classes", classRoutes);
app.use("/api/assessments", assessmentRoutes);
app.use("/api/teachers", teacherRoutes);
app.use('/api/studentAssessments', studentAssessmentRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/report-cards", reportCardRoutes);
app.use("/api/schedules", scheduleRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/parent-students", parentStudentRoutes);
app.use("/api/parents", parentRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/feedback", feedbackRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/tuition-plans", tuitionPlanRoutes);
app.use("/api/tuition-invoices", tuitionInvoiceRoutes);
app.use("/api/tuition-invoice-comments", tuitionInvoiceCommentRoutes);
app.use("/api/schools", schoolRoutes);
app.use("/api/terms", termRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/progress-reports", progressReportsRoutes);
app.use("/api/excluded-assessments", excludedAssessmentRoutes);

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