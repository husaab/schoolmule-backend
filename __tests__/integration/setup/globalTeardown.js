const { execSync } = require('child_process');
const path = require('path');

module.exports = async function globalTeardown() {
  // CI: GitHub Actions manages the service — nothing to do
  if (process.env.CI) return;

  // Locally: keep container running for fast re-runs
  // Only tear down if TEARDOWN_DOCKER is explicitly set
  if (process.env.TEARDOWN_DOCKER) {
    console.log('\n[Integration] Stopping test PostgreSQL container...');
    try {
      execSync('docker compose -f docker-compose.test.yml down -v', {
        cwd: path.resolve(__dirname, '../../..'),
        stdio: 'pipe',
        timeout: 30000,
      });
      console.log('[Integration] Container stopped and cleaned up');
    } catch (err) {
      console.warn('[Integration] Warning: Failed to stop container:', err.message);
    }
  }
};
