// services/assistant/tools/routes.js
//
// The backend's own routes that Muley's tools may call, by name. A tool
// names a route and gives its parameters; the dispatcher builds the URL, so
// nothing the model writes ever becomes a path. Read tools get GET routes
// only.
//
// Each of these is guarded by the route's own middleware exactly as it is
// for the app: the call carries the signed-in person's own token.

const ROUTES = Object.freeze({
  classes: { method: 'GET', path: '/api/classes' },                                    // the classes this person may see
  class: { method: 'GET', path: '/api/classes/:classId' },                             // one class (page context)
  classStudents: { method: 'GET', path: '/api/classes/:classId/students' },            // roster
  classScores: { method: 'GET', path: '/api/studentAssessments/classes/:classId/scores' }, // gradebook
  classAttendance: { method: 'GET', path: '/api/attendance/class/:classId' },          // ?date=YYYY-MM-DD
});

module.exports = { ROUTES };
