const db = require("../config/database");
const scheduleQueries = require("../queries/schedule.queries");
const logger = require("../logger");

//
// GET /schedules?school=...&week=...
//
const getAllSchedules = async (req, res) => {
  const { school, week } = req.query;

  if (!school || !week) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required query parameters: school and week",
    });
  }

  try {
    const { rows } = await db.query(scheduleQueries.selectSchedulesBySchool, [school, week]);
    return res.status(200).json({ status: "success", data: rows });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({
      status: "failed",
      message: "Error fetching schedules",
    });
  }
};

//
// GET /schedules/grade/:grade?school=...&week=...
//
const getSchedulesByGrade = async (req, res) => {
  const { grade } = req.params;
  const { school, week } = req.query;

  if (!school || !week || !grade) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required parameters: school, week, and grade",
    });
  }

  try {
    const { rows } = await db.query(scheduleQueries.selectSchedulesByGrade, [
      school,
      parseInt(grade, 10),
      week,
    ]);
    return res.status(200).json({ status: "success", data: rows });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({
      status: "failed",
      message: "Error fetching schedules by grade",
    });
  }
};

//
// POST /schedules
//
const createSchedule = async (req, res) => {
  const {
    school,
    grade,
    day_of_week,
    start_time,
    end_time,
    subject,
    teacher_name,
    is_lunch,
    lunch_supervisor,
    week_start_date,
  } = req.body;

  if (!school || !day_of_week || !start_time || !end_time || !week_start_date) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required fields: school, day_of_week, start_time, end_time, week_start_date",
    });
  }

  try {
    
    const values = [
      school,
      grade,
      day_of_week,
      start_time,
      end_time,
      subject,
      teacher_name,
      is_lunch,
      lunch_supervisor,
      week_start_date,
    ];

    const { rows } = await db.query(scheduleQueries.createSchedule, values);
    return res.status(201).json({ status: "success", data: rows[0] });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({
      status: "failed",
      message: "Error creating schedule",
    });
  }
};

//
// PATCH /schedules/:id
//
const updateSchedule = async (req, res) => {
  const { id } = req.params;
  const {
    school,
    grade,
    day_of_week,
    start_time,
    end_time,
    subject,
    teacher_name,
    is_lunch,
    lunch_supervisor,
    week_start_date,
  } = req.body;

  try {
    const values = [
      school,
      grade,
      day_of_week,
      start_time,
      end_time,
      subject,
      teacher_name,
      is_lunch,
      lunch_supervisor,
      week_start_date,
      id,
    ];

    const { rows, rowCount } = await db.query(scheduleQueries.updateScheduleById, values);

    if (rowCount === 0) {
      return res.status(404).json({
        status: "failed",
        message: `Schedule with id ${id} not found`,
      });
    }

    return res.status(200).json({ status: "success", data: rows[0] });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({
      status: "failed",
      message: "Error updating schedule",
    });
  }
};

//
// DELETE /schedules/:id
//
const deleteSchedule = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(scheduleQueries.deleteScheduleById, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: "failed",
        message: `Schedule with id ${id} not found`,
      });
    }

    return res.status(200).json({
      status: "success",
      message: "Schedule deleted successfully",
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({
      status: "failed",
      message: "Error deleting schedule",
    });
  }
};

module.exports = {
  getAllSchedules,
  getSchedulesByGrade,
  createSchedule,
  updateSchedule,
  deleteSchedule,
};
