// Spawns the solver worker for one generate request. The solver enforces its
// own time budget internally; the timer here is only a backstop against a
// hung or crashed worker (budget + grace).

const { Worker } = require('node:worker_threads');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'worker.js');
const DEFAULT_BUDGET_MS = 10000;
const GRACE_MS = 1000;

function runSolverInWorker(input) {
  const requested = input && input.config ? input.config.timeBudgetMs : undefined;
  const budgetMs = Math.min(Math.max(Number(requested) || DEFAULT_BUDGET_MS, 500), 180000);

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => {
      const err = new Error('Schedule solver exceeded its time limit');
      err.code = 'SOLVER_HARD_TIMEOUT';
      finish(reject, err);
    }, budgetMs + GRACE_MS);
    worker.once('message', (msg) => finish(resolve, msg));
    worker.once('error', (err) => finish(reject, err));
    worker.once('exit', (code) => {
      if (code !== 0) finish(reject, new Error(`Solver worker exited with code ${code}`));
    });
  });
}

module.exports = { runSolverInWorker };
