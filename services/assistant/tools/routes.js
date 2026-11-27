// services/assistant/tools/routes.js
//
// The backend's own routes that Muley's tools may call, by name. A tool
// names a route and gives its parameters; the dispatcher builds the URL, so
// nothing the model writes ever becomes a path. Read tools get GET routes
// only; the POST routes are for applying a change the person approved.
//
// Each of these is guarded by the route's own middleware exactly as it is
// for the app: the call carries the signed-in person's own token.

const ASSET_TYPE = /^(logo|principal_signature|school_stamp)$/;
const SCHOOL_CODE = /^[A-Z0-9_]{2,60}$/;

const ROUTES = Object.freeze({
  classes: { method: 'GET', path: '/api/classes' },                                    // the classes this person may see
  class: { method: 'GET', path: '/api/classes/:classId' },                             // one class (page context)
  classStudents: { method: 'GET', path: '/api/classes/:classId/students' },            // roster
  classScores: { method: 'GET', path: '/api/studentAssessments/classes/:classId/scores' }, // gradebook
  classAttendance: { method: 'GET', path: '/api/attendance/class/:classId' },          // ?date=YYYY-MM-DD
  classAttendanceRange: { method: 'GET', path: '/api/attendance/class/:classId/range' }, // ?from=&to=
  generalAttendanceRange: { method: 'GET', path: '/api/attendance/general/range' },    // ?from=&to=, the school's daily attendance
  classAssessments: { method: 'GET', path: '/api/classes/:classId/assessments' },
  gridOverlay: { method: 'GET', path: '/api/classroom/classes/:classId/grid-overlay' }, // columns filled from Classwork
  classStatsExclusions: { method: 'GET', path: '/api/classes/:classId/stats-exclusions' }, // who is left out of the class average
  students: { method: 'GET', path: '/api/students' },                                  // the school's students (roster permission)
  activeTerm: { method: 'GET', path: '/api/terms/active' },
  currentTerm: { method: 'GET', path: '/api/terms/current' },
  analyticsClass: { method: 'GET', path: '/api/analytics/class/:classId' },            // the Analytics page's class detail
  analyticsStudent: { method: 'GET', path: '/api/analytics/student/:studentId' },      // ?termId=
  analyticsSnapshot: { method: 'GET', path: '/api/analytics/snapshot' },               // ?termId=, one record per student
  schoolAssets: { method: 'GET', path: '/api/school-assets/school-code/:schoolCode', params: { schoolCode: SCHOOL_CODE } },
  schoolAssetVersions: { method: 'GET', path: '/api/school-assets/:schoolId/:assetType/versions', params: { assetType: ASSET_TYPE } },

  // The parent portal: a parent's own children, as the portal shows them.
  parentSummary: { method: 'GET', path: '/api/parent-portal/summary' },
  parentChildGrades: { method: 'GET', path: '/api/parent-portal/students/:studentId/grades' },
  parentChildAttendance: { method: 'GET', path: '/api/parent-portal/students/:studentId/attendance' }, // ?from=&to=
  parentClassroomSummary: { method: 'GET', path: '/api/parent-portal/classroom/summary' },
  parentCalendar: { method: 'GET', path: '/api/parent-portal/calendar' },              // ?from=&to=
  parentMeetings: { method: 'GET', path: '/api/parent-portal/meetings' },

  // Writes. Never given to a tool: only services/assistant/actions runs them,
  // when the person presses Apply or Undo on a change they were shown.
  saveClassAttendance: { method: 'POST', path: '/api/attendance/class' },
  saveScores: { method: 'POST', path: '/api/studentAssessments/classes/:classId/scores' },
  saveStatsExclusion: { method: 'PUT', path: '/api/classes/:classId/stats-exclusions/:studentId' },
  removeStatsExclusion: { method: 'DELETE', path: '/api/classes/:classId/stats-exclusions/:studentId' },
  replaceSchoolAsset: { method: 'POST', path: '/api/school-assets/from-assistant' },
  restoreSchoolAssetVersion: { method: 'POST', path: '/api/school-assets/:schoolId/:assetType/versions/:versionId/restore', params: { assetType: ASSET_TYPE } },
  deleteSchoolAsset: { method: 'DELETE', path: '/api/school-assets/:schoolId/:assetType', params: { assetType: ASSET_TYPE } },
});

module.exports = { ROUTES };
