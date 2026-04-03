const { Pool } = require('pg');

// All tables in the test schema — order doesn't matter with CASCADE
const ALL_TABLES = [
  'sk_progress_report_comments',
  'sk_subject_comments',
  'sk_standard_assessments',
  'sk_teacher_assistants',
  'sk_standards',
  'sk_subjects',
  'jk_progress_report_comments',
  'jk_domain_comments',
  'jk_learning_skills',
  'jk_skill_assessments',
  'jk_teacher_assistants',
  'jk_skills',
  'jk_skill_domains',
  'report_emails',
  'school_assets',
  'patch_note_dismissals',
  'patch_notes',
  'teacher_attendance',
  'tuition_invoice_comments',
  'tuition_invoices',
  'tuition_plans',
  'progress_reports',
  'progress_report_feedback',
  'report_cards',
  'report_card_feedback',
  'student_excluded_assessments',
  'student_assessments',
  'class_attendance',
  'general_attendance',
  'feedback',
  'messages',
  'parent_students',
  'staff',
  'schedules',
  'class_teachers',
  'class_students',
  'assessments',
  'classes',
  'students',
  'password_reset_tokens',
  'terms',
  'schools',
  'users',
];

// Pre-load the app so heavy requires (puppeteer, exceljs, etc.) don't
// eat into individual test timeouts.
const { getApp } = require('./integrationApp');
beforeAll(() => { getApp(); }, 30000);

let pool;

function getTestPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5433', 10),
      user: process.env.PG_USER || 'test_user',
      password: process.env.PG_PASSWORD || 'test_password',
      database: process.env.PG_DATABASE || 'schoolmule_test',
      ssl: false,
      max: 5,
    });
  }
  return pool;
}

// Truncate all tables between tests for isolation
beforeEach(async () => {
  const p = getTestPool();
  // Kill any in-flight queries from fire-and-forget async operations
  await p.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid != pg_backend_pid()
       AND state != 'idle'`
  );
  // Brief pause to let terminated connections clean up
  await new Promise(resolve => setTimeout(resolve, 200));
  await p.query(`TRUNCATE TABLE ${ALL_TABLES.join(', ')} CASCADE`);
});

// Close pool after all tests in a file
afterAll(async () => {
  if (pool) {
    await pool.end();
    pool = null;
  }
});

module.exports = { getTestPool, ALL_TABLES };
