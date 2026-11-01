/**
 * The comment rows the JK and SK progress reports print, in print order.
 * Saved as jk_progress_report_comments / sk_progress_report_comments rows
 * with `key` as section_type.
 *
 * One list for everything that prints them: the legacy templates
 * (alHaadiProgressReportJKTemplate.js, alHaadiProgressReportSKTemplate.js)
 * and the report engine's ReportData (services/reportEngine/data/comments.js).
 * The SK list is kept in step with the web/app copy (src/lib/skProgressComments.ts).
 */

/** SK: the "Strengths/Next Steps for Improvement" rows of the paper template. */
const SK_PROGRESS_COMMENT_ROWS = [
  { key: 'language_arts', label: 'Language Arts', caption: 'Reading, Writing, Oral communication, Media Literacy' },
  { key: 'mathematics', label: 'Mathematics' },
  { key: 'science', label: 'Science' },
  { key: 'social_studies', label: 'Social Studies' },
  { key: 'quran', label: 'Quran' },
  { key: 'arabic', label: 'Arabic' },
  { key: 'islamic_studies', label: 'Islamic Studies' },
  { key: 'creativity', label: 'Creativity' },
  { key: 'french', label: 'French' },
];

/** JK: the "Teacher's Comments" page (each printed as "<label>:"). */
const JK_PROGRESS_COMMENT_ROWS = [
  { key: 'academic_achievement', label: 'Academic achievement' },
  { key: 'socio_emotional', label: 'Socio-emotional development' },
];

module.exports = { SK_PROGRESS_COMMENT_ROWS, JK_PROGRESS_COMMENT_ROWS };
