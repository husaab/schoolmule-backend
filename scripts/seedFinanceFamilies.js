#!/usr/bin/env node
// scripts/seedFinanceFamilies.js
//
// One-off: load the billing roster and customer map into the family tables.
//
//   node scripts/seedFinanceFamilies.js --school ALHAADIACADEMY --year 2026-2027 \
//     --roster ../quickbooks/Year2026-2027/roster-2026-2027.json \
//     --map    ../quickbooks/Year2026-2027/customer-map-2026-2027.csv \
//     [--apply] [--accept-near "24:Mariam Salman=<student uuid>" ...] [--actor <user uuid>]
//
// Dry-run by default: the plan is written inside a transaction and rolled
// back, so the SQL is exercised without leaving anything behind. --apply commits.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { acceptNear: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--school') out.school = next();
    else if (a === '--year') out.year = next();
    else if (a === '--roster') out.roster = next();
    else if (a === '--map') out.map = next();
    else if (a === '--actor') out.actor = next();
    else if (a === '--apply') out.apply = true;
    else if (a === '--accept-near') {
      const [key, id] = String(next()).split('=');
      out.acceptNear[key] = id;
    } else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printTable(title, rows, cols) {
  if (!rows.length) return;
  console.log(`\n${title} (${rows.length})`);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (r) => cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  ');
  console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  for (const r of rows) console.log(line(r));
}

function printPlan(plan, studentCount, school, year) {
  console.log(`\nSeed plan for ${school} ${year}: ${plan.counts.families} families, ${studentCount} students in the year`);
  console.log(`  exact matches: ${plan.counts.exact}   accepted near: ${plan.counts.nearAccepted}   near (needs a decision): ${plan.counts.near}   unmatched: ${plan.counts.unmatched}   conflicts: ${plan.counts.conflicts}   contacts: ${plan.counts.contacts}`);
  console.log(`  create: ${plan.families.filter((f) => f.action === 'create').length}   update: ${plan.families.filter((f) => f.action === 'update').length}   customer changes: ${plan.families.filter((f) => f.previousCustomerId).length}`);
  printTable('Near matches — re-run with --accept-near "<family>:<child>=<student_id>" to link', plan.near.map((n) => ({
    family: n.familyNo, child: `${n.child} (${n.grade})`, candidates: n.candidates.map((c) => `${c.name} (${c.grade}) ${c.studentId}`).join(' | '),
  })), ['family', 'child', 'candidates']);
  printTable('Unmatched children', plan.unmatched.map((u) => ({ family: u.familyNo, child: `${u.child} (${u.grade})` })), ['family', 'child']);
  printTable('Conflicts (student already in another family)', plan.conflicts.map((c) => ({ family: c.familyNo, child: c.child, heldBy: c.familyId })), ['family', 'child', 'heldBy']);
  printTable('Errors', plan.errors.map((e) => ({ error: e })), ['error']);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.school || !args.year || !args.roster || !args.map) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(args.help ? 0 : 1);
  }

  const db = require('../config/database');
  const queries = require('../queries/finance.queries');
  const { planSeed, applySeed } = require('../services/finance/familySeed');
  const { resolveSettings } = require('../services/finance/classify');

  const roster = JSON.parse(fs.readFileSync(path.resolve(args.roster), 'utf8'));
  const customerMap = fs.readFileSync(path.resolve(args.map), 'utf8');

  const { rows: years } = await db.query(queries.selectYearByLabel, [args.school, args.year]);
  if (!years[0]) throw new Error(`No school year "${args.year}" for ${args.school}`);
  const year = years[0];

  const { rows: students } = await db.query(queries.selectStudentsForSeed, [args.school, year.school_year_id]);
  if (students.length === 0) throw new Error(`School year ${args.year} has no active students; roll the year over first`);

  const { rows: existingFamilies } = await db.query(queries.selectFamiliesWithCurrentCustomer, [args.school, year.school_year_id]);
  const { rows: assignmentRows } = await db.query(queries.selectAssignmentsByYear, [args.school, year.school_year_id]);
  const existingAssignments = Object.fromEntries(assignmentRows.map((r) => [r.student_id, r.family_id]));
  const { rows: conn } = await db.query(queries.selectConnection, [args.school]);
  const settings = resolveSettings(conn[0]?.settings || {});

  const plan = planSeed({ roster, customerMap, students, existingFamilies, existingAssignments, acceptNear: args.acceptNear });
  printPlan(plan, students.length, args.school, args.year);

  if (plan.errors.length) {
    console.error('\nFix the errors above before applying.');
    process.exit(2);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const summary = await applySeed(client, {
      school: args.school, schoolYearId: year.school_year_id, actorUserId: args.actor || null, plan, backfillSince: settings.backfillSince,
    });
    console.log('\nWrite summary:', JSON.stringify({ ...summary, conflicts: summary.conflicts.length, skipped: summary.skipped.length }));
    printTable('Write conflicts', summary.conflicts, ['familyNo', 'studentId', 'familyId']);
    printTable('Skipped', summary.skipped, ['familyNo', 'studentId', 'reason']);
    if (args.apply) {
      await client.query('COMMIT');
      console.log('\nApplied.');
    } else {
      await client.query('ROLLBACK');
      console.log('\nDry run — rolled back. Re-run with --apply to write.');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (typeof db.end === 'function') await db.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nseed failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, printPlan };
