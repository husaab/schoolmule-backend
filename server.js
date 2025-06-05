const express = require("express")
require("dotenv").config();
const cors = require("cors");
const rateLimit = require('express-rate-limit');

const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const studentRoutes = require("./routes/student.routes")
const classRoutes = require("./routes/class.routes")
const assessmentRoutes = require("./routes/assessment.routes")
const teacherRoutes = require("./routes/teacher.routes")
const studentAssessmentRoutes = require("./routes/studentAssessment.routes")
const attendanceRoutes = require("./routes/attendance.routes")

const logger = require('./logger')
const RequestLogger = require("./middleware/requestLogger")

// instantiating
const app = express();

const corsOptions = {
  origin: process.env.CROSS_ORIGIN_URL,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

// core modules
app.use(cors(corsOptions));
app.use(express.json());

const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30,
});

// Apply the limiter to all requests
app.use(limiter);
app.use(RequestLogger);

app.use("/api/auth", authRoutes); 
app.use("/api/users", userRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/classes", classRoutes);
app.use("/api/assessments", assessmentRoutes);
app.use("/api/teachers", teacherRoutes);
app.use('/api/studentAssessments', studentAssessmentRoutes);
app.use("/api/attendance", attendanceRoutes);

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