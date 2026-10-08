/*
  utils/sessionContext.js
  The per-school context that rides along with every session payload (login,
  /auth/me, admin impersonation): the active term name and the list of school
  years. Kept out of the JWT on purpose — year context flows per request via
  the X-School-Year header.
*/

const db = require("../config/database");
const logger = require("../logger");
const termQueries = require("../queries/term.queries");
const schoolYearQueries = require("../queries/schoolYear.queries");

const getActiveTermForSchool = async (school) => {
  try {
    const result = await db.query(termQueries.selectActiveTermBySchool, [school]);
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    logger.error({ err: error }, "Error fetching active term");
    return null;
  }
};

const getSchoolYearContext = async (school) => {
  try {
    const years = await db.query(schoolYearQueries.selectYearsBySchool, [school]);
    const active = years.rows.find((y) => y.is_active) || null;
    return {
      activeSchoolYear: active ? { schoolYearId: active.school_year_id, label: active.label } : null,
      schoolYears: years.rows.map((y) => ({
        schoolYearId: y.school_year_id,
        school: y.school,
        schoolId: y.school_id,
        label: y.label,
        startDate: y.start_date,
        endDate: y.end_date,
        isActive: y.is_active,
        createdFromYearId: y.created_from_year_id,
      })),
    };
  } catch (error) {
    logger.error({ err: error }, "Error fetching school years");
    return { activeSchoolYear: null, schoolYears: [] };
  }
};

module.exports = { getActiveTermForSchool, getSchoolYearContext };
