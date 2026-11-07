// services/reportGeneration/doneEmail.js
//
// When a batch of 10 or more finishes, the person who started it gets one
// email, and the same news as a push on the app, with how many reports are
// ready and how many students were skipped, and a button to the page. No
// student names. A stopped batch sends nothing, and Try again finishing the
// same run again sends nothing more (the run is the dedupe key). Smaller
// batches finish in seconds, so the page has already told them.
//
// The email is a courtesy: the page's card is the record. It goes through
// the email outbox (kind report_generation_done), built when it is sent.

const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/reportGeneration.queries');
const schoolQueries = require('../../queries/school.queries');
const outbox = require('../email/outbox');
const { schoolSender } = require('../email/senderIdentity');
const { renderEmail, schoolBrand, paragraph, button, signOff, schoolContact, escapeHtml } = require('../../templates/emailLayout');
const { getSchoolName } = require('../../utils/schoolUtils');

const KIND = 'report_generation_done';
const SUBJECT_TYPE = 'report_generation_run';
const MIN_STUDENTS = 10;

const PAGES = {
  report_card: { noun: 'report card', nouns: 'report cards', path: '/report-cards', page: 'Report cards' },
  progress_report: { noun: 'progress report', nouns: 'progress reports', path: '/reports/progress-reports', page: 'Progress reports' },
};

const base = () => process.env.FRONTEND_URL || '';
const pathFor = (spec, term) => `${spec.path}?term=${encodeURIComponent(term)}`;
const students = (n) => (n === 1 ? '1 student was' : `${n} students were`);

/** "161 report cards are ready", or that none could be made. */
function subjectFor(spec, generated, failed) {
  if (generated === 0) return `None of the ${failed} ${spec.nouns} could be made`;
  return generated === 1 ? `1 ${spec.noun} is ready` : `${generated} ${spec.nouns} are ready`;
}

/**
 * Queues the email for a run finishIfDone just finished, if it gets one.
 * @param run  the row finishIfDone returned
 * @returns {Promise<number>} emails queued (0 or 1)
 */
async function queueDoneEmail(run) {
  if (!run || run.student_count < MIN_STUDENTS || !run.created_by) return 0;
  const { rows: [who] } = await db.query(q.selectDoneRecipient, [run.run_id]);
  if (!who || who.cancelled > 0 || !who.email) return 0;
  const queued = await outbox.enqueue(db, [{
    kind: KIND,
    school: run.school,
    recipientUserId: who.user_id,
    recipientEmail: who.email,
    subjectType: SUBJECT_TYPE,
    subjectId: run.run_id,
    dedupeKey: run.run_id,
    priority: 3,
  }]);
  if (queued > 0) outbox.kick();
  return queued;
}

async function schoolInfoOf(school) {
  try {
    const { rows } = await db.query(schoolQueries.selectSchoolByCode, [school]);
    return rows[0] || null;
  } catch (error) {
    logger.warn({ err: error, school }, 'School lookup failed for a report generation email');
    return null;
  }
}

/** Builds the email when it is sent (services/email/outbox.js). */
const reportGenerationDoneHandler = {
  async build(job) {
    const { rows: [run] } = await db.query(q.selectDoneCounts, [job.subject_id]);
    if (!run) return { skip: 'Run removed' };
    const spec = PAGES[run.report_type];
    const path = pathFor(spec, run.term);
    const subject = subjectFor(spec, run.generated, run.failed);
    const skipped = run.failed > 0 ? `${students(run.failed)} skipped. The page lists who and why.` : '';
    const ready = run.generated > 0
      ? `${run.generated === 1 ? `1 ${spec.noun}` : `${run.generated} ${spec.nouns}`} for ${run.term} ${run.generated === 1 ? 'is' : 'are'} ready.`
      : `None of the ${spec.nouns} for ${run.term} could be made.`;

    const schoolInfo = await schoolInfoOf(run.school);
    const schoolName = getSchoolName(run.school);
    const html = renderEmail({
      brand: schoolBrand(schoolInfo, schoolName),
      heading: subject,
      preheader: [ready, skipped].filter(Boolean).join(' '),
      content: [
        paragraph(escapeHtml(ready)),
        skipped ? paragraph(escapeHtml(skipped)) : '',
        button(`Open ${spec.page}`, `${base()}${path}`),
        signOff(schoolName),
      ].join(''),
      footer: schoolContact(schoolInfo, schoolName),
    });

    return {
      message: {
        ...schoolSender({ school: run.school, schoolInfo, role: 'academics' }),
        to: [job.recipient_email],
        subject,
        html,
      },
      sentContent: { subject, generated: run.generated, failed: run.failed },
      push: {
        category: 'reminders',
        title: subject,
        body: [run.term, run.failed > 0 ? `${students(run.failed)} skipped` : null].filter(Boolean).join(' · '),
        path,
      },
    };
  },
};

module.exports = { KIND, MIN_STUDENTS, queueDoneEmail, reportGenerationDoneHandler };
