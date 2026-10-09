// pino only serialises an Error when it is the first argument or sits under
// `err` in the first object. 175 call sites here write
// logger.error('Something failed:', error), which pino treats as a format
// argument and silently drops, so the stack never reaches the logs or the
// Observe console. This hook lifts such a failure into `err`.
//
// "Failure" also covers the non-Error shapes this codebase throws or
// receives: { status, message } verdicts and Supabase's { error: { message } }
// results. Those are wrapped in an Error (original kept as `cause`) so they
// get a message and a stack pointing at the log call.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function asError(value) {
  if (value instanceof Error) return value;
  if (!isPlainObject(value)) return null;
  const inner = isPlainObject(value.error) ? value.error : null;
  const message = typeof value.message === 'string' ? value.message : inner && typeof inner.message === 'string' ? inner.message : null;
  if (message === null) return null;
  const err = new Error(message);
  err.cause = inner || value;
  if (value.status !== undefined) err.status = value.status;
  return err;
}

function normalizeLogArgs(inputArgs) {
  const args = Array.from(inputArgs);
  if (args.length < 2) return args;
  const first = args[0];
  if (first instanceof Error) return args;

  let err = null;
  let errIndex = -1;
  for (let i = 1; i < args.length; i++) {
    const e = asError(args[i]);
    if (e) {
      err = e;
      errIndex = i;
      break;
    }
  }
  if (errIndex === -1) return args;
  const rest = args.filter((_, i) => i !== errIndex);

  if (typeof first === 'string') return [{ err }, ...rest];
  if (isPlainObject(first)) {
    if (first.err !== undefined) return rest;
    return [{ ...first, err }, ...rest.slice(1)];
  }
  return args;
}

module.exports = { normalizeLogArgs, asError };
