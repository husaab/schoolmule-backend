// worker_threads shim: runs the pure solver off the main event loop.
// Input arrives via workerData; exactly one message is posted back.

const { parentPort, workerData } = require('node:worker_threads');
const { generateSchedules, SolverInputError } = require('./index');

try {
  parentPort.postMessage(generateSchedules(workerData));
} catch (err) {
  parentPort.postMessage({
    ok: false,
    phase: err instanceof SolverInputError ? 'input' : 'internal',
    diagnostics: [{ code: err.code || 'SOLVER_ERROR', message: err.message }],
    partial: null,
    meta: null,
  });
}
