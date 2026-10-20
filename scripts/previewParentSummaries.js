#!/usr/bin/env node
// scripts/previewParentSummaries.js
//
// Builds every parent's weekly summary for a school as it would go out now,
// without sending or recording anything (classroomNotifier.previewSummary):
// how many families would get one, and a few saved as HTML to look at.
//
//   node --env-file=<backend .env> scripts/previewParentSummaries.js --school ALHAADIACADEMY
//     --portal-url https://<the live site>    the links in the emails
//     --out <dir>                              where the samples go
//     [--samples 2]                            samples per kind of recipient
//
// Kinds: a parent account; an address on a guardian record with no account;
// a mother/father address on the student record (no guardian record).

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { samples: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--school') out.school = next();
    else if (a === '--portal-url') out.portalUrl = next();
    else if (a === '--out') out.out = next();
    else if (a === '--samples') out.samples = Number(next());
    else throw new Error(`Unknown option ${a}`);
  }
  if (!out.school || !out.portalUrl || !out.out) throw new Error('Pass --school, --portal-url and --out');
  return out;
}

// This year's student rows (rows are per school year), as the real send reads them.
const THIS_YEAR = `s.school_year_id IS NOT DISTINCT FROM (SELECT y.school_year_id FROM school_years y WHERE y.school = s.school AND y.is_active LIMIT 1)`;

// The summary's recipients as enqueueSummaries finds them, whatever the day and the parents' choices.
const RECIPIENTS = `
  SELECT DISTINCT ON (r.email) r.email, r.user_id, r.kind
  FROM (
    SELECT LOWER(TRIM(gu.email)) AS email, gu.user_id, 'account' AS kind
    FROM parent_students ps
    JOIN students s ON s.student_id = ps.student_id AND s.is_archived IS NOT TRUE
    JOIN users gu ON gu.user_id = ps.parent_id AND gu.is_archived IS NOT TRUE AND gu.password <> '!' AND TRIM(COALESCE(gu.email, '')) <> ''
    WHERE s.school::text = $1 AND ${THIS_YEAR}
    UNION ALL
    SELECT LOWER(TRIM(COALESCE(NULLIF(TRIM(u.email), ''), ps.parent_email, ''))), NULL::uuid, 'guardian record, no account'
    FROM parent_students ps
    JOIN students s ON s.student_id = ps.student_id AND s.is_archived IS NOT TRUE
    LEFT JOIN users u ON u.user_id = ps.parent_id
    WHERE s.school::text = $1 AND ${THIS_YEAR} AND (ps.parent_id IS NULL OR (u.password = '!' AND u.is_archived IS NOT TRUE))
    UNION ALL
    SELECT LOWER(TRIM(home.email)), NULL::uuid, 'mother/father email'
    FROM students s CROSS JOIN LATERAL (VALUES (s.mother_email), (s.father_email)) AS home(email)
    WHERE s.school::text = $1 AND s.is_archived IS NOT TRUE AND ${THIS_YEAR}
      AND NOT EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = s.student_id)
  ) r
  WHERE r.email <> ''
  ORDER BY r.email, r.user_id NULLS LAST`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.env.FRONTEND_URL = args.portalUrl.replace(/\/$/, '');
  const db = require('../config/database');
  const { previewSummary } = require('../services/classroom/classroomNotifier');
  try {
    fs.mkdirSync(args.out, { recursive: true });
    const { rows } = await db.query(RECIPIENTS, [args.school]);
    const tally = {};
    const saved = {};
    for (const r of rows) {
      const t = (tally[r.kind] = tally[r.kind] || { recipients: 0, withSummary: 0, nothingToReport: 0 });
      t.recipients += 1;
      const res = await previewSummary({ school: args.school, email: r.email, userId: r.user_id });
      if (res.skip) { t.nothingToReport += 1; continue; }
      t.withSummary += 1;
      saved[r.kind] = saved[r.kind] || 0;
      if (saved[r.kind] < args.samples) {
        saved[r.kind] += 1;
        const file = path.join(args.out, `${r.kind.replace(/[^a-z]+/g, '-')}-${saved[r.kind]}.html`);
        fs.writeFileSync(file, res.html);
        console.log(`sample: ${path.basename(file)}  "${res.subject}"`);
      }
    }
    console.log('\nThis week, if it went out now:');
    for (const [kind, t] of Object.entries(tally)) {
      console.log(`  ${kind.padEnd(30)} ${String(t.recipients).padStart(4)} addresses   ${String(t.withSummary).padStart(4)} would get one   ${String(t.nothingToReport).padStart(4)} nothing to report`);
    }
  } finally {
    await db.end().catch(() => {});
  }
}

main().then(() => process.exit(0), (err) => { console.error(err.message); process.exit(1); });
