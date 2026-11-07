#!/bin/bash
# The backend for end-to-end runs: the e2e database, the fake storage server,
# no email. Values set here win over .env (dotenv never overrides), so it can't
# reach the production database or bucket.
#   node scripts/e2e/fake-storage.js 54329 &   then   bash scripts/e2e/start-backend.sh
cd "$(dirname "$0")/../.."
export PORT=${E2E_API_PORT:-4310} PG_HOST=localhost PG_PORT=${E2E_PG_PORT:-5433} PG_USER=test_user PG_PASSWORD=test_password PG_DATABASE=schoolmule_e2e
export PG_SSL_DISABLE=true PG_POOL_MAX=4 SUPABASE_URL=http://127.0.0.1:${E2E_STORAGE_PORT:-54329} RESEND_API_KEY=
export CROSS_ORIGIN_URL=${E2E_WEB_URL:-http://localhost:3310} REPORT_ENGINE=${REPORT_ENGINE:-new} ALERTS_ENABLED=false
# Generate queues runs; this server prints them (services/reportGeneration/worker.js).
export REPORT_GENERATION_WORKER=${REPORT_GENERATION_WORKER:-true}
exec node server.js
