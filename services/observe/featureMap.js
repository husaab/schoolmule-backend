// Ordered: a more specific prefix must come before a shorter one that would
// also match (/api/admin/users before /api/users).
const FEATURES = [
  ['/api/admin/users', 'Admin: users'],
  ['/api/admin/approvals', 'Admin: approvals'],
  ['/api/assessment-publications', 'Assessment publishing'],
  ['/api/assessments', 'Gradebook'],
  ['/api/studentAssessments', 'Gradebook'],
  ['/api/excluded-assessments', 'Gradebook'],
  ['/api/report-cards', 'Report cards'],
  ['/api/reports', 'Report cards'],
  ['/api/progress-reports', 'Report cards'],
  ['/api/report-emails', 'Report cards'],
  ['/api/teacher-attendance', 'Staff attendance'],
  ['/api/attendance', 'Attendance'],
  ['/api/parent-portal', 'Parent portal'],
  ['/api/parent-students', 'Parent relations'],
  ['/api/parents', 'Parent relations'],
  ['/api/schedule-planner', 'Schedule planner'],
  ['/api/messaging', 'Messaging'],
  ['/api/announcements', 'Messaging'],
  ['/api/finance', 'Finance'],
  ['/api/registration', 'Forms'],
  ['/api/student-views', 'Student views'],
  ['/api/analytics', 'Analytics'],
  ['/api/agendas', 'Agendas'],
  ['/api/patch-notes', "What's new"],
  ['/api/jk', 'JK/SK grading'],
  ['/api/sk', 'JK/SK grading'],
  ['/api/students', 'Students'],
  ['/api/classes', 'Classes'],
  ['/api/teachers', 'Teachers'],
  ['/api/staff', 'Staff'],
  ['/api/users', 'Users'],
  ['/api/dashboard', 'Dashboard'],
  ['/api/terms', 'School setup'],
  ['/api/school-years', 'School setup'],
  ['/api/schools', 'School setup'],
  ['/api/school-assets', 'School setup'],
  ['/api/calendar-events', 'School setup'],
  ['/api/observe', 'Observe'],
  ['/api/health', 'Health'],
];

const matches = (route, prefix) => route === prefix || route.startsWith(prefix + '/');

function featureFor(route) {
  const r = String(route || '');
  const hit = FEATURES.find(([prefix]) => matches(r, prefix));
  return hit ? hit[1] : 'Other';
}

// The same mapping as a SQL CASE so grouping happens in Postgres. Prefixes
// contain only [a-zA-Z/-], so inlining them is safe.
function featureCaseSql(col = 'route') {
  const whens = FEATURES.map(
    ([prefix, label]) => `WHEN ${col} = '${prefix}' OR ${col} LIKE '${prefix}/%' THEN '${label.replace(/'/g, "''")}'`
  );
  return `CASE ${whens.join(' ')} ELSE 'Other' END`;
}

module.exports = { FEATURES, featureFor, featureCaseSql };
