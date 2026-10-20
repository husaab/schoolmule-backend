#!/usr/bin/env node
// scripts/backfillPublishDigests.js
//
// One-off catch-up for the child-only publish bug (fixed 2026-10-19,
// 8459c5b): grades published from inside a category went live, but no
// parent email was sent. Sends one "New Grades Posted" email per student
// covering every class with such grades, from the grades as they are now.
//
//   node --env-file=<backend .env> scripts/backfillPublishDigests.js
//     [--school ALHAADIACADEMY]           only this school
//     [--report <file.json>]               write the full plan (names, addresses) to a file
//     [--preview-to <email>]               send one sample, marked [Preview], to this address; nothing is logged
//     [--preview-file <file.html>]         write that sample to a file instead (nothing is sent)
//     [--preview-student <student id>]     which student the sample shows (default: the one with the most classes)
//     [--send --portal-url https://...]    send to every family and log each send
//
// Dry run by default: prints what would be sent, sends nothing. A publish
// counts as missed when no email went out within the hour after it, it held
// graded work, and that student's family has had no email since covering
// those columns or their category. A catch-up send is logged against the
// original publish as such an email, so running this again never emails a
// family twice.

const db = require('../config/database');
const publishQueries = require('../queries/assessmentPublish.queries');
const {
  groupScoreRowsByStudent, resolveRecipients, loadEmailContext, EMAIL_RATE_LIMIT_MS,
} = require('../controllers/assessmentPublish.controller');
const { planCatchUp } = require('../services/publishBackfill');
const { getGradesDigestEmailHTML } = require('../templates/emailTemplate');
const { getResend } = require('../utils/emailUtils');
const { schoolSender } = require('../services/email/senderIdentity');
const { getSchoolName } = require('../utils/schoolUtils');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--school') out.school = next();
    else if (a === '--report') out.report = next();
    else if (a === '--preview-to') out.previewTo = next();
    else if (a === '--preview-file') out.previewFile = next();
    else if (a === '--preview-student') out.previewStudent = next();
    else if (a === '--portal-url') out.portalUrl = next();
    else if (a === '--send') out.send = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

// The (publish, student) pairs whose family was never emailed.
const MISSED_PAIRS = `
  WITH b AS (
    SELECT pb.batch_id, pb.class_id, pb.school, pb.created_at, pb.assessment_ids, pb.triggered_by,
           ARRAY(SELECT DISTINCT a.parent_assessment_id FROM assessments a WHERE a.assessment_id = ANY(pb.assessment_ids)) AS parent_ids,
           (SELECT COUNT(*) FROM class_students cs JOIN students s ON s.student_id = cs.student_id AND s.is_archived = FALSE
             WHERE cs.class_id = pb.class_id) * cardinality(pb.assessment_ids) - pb.student_warning_count AS graded_cells_then
    FROM assessment_publication_batches pb
    WHERE pb.action = 'publish'
      AND ($1::text IS NULL OR pb.school::text = $1)
      AND (SELECT bool_and(a.parent_assessment_id IS NOT NULL) FROM assessments a WHERE a.assessment_id = ANY(pb.assessment_ids))
      AND NOT EXISTS (SELECT 1 FROM assessment_publication_emails e
                      WHERE e.batch_id = pb.batch_id AND e.sent_at < pb.created_at + INTERVAL '1 hour')
  )
  SELECT DISTINCT b.batch_id, b.class_id, b.school::text AS school, b.assessment_ids, b.triggered_by, sa.student_id
  FROM b
  JOIN student_assessments sa ON sa.assessment_id = ANY(b.assessment_ids)
  JOIN students s ON s.student_id = sa.student_id AND s.is_archived = FALSE
  WHERE b.graded_cells_then > 0
    AND (sa.score IS NOT NULL OR sa.status = 'missing')
    AND NOT EXISTS (SELECT 1 FROM assessment_publication_emails e
                    WHERE e.student_id = sa.student_id AND e.status = 'sent' AND e.sent_at >= b.created_at
                      AND (e.assessment_ids && b.assessment_ids OR e.assessment_ids && b.parent_ids))
`;

async function loadClasses(classIds) {
  const { rows } = await db.query(
    `SELECT class_id, grade::text AS grade, subject FROM classes WHERE class_id = ANY($1::uuid[])`, [classIds]);
  // Sections run by grade, then subject.
  rows.sort((x, y) => (Number(x.grade) || 0) - (Number(y.grade) || 0) || String(x.subject).localeCompare(String(y.subject)));
  const classes = new Map();
  for (const c of rows) {
    const [{ rows: allAssessments }, { rows: scoreRows }] = await Promise.all([
      db.query(publishQueries.selectAllAssessmentsInClass, [c.class_id]),
      db.query(publishQueries.selectClassScoreRows, [c.class_id]),
    ]);
    classes.set(c.class_id, {
      className: c.subject, label: `Gr ${c.grade} ${c.subject}`, allAssessments, scoreRowsByStudent: groupScoreRowsByStudent(scoreRows),
    });
  }
  return classes;
}

function printSummary(plans, classes, recipientsByStudent) {
  const perClass = new Map();
  for (const p of plans) {
    for (const c of p.classes) perClass.set(c.classId, (perClass.get(c.classId) || 0) + 1);
  }
  console.log('\nStudents per class (one email per student covers all of their classes):');
  for (const [classId, cls] of classes) {
    if (perClass.has(classId)) console.log(`  ${cls.label.padEnd(44)} ${perClass.get(classId)}`);
  }
  const withEmail = plans.filter((p) => recipientsByStudent.get(p.studentId)?.length > 0);
  const addresses = new Set(withEmail.flatMap((p) => recipientsByStudent.get(p.studentId)));
  console.log(`\nStudents: ${plans.length}   emails to send: ${withEmail.length}   no address on file: ${plans.length - withEmail.length}   addresses: ${addresses.size}`);
}

function renderPlan(plan, { schoolName, schoolInfo, portalUrl }) {
  return {
    subject: `${plan.studentName} — New Grades Posted`,
    html: getGradesDigestEmailHTML({
      studentName: plan.studentName,
      classes: plan.classes.map((c) => ({ className: c.className, assessments: c.lines, runningGradeLabel: c.runningGradeLabel })),
      schoolName, schoolInfo, portalUrl,
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 21).join('\n'));
    return;
  }
  const portalBase = args.portalUrl || process.env.FRONTEND_URL || '';
  if ((args.send || args.previewTo || args.previewFile) && (!/^https:\/\//.test(portalBase) || /localhost|127\.0\.0\.1/.test(portalBase))) {
    throw new Error(`The parent portal link would be "${portalBase}". Pass --portal-url https://<the live site>.`);
  }
  console.log(`Database: ${String(process.env.PG_HOST || '').replace(/^[^.]*/, '***')}   mode: ${args.send ? 'SEND' : args.previewTo ? 'preview' : 'dry run'}`);

  const { rows: missed } = await db.query(MISSED_PAIRS, [args.school || null]);
  const pairs = missed.map((r) => ({
    batchId: r.batch_id, classId: r.class_id, studentId: r.student_id, assessmentIds: r.assessment_ids, triggeredBy: r.triggered_by, school: r.school,
  }));
  const schools = [...new Set(pairs.map((p) => p.school))];
  if (schools.length > 1) throw new Error(`Run one school at a time (--school): ${schools.join(', ')}`);
  console.log(`Missed (publish, student) pairs: ${pairs.length}`);
  if (pairs.length === 0) return;
  const school = schools[0];

  const classes = await loadClasses([...new Set(pairs.map((p) => p.classId))]);
  const plans = planCatchUp({ pairs, classes });
  const recipients = await resolveRecipients(plans.map((p) => ({ studentId: p.studentId })));
  const recipientsByStudent = new Map(recipients.map((r) => [r.studentId, r.emails]));
  printSummary(plans, classes, recipientsByStudent);

  const { schoolInfo } = await loadEmailContext(plans[0].classes[0].classId, school);
  const ctx = { schoolName: getSchoolName(school), schoolInfo, portalUrl: `${portalBase.replace(/\/$/, '')}/parent/grades` };

  if (args.report) {
    const detail = plans.map((p) => ({ ...p, emails: recipientsByStudent.get(p.studentId) || [], subject: renderPlan(p, ctx).subject }));
    require('fs').writeFileSync(args.report, JSON.stringify(detail, null, 2));
    console.log(`Full plan written to ${args.report}`);
  }

  const resend = getResend();
  const sender = schoolSender({ school, schoolInfo, role: 'academics' });

  if (args.previewTo || args.previewFile) {
    const plan = plans.find((p) => p.studentId === args.previewStudent)
      || [...plans].sort((a, b) => b.classes.length - a.classes.length)[0];
    const { subject, html } = renderPlan(plan, ctx);
    const what = `${plan.classes.length} classes (${plan.classes.map((c) => c.className).join(', ')})`;
    if (args.previewFile) {
      require('fs').writeFileSync(args.previewFile, html);
      console.log(`Sample written to ${args.previewFile}: "${subject}", ${what}`);
    }
    if (args.previewTo) {
      const result = await resend.emails.send({ ...sender, to: [args.previewTo], subject: `[Preview] ${subject}`, html });
      if (result.error) throw new Error(result.error.message || 'The preview did not send');
      console.log(`Preview sent to ${args.previewTo}: ${what}`);
    }
  }

  if (!args.send) return;
  const summary = { sent: 0, failed: 0, noAddress: 0 };
  for (const [index, plan] of plans.entries()) {
    const emails = recipientsByStudent.get(plan.studentId) || [];
    if (emails.length === 0) { summary.noAddress += 1; continue; }
    const { subject, html } = renderPlan(plan, ctx);
    let status = 'sent';
    let error = null;
    try {
      const result = await resend.emails.send({ ...sender, to: emails, subject, html });
      if (result.error) throw new Error(result.error.message || 'Email sending failed');
      summary.sent += 1;
    } catch (err) {
      status = 'failed';
      error = err.message;
      summary.failed += 1;
      console.error(`Failed for student ${plan.studentId}: ${err.message}`);
    }
    // Logged against each original publish, as that publish's email would have been.
    for (const section of plan.classes) {
      for (const a of section.audit) {
        await db.query(publishQueries.insertPublicationEmail, [
          a.batchId, plan.studentId, a.triggeredBy, JSON.stringify(emails), a.assessmentIds, school, status, error]);
      }
    }
    if (index < plans.length - 1) await sleep(EMAIL_RATE_LIMIT_MS);
  }
  console.log(`\nSent: ${summary.sent}   failed: ${summary.failed}   no address on file: ${summary.noAddress}`);
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(async () => {
    await db.end().catch(() => {});
    process.exit(); // nothing else should keep a one-off alive
  });
