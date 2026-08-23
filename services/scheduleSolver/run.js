// Spawns solver workers for one generate request. Runs a small PORTFOLIO of
// parallel workers racing the same instance from different seeds — restarts
// are memoryless, so N workers multiply the effective search time by N. The
// first success wins and the rest are terminated; if all fail, the most
// informative failure is returned.
//
// Each worker enforces its own time budget internally; the timer here is only
// a backstop against a hung or crashed worker (budget + grace).

const { Worker } = require('node:worker_threads');
const os = require('node:os');
const path = require('path');
const logger = require('../../logger');

const WORKER_PATH = path.join(__dirname, 'worker.js');
const DEFAULT_BUDGET_MS = 10000;
const GRACE_MS = 1000;
// Extra wall-clock allowance on the HTTP call: the CP-SAT service enforces the
// same budget internally, so this only catches a hung or unreachable service.
const HTTP_GRACE_MS = 5000;
// Weyl-sequence increment: spreads derived seeds across the 32-bit space.
const SEED_STRIDE = 0x9e3779b9;

// Capped low — each worker saturates one core, and the API server needs
// headroom. SOLVER_PARALLEL=1 restores the old single-worker behavior.
function portfolioSize() {
  const env = Number(process.env.SOLVER_PARALLEL);
  if (Number.isInteger(env) && env >= 1) return Math.min(env, 8);
  const cores =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, cores - 1));
}

// One worker; returns { promise, cancel }. The promise resolves with the
// solver result or rejects on crash/hang. cancel() terminates early.
function spawnOne(input, budgetMs) {
  let worker = null;
  let done = false;
  let timer = null;
  const promise = new Promise((resolve, reject) => {
    worker = new Worker(WORKER_PATH, {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    timer = setTimeout(() => {
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
  const cancel = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    worker.terminate().catch(() => {});
  };
  return { promise, cancel };
}

// Prefer the failure with the most actionable detail: a search failure (has
// partial placements + the deepest dead-end) over preSolve/input failures,
// which are identical across workers anyway.
function betterFailure(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.phase === 'search' && b.phase !== 'search') return a;
  if (b.phase === 'search' && a.phase !== 'search') return b;
  return a;
}

// CP-SAT spends its whole budget productively (no memoryless restarts), so a
// deployment can raise the floor without changing the request contract.
function serviceBudget(budgetMs) {
  const floor = Number(process.env.SOLVER_MIN_BUDGET_MS);
  if (!Number.isFinite(floor) || floor <= 0) return budgetMs;
  return Math.min(Math.max(budgetMs, floor), 180000);
}

// POST the identical solver input to the CP-SAT service and return its envelope
// verbatim — it is built to the same shape generateSchedules() produces.
async function solveViaService(input, budgetMs) {
  const base = process.env.SOLVER_URL.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs + HTTP_GRACE_MS);
  try {
    const res = await fetch(`${base}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, config: { ...input.config, timeBudgetMs: budgetMs } }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Solver service responded ${res.status}`);
    const body = await res.json();
    if (!body || typeof body.ok !== 'boolean') {
      throw new Error('Solver service returned an unexpected payload');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function runSolverInWorker(input) {
  const requested = input && input.config ? input.config.timeBudgetMs : undefined;
  const budgetMs = Math.min(Math.max(Number(requested) || DEFAULT_BUDGET_MS, 500), 180000);

  // The JS portfolio stays the fallback: any transport or service failure drops
  // straight back to it rather than failing the request.
  if (process.env.SOLVER_URL) {
    return solveViaService(input, serviceBudget(budgetMs)).catch((err) => {
      logger.warn({ err }, 'CP-SAT solver service unavailable; falling back to the in-process solver');
      return runJsPortfolio(input, budgetMs);
    });
  }
  return runJsPortfolio(input, budgetMs);
}

function runJsPortfolio(input, budgetMs) {
  const n = portfolioSize();
  const rawSeed = input && input.config ? Number(input.config.seed) : NaN;
  const baseSeed = Number.isFinite(rawSeed) ? rawSeed >>> 0 : (Math.random() * 0xffffffff) >>> 0;

  const runs = [];
  for (let i = 0; i < n; i++) {
    // Worker 0 keeps the caller's exact seed so single-worker runs stay
    // reproducible; the rest fan out across the seed space.
    const seed = (baseSeed + i * SEED_STRIDE) >>> 0;
    runs.push(
      spawnOne({ ...input, config: { ...input.config, seed, timeBudgetMs: budgetMs } }, budgetMs)
    );
  }

  return new Promise((resolve, reject) => {
    let pending = n;
    let settled = false;
    let bestFailure = null;
    let lastError = null;
    for (const run of runs) {
      run.promise
        .then((result) => {
          if (settled) return;
          if (result && result.ok) {
            settled = true;
            for (const other of runs) if (other !== run) other.cancel();
            resolve(result);
            return;
          }
          bestFailure = betterFailure(bestFailure, result);
        })
        .catch((err) => {
          if (settled) return;
          lastError = err;
        })
        .finally(() => {
          if (settled) return;
          pending--;
          if (pending === 0) {
            settled = true;
            if (bestFailure) resolve(bestFailure);
            else reject(lastError || new Error('All solver workers failed'));
          }
        });
    }
  });
}

module.exports = { runSolverInWorker };
