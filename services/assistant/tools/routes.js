// services/assistant/tools/routes.js
//
// The backend's own routes that Muley's tools may call, by name. A tool
// names a route and gives its parameters; the dispatcher builds the URL, so
// nothing the model writes ever becomes a path. Read tools get GET routes
// only; the POST routes are for applying a change the person approved.
//
// Each of these is guarded by the route's own middleware exactly as it is
// for the app: the call carries the signed-in person's own token.

const ROUTES = Object.freeze({
  classes: { method: 'GET', path: '/api/classes' },                                    // the classes this person may see
  class: { method: 'GET', path: '/api/classes/:classId' },                             // one class (page context)
  classStudents: { method: 'GET', path: '/api/classes/:classId/students' },            // roster
  classScores: { method: 'GET', path: '/api/studentAssessments/classes/:classId/scores' }, // gradebook
  classAttendance: { method: 'GET', path: '/api/attendance/class/:classId' },          // ?date=YYYY-MM-DD
  classAssessments: { method: 'GET', path: '/api/classes/:classId/assessments' },
  gridOverlay: { method: 'GET', path: '/api/classroom/classes/:classId/grid-overlay' }, // columns filled from Classwork
  classStatsExclusions: { method: 'GET', path: '/api/classes/:classId/stats-exclusions' }, // who is left out of the class average

  // Writes. Never given to a tool: only services/assistant/actions runs them,
  // when the person presses Apply or Undo on a change they were shown.
  saveClassAttendance: { method: 'POST', path: '/api/attendance/class' },
  saveScores: { method: 'POST', path: '/api/studentAssessments/classes/:classId/scores' },
  saveStatsExclusion: { method: 'PUT', path: '/api/classes/:classId/stats-exclusions/:studentId' },
  removeStatsExclusion: { method: 'DELETE', path: '/api/classes/:classId/stats-exclusions/:studentId' },
});

module.exports = { ROUTES };
