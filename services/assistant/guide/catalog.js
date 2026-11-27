// services/assistant/guide/catalog.js
//
// The site guide: where each thing in School Mule lives and how to get
// there, so Muley can answer "where are the report templates?" or "how do I
// leave a student out of the class average?" with a link and the steps.
//
// One entry per thing a person might look for:
//   title     what the page or action is called in the app
//   words     other words people use for it (matched by find)
//   path      the page, as the web app and the mobile app both route it;
//             ":classId" is filled in when the conversation has a class
//   needs     who can open it: 'staff' (any teacher or admin), 'fullAdmin',
//             or the permission keys of config/permissions.js (any one)
//   steps     how to get there by hand, in the app's own labels
//   muley     the Muley tool that can do it, when there is one; a list
//             gives the tool to name first where the conversation has it
//             (a change tool only where the school allows changes)
//
// The sidebar and Admin Panel labels here are the ones in
// schoolmule/src/components/sidebar/Sidebar.tsx and src/lib/adminPanelNav.ts;
// the permissions mirror ROUTE_RULES in src/lib/permissions.ts. When a page
// is added, renamed or moved there, change it here too.

const STAFF = 'staff';
const FULL_ADMIN = 'fullAdmin';
// The parent portal's pages: found only by a parent, and only for them.
const PARENT = 'parent';

const ENTRIES = [
  // ── Everyday ────────────────────────────────────────────────
  { id: 'dashboard', title: 'Dashboard', words: ['home', 'overview', 'briefing', 'today'], path: '/dashboard', needs: STAFF,
    steps: ['In the sidebar, choose Dashboard.'] },
  { id: 'classes', title: 'Classes', words: ['class list', 'my classes', 'create class', 'new class', 'classwork', 'assignments'], path: '/classes', needs: STAFF,
    steps: ['In the sidebar, choose Classes.', 'Open a class to see its classwork, students and settings.'], muley: 'list_classes' },
  { id: 'gradebook', title: 'Gradebook', words: ['grades', 'marks', 'scores', 'enter grades', 'assessments', 'quiz marks', 'test marks', 'grading'], path: '/gradebook', classPath: '/gradebook/:classId', needs: STAFF,
    steps: ['In the sidebar, choose Classes and open the class.', 'Go to its gradebook: each student is a row and each assessment a column.', 'Type a score in a cell; it saves by itself.'], muley: ['propose_scores', 'get_gradebook'] },
  { id: 'class-attendance', title: 'Class Attendance', words: ['attendance', 'take attendance', 'roll', 'register', 'absent', 'late', 'present'], path: '/attendance/class', classPath: '/attendance/class/:classId', needs: STAFF,
    steps: ['In the sidebar, open Attendance and choose Class Attendance.', 'Pick the class and the day, mark each student, then Save.'], muley: ['propose_class_attendance', 'get_class_attendance'] },
  { id: 'general-attendance', title: 'General Attendance', words: ['daily attendance', 'whole school attendance', 'homeroom attendance', 'morning attendance', 'take attendance', 'mark present', 'mark absent', 'absent today', 'late today', 'roll call'], path: '/attendance/general', needs: ['attendance.daily'],
    steps: ['In the sidebar, open Attendance and choose General Attendance.', 'Pick the day, mark each student, then Save.'], muley: ['propose_general_attendance', 'get_daily_attendance'] },
  { id: 'students', title: 'Students', words: ['student list', 'directory', 'student profile', 'add student', 'archive student', 'deleted students', 'custom fields'], path: '/students', needs: ['students'],
    steps: ['In the sidebar, choose Students.', 'Open a student to see their profile.'] },
  { id: 'messages', title: 'Messages', words: ['inbox', 'message a parent', 'conversations', 'chat with parents'], path: '/messages', needs: STAFF,
    steps: ['In the sidebar, choose Messages.'] },
  { id: 'analytics', title: 'Analytics', words: ['averages', 'at risk', 'trends', 'insights', 'performance', 'term comparison'], path: '/analytics', needs: ['analytics'],
    steps: ['In the sidebar, choose Analytics.'], muley: ['get_students_needing_attention', 'get_class_insights'] },
  { id: 'report-cards', title: 'Report Cards', words: ['generate report cards', 'report card comments', 'term reports'], path: '/report-cards', needs: ['report_cards'],
    steps: ['In the sidebar, choose Report Cards.'] },
  { id: 'reports', title: 'Reports', words: ['progress reports', 'student summary', 'interim report'], path: '/reports', needs: ['report_cards'],
    steps: ['In the sidebar, choose Reports.', 'Progress Reports and Student Summary are inside it.'] },
  { id: 'student-views', title: 'Student Views', words: ['saved lists', 'filters', 'student groups'], path: '/student-views', needs: ['students'],
    steps: ['In the sidebar, choose Student Views.'] },
  { id: 'school-schedule', title: 'School Schedule', words: ['timetable', 'periods', 'whole school schedule'], path: '/school-schedule', needs: STAFF,
    steps: ['In the sidebar, choose School Schedule.'] },
  { id: 'my-schedule', title: 'My Schedule', words: ['my timetable', 'my periods'], path: '/my-schedule', needs: STAFF,
    steps: ['Open My Schedule from the schedule menu at the top of the page.'] },
  { id: 'my-attendance', title: 'My Attendance', words: ['check in', 'my hours', 'sign in for work', 'clock in'], path: '/my-attendance', needs: STAFF,
    steps: ['In the sidebar, choose My Attendance.'] },
  { id: 'staff-attendance', title: 'Staff Attendance', words: ['staff hours', 'pay periods', 'teacher attendance', 'hours sheet'], path: '/staff-attendance', needs: ['staff_attendance'],
    steps: ['In the sidebar, choose Staff Attendance.'] },
  { id: 'tuition', title: 'Tuition', words: ['finance', 'invoices', 'fees', 'payments', 'quickbooks', 'families'], path: '/finance/tuition', needs: ['finance'],
    steps: ['In the sidebar, open Finance and choose Tuition.'] },
  { id: 'settings', title: 'Settings', words: ['my account', 'password', 'my signature', 'phone number', 'notifications', 'profile photo'], path: '/settings', needs: STAFF,
    steps: ['At the bottom of the sidebar, choose Settings.'] },
  { id: 'whats-new', title: "What's New", words: ['release notes', 'updates', 'changes', 'patch notes'], path: '/whats-new', needs: STAFF,
    steps: ["In the sidebar, choose What's New."] },
  { id: 'support', title: 'Help & Support', words: ['help', 'contact support', 'guides'], path: '/support', needs: STAFF,
    steps: ['In the sidebar, choose Help & Support.'] },

  // ── Forms ───────────────────────────────────────────────────
  { id: 'forms', title: 'Form Builder', words: ['forms', 'registration form', 'create a form', 'sign-up form'], path: '/admin-panel/forms', needs: ['forms'],
    steps: ['In the sidebar, open Forms and choose Form Builder.'] },
  { id: 'form-submissions', title: 'Form Submissions', words: ['registrations', 'applications', 'responses', 'import students from a form'], path: '/admin-panel/forms/submissions', needs: ['forms'],
    steps: ['In the sidebar, open Forms and choose Submissions.'] },

  // ── Admin Panel: People ─────────────────────────────────────
  { id: 'users', title: 'Users', words: ['staff accounts', 'parent accounts', 'invite a teacher', 'add a user', 'archive a user'], path: '/admin-panel/users', needs: ['users'],
    steps: ['In the sidebar, open Admin Panel.', 'Under People, choose Users.'] },
  { id: 'roles', title: 'Roles', words: ['permissions', 'access', 'office staff role', 'what can teachers do'], path: '/admin-panel/roles', needs: FULL_ADMIN,
    steps: ['In the sidebar, open Admin Panel.', 'Under People, choose Roles.'] },
  { id: 'student-accounts', title: 'Student accounts', words: ['student logins', 'student portal accounts', 'qr cards', 'student passwords'], path: '/admin-panel/student-accounts', needs: ['users'],
    steps: ['In the sidebar, open Admin Panel.', 'Under People, choose Student accounts.'] },
  { id: 'approvals', title: 'User Approvals', words: ['pending sign-ups', 'approve a parent', 'approve a teacher', 'new accounts'], path: '/admin-panel/approvals', needs: ['users'],
    steps: ['In the sidebar, open Admin Panel.', 'Under People, choose User Approvals.'] },
  { id: 'relations', title: 'Parent Relations', words: ['link a parent to a student', 'guardians', 'siblings', 'parent links'], path: '/admin-panel/relations', needs: ['users'],
    steps: ['In the sidebar, open Admin Panel.', 'Under People, choose Parent Relations.'] },
  { id: 'all-messages', title: 'All Messages', words: ['every conversation', 'school inbox', 'monitor messages'], path: '/admin-panel/messages', needs: ['messages.all'],
    steps: ['In the sidebar, open Admin Panel.', 'Under People, choose All Messages.'] },

  // ── Admin Panel: School setup ───────────────────────────────
  { id: 'school-settings', title: 'School Settings', words: ['school name', 'principal', 'school board', 'address', 'grading scale', 'student custom fields'], path: '/admin-panel/school-settings', needs: ['school_setup'],
    steps: ['In the sidebar, open Admin Panel.', 'Under School setup, choose School Settings.'] },
  { id: 'school-calendar', title: 'School Calendar', words: ['holidays', 'pa days', 'events', 'term dates', 'school days'], path: '/admin-panel/school-calendar', needs: ['school_setup'],
    steps: ['In the sidebar, open Admin Panel.', 'Under School setup, choose School Calendar.'] },
  { id: 'school-assets', title: 'School Assets', words: ['logo', 'stamp', 'school stamp', 'seal', 'principal signature', 'branding', 'restore the old stamp', 'earlier versions', 'stamp on report cards', 'stamp at the bottom of progress reports', 'logo on report cards', 'signature on report cards'], path: '/admin-panel/school-assets', needs: ['school_setup'],
    steps: ['In the sidebar, open Admin Panel.', 'Under School setup, choose School Assets.', 'Pick a file under the logo, the principal signature or the stamp, then Upload. Report cards and progress reports use the new one from then on. The file you replace is kept under Earlier versions, where you can restore it.'],
    muley: 'propose_school_asset' },
  { id: 'report-templates', title: 'Report Templates', words: ['report card design', 'report layout', 'progress report template', 'comment limits', 'subject headings'], path: '/admin-panel/report-templates', needs: ['school_setup'],
    steps: ['In the sidebar, open Admin Panel.', 'Under School setup, choose Report Templates.'] },

  // ── Admin Panel: Planning ───────────────────────────────────
  { id: 'schedule-planner', title: 'Schedule Planner', words: ['build the timetable', 'schedule builder', 'assign periods', 'rooms'], path: '/admin-panel/schedule-planner', needs: ['scheduling'],
    steps: ['In the sidebar, open Admin Panel.', 'Under Planning, choose Schedule Planner.'] },
  { id: 'agendas', title: 'Agenda Editor', words: ['student agenda', 'planner pages', 'agenda book'], path: '/admin-panel/agendas', needs: ['scheduling'],
    steps: ['In the sidebar, open Admin Panel.', 'Under Planning, choose Agenda Editor.'] },
  { id: 'meetings', title: 'Parent–Teacher Meetings', words: ['interviews', 'conference night', 'book meetings', 'meeting slots'], path: '/admin-panel/parent-teacher-meetings', needs: ['scheduling'],
    steps: ['In the sidebar, open Admin Panel.', 'Under Planning, choose Parent–Teacher Meetings.'] },

  // ── Things done inside a page ───────────────────────────────
  { id: 'class-average-exclusion', title: 'Leave a student out of the class average', words: ['omit a student from the class average', 'exclude from average', 'who counts in the class average', 'do not count a student', 'class statistics', 'median', 'rank'], path: '/classes', classPath: '/classes/:classId', needs: STAFF,
    steps: ['Open the class and go to its Settings.', 'Under Class options, choose "Who counts in the class average".', 'Switch the student off. They keep every mark and their own term grade; they are only left out of the class average, median and rank.', 'To leave a student out of one assessment only, open the gradebook, open that cell\'s menu and choose "Leave out of the class average".'],
    muley: 'propose_class_average_exclusion' },
  { id: 'excuse-assessment', title: 'Excuse a student from an assessment, or mark it missing', words: ['excused', 'exempt', 'missing work', 'did not hand in', 'absent for the test'], path: '/gradebook', classPath: '/gradebook/:classId', needs: STAFF,
    steps: ['Open the class\'s gradebook.', 'Open the menu on the student\'s cell for that assessment.', 'Choose Excused (it never counts) or Missing (it counts as zero).'],
    muley: 'propose_scores' },
  { id: 'publish-grades', title: 'Publish grades to parents', words: ['release marks', 'send grades home', 'parents cannot see grades', 'unpublish'], path: '/gradebook', classPath: '/gradebook/:classId', needs: STAFF,
    steps: ['Open the class\'s gradebook.', 'Choose Publish and pick the assessments to release.', 'Parents and students see a grade only once it is published; guardians are emailed a couple of minutes later, and you can unpublish before then.'] },
  { id: 'report-card-comments', title: 'Write report card comments', words: ['comments', 'work habits', 'behaviour ratings', 'ai comment', 'comment bank'], path: '/gradebook', classPath: '/gradebook/:classId/feedback', needs: STAFF,
    steps: ['Open the class\'s gradebook and choose its report card comments.', 'Fill in each student\'s ratings and comment; they save as you go.'],
    muley: ['propose_report_card_comments', 'get_report_card_comments'] },

  // ── The parent portal (sidebar labels as a parent sees them) ─
  { id: 'parent-overview', title: 'Overview', words: ['home', 'dashboard', 'summary', 'my children'], path: '/parent/dashboard', needs: PARENT,
    steps: ['In the menu, choose Overview.'], muley: 'list_my_children' },
  { id: 'parent-grades', title: 'Grades', words: ['marks', 'scores', 'how is my child doing', 'tests', 'assessments', 'average', 'report'], path: '/parent/grades', needs: PARENT,
    steps: ['In the menu, choose Grades.', 'Pick your child at the top, then open a class to see each mark.', 'A mark shows once the teacher publishes it.'], muley: 'get_child_grades' },
  { id: 'parent-classes', title: 'Classes', words: ['homework', 'classwork', 'assignments', 'due', 'missing work', 'stream', 'class posts', 'hand in'], path: '/parent/classes', needs: PARENT,
    steps: ['In the menu, choose Classes.', 'Pick your child to see their classes, what is due and what was posted.'], muley: 'get_whats_due' },
  { id: 'parent-attendance', title: 'Attendance', words: ['absent', 'late', 'absences', 'days missed', 'report an absence'], path: '/parent/attendance', needs: PARENT,
    steps: ['In the menu, choose Attendance.', 'Pick your child to see each day.'], muley: 'get_child_attendance' },
  { id: 'parent-messages', title: 'Messages', words: ['message a teacher', 'contact the teacher', 'email the teacher', 'write to the school', 'office', 'inbox', 'reply'], path: '/parent/messages', needs: PARENT,
    steps: ['In the menu, choose Messages.', 'Choose New message, pick the teacher or the office, and write your message.'] },
  { id: 'parent-meetings', title: 'Meetings', words: ['parent teacher meeting', 'parent-teacher interviews', 'conference', 'book a meeting', 'book a time', 'interview'], path: '/parent/meetings', needs: PARENT,
    steps: ['In the menu, choose Meetings (it shows while meetings are open).', 'Pick a teacher and a time, then confirm.', 'You can move or cancel it there until booking closes.'], muley: 'get_meetings' },
  { id: 'parent-calendar', title: 'Calendar', words: ['holidays', 'pa day', 'school closed', 'events', 'no school', 'break', 'dates'], path: '/parent/calendar', needs: PARENT,
    steps: ['In the menu, choose Calendar.'], muley: 'get_school_calendar' },
  { id: 'parent-feedback', title: 'Feedback', words: ['comments', 'teacher comments', 'progress report', 'learning skills'], path: '/parent/feedback', needs: PARENT,
    steps: ['In the menu, choose Feedback.', 'Comments show once the school sends the report home.'] },
  { id: 'parent-report-cards', title: 'Report Cards', words: ['report card', 'term report', 'download report', 'pdf'], path: '/parent/report-cards', needs: PARENT,
    steps: ['In the menu, choose Report Cards.', 'Open your child to download each report once the school sends it.'] },
  { id: 'parent-staff', title: 'Staff Directory', words: ['teachers', 'who is my child\'s teacher', 'staff', 'principal', 'contact list'], path: '/parent/staff', needs: PARENT,
    steps: ['In the menu, choose Staff Directory.'] },
  { id: 'parent-notifications', title: 'Notification settings', words: ['emails', 'notifications', 'stop emails', 'email settings', 'alerts'], path: '/parent/notifications', needs: PARENT,
    steps: ['Open your account menu at the top right and choose Notifications.'] },
];

module.exports = { ENTRIES, STAFF, FULL_ADMIN, PARENT };
