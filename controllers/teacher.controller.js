// controllers/teacher.controller.js

const db = require("../config/database");
const teacherQueries = require("../queries/teacher.queries");
const logger = require("../logger");

/**
 * GET /teachers?school={school}
 * → Returns [{ userId, fullName, email }, … ] for all teachers in that school.
 */
const getTeachersBySchool = async (req, res) => {
  const requestedSchool = req.query.school;
  if (!requestedSchool) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required query parameter: school"
    });
  }

  try {
    const { rows } = await db.query(
      teacherQueries.selectTeachersBySchool,
      [requestedSchool]
    );

    const data = rows.map((t) => ({
      userId:   t.user_id,
      fullName: `${t.first_name} ${t.last_name}`,
      email:    t.email
    }));

    logger.info(`Fetched ${data.length} teachers for school="${requestedSchool}"`);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res
      .status(500)
      .json({ status: "failed", message: "Error fetching teachers" });
  }
};

module.exports = {
  getTeachersBySchool
};
