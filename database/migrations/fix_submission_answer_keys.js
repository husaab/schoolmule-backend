/**
 * One-time migration: Remap orphaned UUID keys in submission answers
 * to match current field definitions.
 *
 * The bug: upsertFields used to DELETE all fields + INSERT new ones,
 * generating new UUIDs each time. Submissions stored under the OLD UUIDs
 * became unreadable. This script remaps old keys → current keys.
 *
 * Affected: "New Students 2026-2027" form (765819b9) — 8 of 10 submissions.
 * The "Returning Students" form (b6b75cb5) is unaffected — all 42 submissions
 * already use the current field UUIDs.
 *
 * Mapping was built by comparing old submission values against current field
 * definitions (labels + types) from the registration_form_fields export.
 *
 * Usage:  node database/migrations/fix_submission_answer_keys.js [--dry-run]
 */

const { Pool } = require('pg');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  port: process.env.PG_PORT,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  ssl: { rejectUnauthorized: false },
});

// ─── Exact mapping: old field UUID → current field UUID ──────────────
// Built by matching value patterns across 8 broken submissions against
// current field definitions (label + type).
//
// Form: "Al Haadi Academy Registration Form For New Students 2026-2027"
// form_id: 765819b9-151f-468b-8cd0-0c32d95f5cf7

const KEY_MAPPING = {
  // old UUID                                → current UUID                           (field label)
  '8235a70d-18f1-41e8-9c40-66daa13d3843': 'c13bf091-a33c-4214-b3dc-00d687460626', // Email
  '82fafa53-dcc7-4102-b50c-f4323b1338c7': '62e82959-01d3-43af-960d-b7f052ef18f5', // Name of student
  '54372d5b-9d43-4441-b559-4c15aa280b33': 'f67b0c39-110d-4619-b8d8-afa6d8b3dce5', // Which grade
  '86baac92-852b-475c-89d2-5dc13e8d0590': 'b8befeaf-2385-4bf6-99ce-53d122726631', // Date of birth
  '6df7f558-30ee-4546-af8a-64295102608f': '928f2cc4-e8e5-4ed0-8d6a-88b36b174c7d', // Last school attended
  '8b434c3c-bf3d-49b6-a0c2-a8e5819a3f47': '97634efc-d6c3-4506-8aa2-d3007b74889b', // Health card number
  'd2ee48b2-899e-41f8-a0b4-55dbc3331b79': '92a4e7f7-fef1-4b46-a9a4-9e1923a188ec', // Parent/Guardian full name
  'facbaeb0-1ace-454b-b85e-8d4d9d258fe9': '0b2c15d1-7cc1-4cae-a20f-34e271df3ebf', // Parent/Guardian phone
  '8a7e2d24-9d8a-4b77-959d-26b4210d32a2': '812261e5-d39f-4aaf-8aa6-120bf76d7979', // Parents' email address
  'f6f7ea90-3abf-4eb5-95ae-bfbf7588eed6': '2e351b8e-70cc-4506-bd07-cfa9a42458fe', // Residential address
  'f26cb3ef-a126-4ba8-91fc-18a1b3023d3a': '7e494f75-e809-413f-8210-9dfd4aa0bd2a', // Medical conditions
  '3d69d668-0d27-4a2e-ad01-17319b60b10f': '4d3e0eaa-ca16-4431-8103-c3cbd72a25e6', // Emergency contact
};

const AFFECTED_FORM_ID = '765819b9-151f-468b-8cd0-0c32d95f5cf7';
const OLD_KEYS = new Set(Object.keys(KEY_MAPPING));

// ─── Main migration ──────────────────────────────────────────────────

async function migrate() {
  const client = await pool.connect();
  try {
    // Verify the current fields still match what we expect
    const { rows: currentFields } = await client.query(
      'SELECT field_id FROM registration_form_fields WHERE form_id = $1',
      [AFFECTED_FORM_ID]
    );
    const currentIds = new Set(currentFields.map(f => f.field_id));
    const expectedCurrentIds = new Set(Object.values(KEY_MAPPING));

    for (const id of expectedCurrentIds) {
      if (!currentIds.has(id)) {
        console.error(`ERROR: Expected current field ${id} not found in database.`);
        console.error('The form fields may have been saved again since the mapping was built.');
        console.error('Aborting — no changes made.');
        process.exit(1);
      }
    }
    console.log('✓ All target field IDs verified in database\n');

    // Get submissions that need remapping
    const { rows: submissions } = await client.query(
      'SELECT submission_id, answers FROM registration_form_submissions WHERE form_id = $1',
      [AFFECTED_FORM_ID]
    );

    const toUpdate = [];
    let alreadyCurrent = 0;

    for (const sub of submissions) {
      const answers = typeof sub.answers === 'string' ? JSON.parse(sub.answers) : sub.answers;
      const keys = Object.keys(answers);

      // Check if this submission uses old keys
      const hasOldKeys = keys.some(k => OLD_KEYS.has(k));
      const hasCurrentKeys = keys.some(k => currentIds.has(k));

      if (hasCurrentKeys && !hasOldKeys) {
        alreadyCurrent++;
        continue;
      }

      if (hasOldKeys) {
        // Remap the answers
        const newAnswers = {};
        for (const [key, val] of Object.entries(answers)) {
          const newKey = KEY_MAPPING[key];
          if (newKey) {
            newAnswers[newKey] = val;
          } else {
            // Key not in mapping — keep it as-is (shouldn't happen but safe)
            console.warn(`  WARNING: Unknown key ${key} in submission ${sub.submission_id} — keeping as-is`);
            newAnswers[key] = val;
          }
        }
        toUpdate.push({ submissionId: sub.submission_id, newAnswers });
      }
    }

    console.log(`Total submissions for this form: ${submissions.length}`);
    console.log(`Already using current keys: ${alreadyCurrent}`);
    console.log(`Need remapping: ${toUpdate.length}`);
    console.log();

    if (toUpdate.length === 0) {
      console.log('Nothing to do — all submissions are up to date.');
      return;
    }

    // Show what will change
    for (const item of toUpdate) {
      console.log(`  ${item.submissionId}: remapping ${Object.keys(item.newAnswers).length} fields`);
    }
    console.log();

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would update ${toUpdate.length} submissions. Run without --dry-run to apply.`);
      return;
    }

    // Apply updates in a single transaction
    await client.query('BEGIN');
    for (const item of toUpdate) {
      await client.query(
        'UPDATE registration_form_submissions SET answers = $1 WHERE submission_id = $2',
        [JSON.stringify(item.newAnswers), item.submissionId]
      );
    }
    await client.query('COMMIT');

    console.log(`✓ Updated ${toUpdate.length} submissions successfully.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
