// Factory functions for mock DB rows (snake_case) and request bodies (camelCase)
const { v4: uuidv4 } = require('uuid');

const TEST_ADMIN_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const TEST_PARENT_USER_ID = '550e8400-e29b-41d4-a716-446655440002';
const TEST_SCHOOL = 'ALHAADIACADEMY';

// ─── Database Row Builders (snake_case) ────────────────────────

function buildUserRow(overrides = {}) {
  return {
    user_id: uuidv4(),
    email: 'user@test.com',
    username: 'Test User',
    password: '$2b$10$hashedpassword',
    first_name: 'Test',
    last_name: 'User',
    school: TEST_SCHOOL,
    role: 'TEACHER',
    email_token: uuidv4(),
    is_verified: true,
    is_verified_school: true,
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildStudentRow(overrides = {}) {
  return {
    student_id: uuidv4(),
    name: 'John Smith',
    homeroom_teacher_id: TEST_TEACHER_USER_ID,
    school: TEST_SCHOOL,
    grade: 5,
    oen: '123456789',
    mother_name: 'Jane Smith',
    mother_email: 'jane@test.com',
    mother_number: '555-0100',
    father_name: 'Bob Smith',
    father_email: 'bob@test.com',
    father_number: '555-0101',
    emergency_contact: '555-0199',
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    is_archived: false,
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function buildClassRow(overrides = {}) {
  return {
    class_id: uuidv4(),
    school: TEST_SCHOOL,
    grade: 5,
    subject: 'Mathematics',
    teacher_name: 'Teacher User',
    teacher_id: TEST_TEACHER_USER_ID,
    term_id: uuidv4(),
    term_name: 'Term 1 2025-2026',
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildAssessmentRow(overrides = {}) {
  return {
    assessment_id: uuidv4(),
    class_id: uuidv4(),
    name: 'Midterm Exam',
    weight_percent: 25,
    weight_points: 25,
    max_score: 100,
    date: '2025-10-15',
    parent_assessment_id: null,
    is_parent: false,
    sort_order: 0,
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildStudentAssessmentRow(overrides = {}) {
  return {
    student_id: uuidv4(),
    assessment_id: uuidv4(),
    score: 85,
    is_excluded: false,
    ...overrides,
  };
}

function buildClassStudentRow(overrides = {}) {
  return {
    class_id: uuidv4(),
    student_id: uuidv4(),
    ...overrides,
  };
}

function buildClassTeacherRow(overrides = {}) {
  return {
    class_id: uuidv4(),
    teacher_id: uuidv4(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildTermRow(overrides = {}) {
  return {
    term_id: uuidv4(),
    school: TEST_SCHOOL,
    school_id: uuidv4(),
    name: 'Term 1 2025-2026',
    start_date: '2025-09-01',
    end_date: '2025-12-20',
    academic_year: '2025-2026',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildSchoolRow(overrides = {}) {
  return {
    school_id: uuidv4(),
    school_code: TEST_SCHOOL,
    name: 'Al Haadi Academy',
    address: '123 School St',
    phone: '555-0000',
    email: 'admin@school.com',
    timezone: 'America/Toronto',
    academic_year_start_date: '2025-09-01',
    academic_year_end_date: '2026-06-30',
    created_at: new Date().toISOString(),
    last_updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildGeneralAttendanceRow(overrides = {}) {
  return {
    student_id: uuidv4(),
    attendance_date: '2025-10-15',
    status: 'PRESENT',
    school: TEST_SCHOOL,
    ...overrides,
  };
}

function buildClassAttendanceRow(overrides = {}) {
  return {
    class_id: uuidv4(),
    student_id: uuidv4(),
    attendance_date: '2025-10-15',
    status: 'PRESENT',
    ...overrides,
  };
}

function buildReportCardFeedbackRow(overrides = {}) {
  return {
    student_id: uuidv4(),
    class_id: uuidv4(),
    term: 'Term 1 2025-2026',
    work_habits: 'Excellent',
    behavior: 'Good',
    comment: 'Great progress this term.',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildReportCardRow(overrides = {}) {
  return {
    student_id: uuidv4(),
    term: 'Term 1 2025-2026',
    student_name: 'John Smith',
    file_path: 'report-cards/test.pdf',
    grade: 5,
    school: TEST_SCHOOL,
    generated_at: new Date().toISOString(),
    email_sent: false,
    email_sent_at: null,
    email_sent_by: null,
    ...overrides,
  };
}

function buildProgressReportFeedbackRow(overrides = {}) {
  return {
    id: uuidv4(),
    student_id: uuidv4(),
    class_id: uuidv4(),
    term: 'Term 1 2025-2026',
    core_standards: 'Meeting expectations',
    work_habit: 'Good',
    behavior: 'Excellent',
    comment: 'Solid progress.',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildProgressReportRow(overrides = {}) {
  return {
    student_id: uuidv4(),
    term: 'Term 1 2025-2026',
    student_name: 'John Smith',
    grade: 5,
    file_path: 'progress-reports/test.pdf',
    school: TEST_SCHOOL,
    generated_at: new Date().toISOString(),
    email_sent: false,
    email_sent_at: null,
    email_sent_by: null,
    ...overrides,
  };
}

function buildMessageRow(overrides = {}) {
  return {
    message_id: uuidv4(),
    sender_id: TEST_ADMIN_USER_ID,
    recipient_id: TEST_PARENT_USER_ID,
    school: TEST_SCHOOL,
    subject: 'Test Message',
    body: 'This is a test message.',
    sender_name: 'Admin User',
    recipient_name: 'Parent User',
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildFeedbackRow(overrides = {}) {
  return {
    feedback_id: uuidv4(),
    sender_id: TEST_TEACHER_USER_ID,
    sender_name: 'Teacher User',
    recipient_id: TEST_PARENT_USER_ID,
    recipient_name: 'Parent User',
    school: TEST_SCHOOL,
    subject: 'Student Progress',
    body: 'Your child is doing well.',
    assessment_name: 'Midterm',
    score: '85',
    weight_percentage: '25',
    course_name: 'Mathematics',
    student_id: uuidv4(),
    student_name: 'John Smith',
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildStaffRow(overrides = {}) {
  return {
    staff_id: uuidv4(),
    school: TEST_SCHOOL,
    full_name: 'Jane Doe',
    staff_role: 'Vice Principal',
    teaching_assignments: 'Grade 5 Math',
    homeroom_grade: 5,
    email: 'jane@school.com',
    phone: '555-0200',
    preferred_contact: 'email',
    phone_contact_hours: '9am-3pm',
    email_contact_hours: '8am-5pm',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildScheduleRow(overrides = {}) {
  return {
    schedule_id: uuidv4(),
    school: TEST_SCHOOL,
    grade: 5,
    day_of_week: 'Monday',
    start_time: '09:00',
    end_time: '09:45',
    subject: 'Mathematics',
    teacher_name: 'Teacher User',
    is_lunch: false,
    lunch_supervisor: null,
    week_start_date: '2025-10-13',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildParentStudentRow(overrides = {}) {
  return {
    parent_student_link_id: uuidv4(),
    student_id: uuidv4(),
    parent_id: TEST_PARENT_USER_ID,
    parent_name: 'Parent User',
    parent_email: 'parent@test.com',
    parent_number: '555-0300',
    relation: 'MOTHER',
    school: TEST_SCHOOL,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildTuitionPlanRow(overrides = {}) {
  return {
    plan_id: uuidv4(),
    school: TEST_SCHOOL,
    grade: 5,
    amount: 500.00,
    frequency: 'monthly',
    effective_from: '2025-09-01',
    effective_to: '2026-06-30',
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildTuitionInvoiceRow(overrides = {}) {
  return {
    invoice_id: uuidv4(),
    plan_id: uuidv4(),
    student_id: uuidv4(),
    student_name: 'John Smith',
    student_grade: 5,
    parent_id: TEST_PARENT_USER_ID,
    parent_name: 'Parent User',
    parent_email: 'parent@test.com',
    parent_number: '555-0300',
    period_start: '2025-10-01',
    period_end: '2025-10-31',
    amount_due: 500.00,
    date_due: '2025-10-15',
    amount_paid: 0,
    date_paid: null,
    issued_at: new Date().toISOString(),
    status: 'pending',
    school: TEST_SCHOOL,
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildTuitionInvoiceCommentRow(overrides = {}) {
  return {
    comment_id: uuidv4(),
    invoice_id: uuidv4(),
    commenter_id: TEST_ADMIN_USER_ID,
    commenter_name: 'Admin User',
    comment: 'Payment received via e-transfer.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildExcludedAssessmentRow(overrides = {}) {
  return {
    student_id: uuidv4(),
    class_id: uuidv4(),
    assessment_id: uuidv4(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildPatchNoteRow(overrides = {}) {
  return {
    patch_note_id: uuidv4(),
    title: 'New Feature: Grade Export',
    body: 'You can now export grades to Excel.',
    version: '1.2.0',
    category: 'feature',
    target_roles: ['ADMIN', 'TEACHER'],
    image_url: null,
    published_at: new Date().toISOString(),
    auto_dismiss_at: null,
    created_by: TEST_ADMIN_USER_ID,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildPatchNoteDismissalRow(overrides = {}) {
  return {
    user_id: uuidv4(),
    last_seen_patch_note_id: uuidv4(),
    dismissed_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildPasswordResetTokenRow(overrides = {}) {
  return {
    token: uuidv4(),
    user_id: uuidv4(),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildSchoolAssetRow(overrides = {}) {
  return {
    school_code: TEST_SCHOOL,
    school_id: uuidv4(),
    logo_path: 'assets/logo.png',
    principal_signature_path: 'assets/signature.png',
    school_stamp_path: 'assets/stamp.png',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildReportEmailRow(overrides = {}) {
  return {
    id: uuidv4(),
    report_type: 'report_card',
    student_id: uuidv4(),
    term: 'Term 1 2025-2026',
    sent_by: TEST_ADMIN_USER_ID,
    email_addresses: ['parent@test.com'],
    custom_header: null,
    custom_message: null,
    file_path: 'report-cards/test.pdf',
    sent_at: new Date().toISOString(),
    cc_addresses: [],
    school: TEST_SCHOOL,
    ...overrides,
  };
}

function buildTeacherAttendanceRow(overrides = {}) {
  return {
    teacher_id: TEST_TEACHER_USER_ID,
    attendance_date: '2025-10-15',
    status: 'present',
    school: TEST_SCHOOL,
    notes: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildJkskSkillDomainRow(overrides = {}) {
  return {
    domain_id: uuidv4(),
    document_type: 'progress_report',
    name: 'Language and Communication Skills',
    sort_order: 0,
    school: TEST_SCHOOL,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildJkskSkillRow(overrides = {}) {
  return {
    skill_id: uuidv4(),
    domain_id: uuidv4(),
    name: 'Speaks clearly and fluently',
    description: null,
    sort_order: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildJkskSkillAssessmentRow(overrides = {}) {
  return {
    id: uuidv4(),
    student_id: uuidv4(),
    skill_id: uuidv4(),
    term: 'Term 1 2025-2026',
    rating: 'DV',
    school: TEST_SCHOOL,
    assessed_by: TEST_TEACHER_USER_ID,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildJkskLearningSkillRow(overrides = {}) {
  return {
    id: uuidv4(),
    student_id: uuidv4(),
    term: 'Term 1 2025-2026',
    skill_name: 'Self-Regulation',
    rating: 'G',
    school: TEST_SCHOOL,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildJkskDomainCommentRow(overrides = {}) {
  return {
    id: uuidv4(),
    student_id: uuidv4(),
    domain_id: uuidv4(),
    term: 'Term 1 2025-2026',
    comment: 'Shows strong growth in language skills.',
    school: TEST_SCHOOL,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildJkskTeacherAssistantRow(overrides = {}) {
  return {
    id: uuidv4(),
    student_id: uuidv4(),
    teacher_assistant_name: 'Assistant Name',
    term: 'Term 1 2025-2026',
    school: TEST_SCHOOL,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildJkskProgressReportCommentRow(overrides = {}) {
  return {
    id: uuidv4(),
    student_id: uuidv4(),
    term: 'Term 1 2025-2026',
    comment: 'Overall excellent progress.',
    school: TEST_SCHOOL,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Request Body Builders (camelCase) ─────────────────────────

function buildRegisterBody(overrides = {}) {
  return {
    username: 'New User',
    email: 'newuser@test.com',
    password: 'SecurePass123!',
    school: TEST_SCHOOL,
    role: 'TEACHER',
    ...overrides,
  };
}

function buildLoginBody(overrides = {}) {
  return {
    email: 'user@test.com',
    password: 'SecurePass123!',
    ...overrides,
  };
}

function buildCreateStudentBody(overrides = {}) {
  return {
    name: 'John Smith',
    homeroomTeacherId: TEST_TEACHER_USER_ID,
    grade: 5,
    oen: '123456789',
    school: TEST_SCHOOL,
    mother: { name: 'Jane Smith', email: 'jane@test.com', phone: '555-0100' },
    father: { name: 'Bob Smith', email: 'bob@test.com', phone: '555-0101' },
    emergencyContact: '555-0199',
    ...overrides,
  };
}

function buildCreateClassBody(overrides = {}) {
  return {
    school: TEST_SCHOOL,
    grade: 5,
    subject: 'Mathematics',
    teacherName: 'Teacher User',
    teacherId: TEST_TEACHER_USER_ID,
    termId: uuidv4(),
    termName: 'Term 1 2025-2026',
    ...overrides,
  };
}

function buildCreateAssessmentBody(overrides = {}) {
  return {
    classId: uuidv4(),
    name: 'Midterm Exam',
    weightPercent: 25,
    weightPoints: 25,
    maxScore: 100,
    date: '2025-10-15',
    isParent: false,
    sortOrder: 0,
    ...overrides,
  };
}

module.exports = {
  TEST_ADMIN_USER_ID,
  TEST_TEACHER_USER_ID,
  TEST_PARENT_USER_ID,
  TEST_SCHOOL,
  // DB row builders
  buildUserRow,
  buildStudentRow,
  buildClassRow,
  buildAssessmentRow,
  buildStudentAssessmentRow,
  buildClassStudentRow,
  buildClassTeacherRow,
  buildTermRow,
  buildSchoolRow,
  buildGeneralAttendanceRow,
  buildClassAttendanceRow,
  buildReportCardFeedbackRow,
  buildReportCardRow,
  buildProgressReportFeedbackRow,
  buildProgressReportRow,
  buildMessageRow,
  buildFeedbackRow,
  buildStaffRow,
  buildScheduleRow,
  buildParentStudentRow,
  buildTuitionPlanRow,
  buildTuitionInvoiceRow,
  buildTuitionInvoiceCommentRow,
  buildExcludedAssessmentRow,
  buildPatchNoteRow,
  buildPatchNoteDismissalRow,
  buildPasswordResetTokenRow,
  buildSchoolAssetRow,
  buildReportEmailRow,
  buildTeacherAttendanceRow,
  buildJkskSkillDomainRow,
  buildJkskSkillRow,
  buildJkskSkillAssessmentRow,
  buildJkskLearningSkillRow,
  buildJkskDomainCommentRow,
  buildJkskTeacherAssistantRow,
  buildJkskProgressReportCommentRow,
  // Request body builders
  buildRegisterBody,
  buildLoginBody,
  buildCreateStudentBody,
  buildCreateClassBody,
  buildCreateAssessmentBody,
};
