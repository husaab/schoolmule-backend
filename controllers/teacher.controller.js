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

const getTeacherById = async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ status: 'failed', message: 'Missing teacher ID' });
  }

  try {
    const { rows } = await db.query(teacherQueries.selectTeacherById, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: `Teacher not found for id=${id}` });
    }

    const t = rows[0];
    return res.status(200).json({
      status: 'success',
      data: {
        userId: t.user_id,
        fullName: `${t.first_name} ${t.last_name}`,
        email: t.email,
      }
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching teacher by ID' });
  }
};

module.exports = {
  getTeachersBySchool,
  getTeacherById
};
