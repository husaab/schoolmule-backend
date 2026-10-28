// Every await in the alert worker is bounded: a hung email send or database
// call must not freeze the tick that would report the outage.
class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms / 1000} s`);
    this.name = 'TimeoutError';
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout, TimeoutError };
