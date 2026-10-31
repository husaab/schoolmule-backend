#!/bin/bash
# Build the isolated end-to-end database `schoolmule_e2e` on the docker test
# Postgres (docker-compose.test.yml, host port 5433): the test schema, the
# synthetic PLAYGROUND school from scripts/seed/playground, a fake logo and
# signature, then a snapshot that reset-db.sh restores. Never touches the
# database in .env.
#   bash scripts/e2e/setup-db.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
C=${E2E_DB_CONTAINER:-schoolmule-backend-test-db-1}
STORAGE=${E2E_STORAGE_ROOT:-${TMPDIR:-/tmp}/schoolmule-e2e-storage}
psql_e2e() { docker exec -i "$C" psql -U test_user -d schoolmule_e2e -q -v ON_ERROR_STOP=1 "$@"; }

docker exec "$C" psql -U test_user -d schoolmule_test -q -c "DROP DATABASE IF EXISTS schoolmule_e2e" -c "CREATE DATABASE schoolmule_e2e"
psql_e2e < __tests__/integration/setup/seed.sql 2>&1 | grep -v NOTICE || true
psql_e2e <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- The test schema trails production by a column the seed writes.
ALTER TABLE class_students ADD COLUMN IF NOT EXISTS enrolled_at timestamptz DEFAULT now();
INSERT INTO schools (school_code, name, slug, address, phone, email, timezone)
VALUES ('PLAYGROUND', 'Playground Academy', 'playground', '123 Example Road, Toronto, ON M1M 1M1', '416-555-0100', 'office@playground.test', 'America/Toronto')
ON CONFLICT (school_code) DO NOTHING;
INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
SELECT 'PLAYGROUND', school_id, '2026-2027', '2026-09-01', '2027-06-30', false FROM schools WHERE school_code = 'PLAYGROUND'
ON CONFLICT DO NOTHING;
SQL
# 00_reset deletes from tables the test schema lacks, and a fresh database has
# nothing to reset; 07's registration extras need statuses the test schema
# doesn't seed. Neither matters for the report designer.
for f in 01_foundation 02_gradebook 03_classwork 04_reports 05_comms 06_schedule; do
  echo "seed $f"; psql_e2e < "scripts/seed/playground/sql/$f.sql" 2>&1 | grep -v NOTICE || true
done

mkdir -p "$STORAGE/school-assets/PLAYGROUND"
node -e "
const sharp = require('sharp');
const logo = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"920\" height=\"300\"><g transform=\"translate(20,30)\"><path d=\"M120 10 L220 50 L220 150 C220 210 170 245 120 262 C70 245 20 210 20 150 L20 50 Z\" fill=\"#1f3b73\"/><path d=\"M120 40 L195 70 L195 150 C195 195 160 222 120 236 C80 222 45 195 45 150 L45 70 Z\" fill=\"#fff\"/><path d=\"M78 165 L120 85 L162 165 Z\" fill=\"#e2a52a\"/></g><text x=\"270\" y=\"150\" font-family=\"Arial\" font-weight=\"700\" font-size=\"88\" fill=\"#1f3b73\">PLAYGROUND</text><text x=\"275\" y=\"215\" font-family=\"Arial\" font-size=\"52\" letter-spacing=\"14\" fill=\"#e2a52a\">ACADEMY</text></svg>';
const sig = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"400\" height=\"120\"><path d=\"M20 80 C60 10 80 110 120 60 S180 20 200 70 S260 100 300 40 L360 70\" stroke=\"#1a237e\" stroke-width=\"5\" fill=\"none\" stroke-linecap=\"round\"/></svg>';
Promise.all([
  sharp(Buffer.from(logo)).png().toFile('$STORAGE/school-assets/PLAYGROUND/logo.png'),
  sharp(Buffer.from(sig)).png().toFile('$STORAGE/school-assets/PLAYGROUND/principal_signature.png'),
]).then(() => console.log('assets ok'));
"
psql_e2e -c "INSERT INTO school_assets (school_id, school_code, logo_path, principal_signature_path) SELECT school_id, 'PLAYGROUND', 'PLAYGROUND/logo.png', 'PLAYGROUND/principal_signature.png' FROM schools WHERE school_code='PLAYGROUND' ON CONFLICT (school_id) DO UPDATE SET logo_path = EXCLUDED.logo_path, principal_signature_path = EXCLUDED.principal_signature_path"
docker exec "$C" pg_dump -U test_user -d schoolmule_e2e -Fc -f /tmp/schoolmule_e2e.dump
echo "schoolmule_e2e ready (snapshot saved for reset-db.sh)"
