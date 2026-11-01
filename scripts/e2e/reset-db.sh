#!/bin/bash
# Restore schoolmule_e2e from the snapshot setup-db.sh made. Stop the e2e
# backend first: dropping the database ends its connections, and the pool
# exits on a dropped connection by design.
set -euo pipefail
C=${E2E_DB_CONTAINER:-schoolmule-backend-test-db-1}
docker exec "$C" psql -U test_user -d schoolmule_test -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='schoolmule_e2e' AND pid<>pg_backend_pid()" >/dev/null
docker exec "$C" dropdb -U test_user --if-exists schoolmule_e2e
docker exec "$C" createdb -U test_user schoolmule_e2e
docker exec "$C" pg_restore -U test_user -d schoolmule_e2e /tmp/schoolmule_e2e.dump
echo "schoolmule_e2e restored"
