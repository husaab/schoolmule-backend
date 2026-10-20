// config/permissions.js
//
// The one list of staff permissions (RBAC). A permission is one switch per
// area of the app; a staff role (staff_roles row) is a named set of these keys.
// The catalog lives here, not in the database, so a mistyped key is refused by
// the roles API and dropped when a role is read.
//
// Not permissions, because every staff account has them: their own classes
// (gradebook, class attendance, editing the class), creating a class with
// themselves as lead, their own forms, their own check-in, their own message
// threads and announcements to the classes they teach.
//
// Also not here, because no role can ever grant them: managing roles, "View
// as" a teacher or parent, making someone an administrator, touching a full
// administrator's account and publishing patch notes. Those are full-admin only.

const GROUPS = [
  { id: 'academics', label: 'Academics' },
  { id: 'people', label: 'People' },
  { id: 'attendance', label: 'Attendance' },
  { id: 'communication', label: 'Communication' },
  { id: 'operations', label: 'Operations' },
];

const PERMISSIONS = [
  {
    key: 'classes.all', group: 'academics', label: 'All classes and grades',
    description: 'Open every class, its classwork, gradebook, assessments and grades, not only the classes they teach.',
  },
  {
    key: 'classes.manage', group: 'academics', label: 'Manage classes',
    description: 'Create, edit, copy and delete any class, enroll students and assign teachers, without seeing grades.',
  },
  {
    key: 'analytics', group: 'academics', label: 'Analytics',
    description: 'School-wide analytics, grade averages on the dashboard and the Grades tab of a student profile.',
  },
  {
    key: 'report_cards', group: 'academics', label: 'Report cards and reports',
    description: 'Report cards, progress reports, student summaries and report emails for the whole school.',
  },
  {
    key: 'students', group: 'people', label: 'Students',
    description: 'The student directory, student profiles and student views.',
  },
  {
    key: 'users', group: 'people', label: 'Users and approvals',
    description: 'Staff and parent accounts, student accounts and invites, sign-up approvals and parent relations. Cannot make anyone an administrator. Gets the sign-up and student request emails.',
  },
  {
    key: 'attendance.daily', group: 'attendance', label: 'General attendance',
    description: 'Daily (general) attendance for the whole school.',
  },
  {
    key: 'attendance.classes', group: 'attendance', label: 'Class attendance for every class',
    description: 'Mark class attendance in any class. Teachers can always mark their own classes.',
  },
  {
    key: 'staff_attendance', group: 'attendance', label: 'Staff attendance and hours',
    description: "Everyone's staff attendance, work days, hours, pay schedule and the hours sheet.",
  },
  {
    key: 'messages.all', group: 'communication', label: 'All messages',
    description: 'See and reply to every conversation in the school (Admin Panel, All Messages).',
  },
  {
    key: 'announcements.school', group: 'communication', label: 'School announcements',
    description: 'Announce to the whole school, a grade, any class or a custom audience, and edit or remove any announcement.',
  },
  {
    key: 'forms', group: 'operations', label: 'Forms',
    description: 'Every form, including registration, all submissions, statuses, imports and linked sheets. Anyone can still build their own forms.',
  },
  {
    key: 'scheduling', group: 'operations', label: 'Scheduling and agendas',
    description: 'The schedule planner and the agenda editor.',
  },
  {
    key: 'school_setup', group: 'operations', label: 'School setup',
    description: 'School settings, classroom settings, terms, school years and rollover, the calendar and school assets.',
  },
  {
    key: 'finance', group: 'operations', label: 'Finance',
    description: 'Tuition, invoices, families and QuickBooks. Gets the QuickBooks sync alerts.',
  },
];

const KEYS = PERMISSIONS.map((p) => p.key);
const KEY_SET = new Set(KEYS);

const ADMIN_DEFAULT = Object.freeze([...KEYS]);
// Today's teacher access, made explicit. Their own classes come on top.
const TEACHER_DEFAULT = Object.freeze(['analytics', 'report_cards', 'students', 'attendance.daily']); // catalog order
// "Start from" template in the roles editor; not seeded.
const OFFICE_STAFF_PRESET = Object.freeze(
  KEYS.filter((k) => !['classes.all', 'classes.manage', 'analytics', 'finance'].includes(k)),
);

// A custom role can't take a built-in's name, so the Users page never shows
// two "Admin"s that mean different things.
const RESERVED_ROLE_NAMES = new Set(['admin', 'administrator', 'teacher']);

const isKnownPermission = (key) => KEY_SET.has(key);

/** -> { valid: string[] (deduped, catalog order), unknown: string[], notArray?: true } */
const normalizePermissions = (input) => {
  if (!Array.isArray(input)) return { valid: [], unknown: [], notArray: true };
  const given = new Set(input.map((k) => (typeof k === 'string' ? k.trim() : k)));
  return {
    valid: KEYS.filter((k) => given.has(k)),
    unknown: [...given].filter((k) => !KEY_SET.has(k)),
  };
};

const catalogForApi = () => ({
  groups: GROUPS,
  permissions: PERMISSIONS,
  presets: [{ id: 'office-staff', name: 'Office Staff', permissions: [...OFFICE_STAFF_PRESET] }],
  builtIns: [
    {
      id: 'admin', name: 'Admin', builtIn: true, permissions: [...ADMIN_DEFAULT],
      description: 'Everything, including roles, View as and making administrators.',
    },
    {
      id: 'teacher', name: 'Teacher', builtIn: true, permissions: [...TEACHER_DEFAULT],
      description: 'Their own classes, plus students, analytics, report cards and general attendance.',
    },
  ],
});

module.exports = {
  GROUPS,
  PERMISSIONS,
  KEYS,
  ADMIN_DEFAULT,
  TEACHER_DEFAULT,
  OFFICE_STAFF_PRESET,
  RESERVED_ROLE_NAMES,
  isKnownPermission,
  normalizePermissions,
  catalogForApi,
};
