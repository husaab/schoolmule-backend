// pino only serialises an Error when it is the first argument or sits under
// `err` in the first object. 175 call sites here write
// logger.error('Something failed:', error), which pino treats as a format
// argument and silently drops, so the stack never reaches the logs or the
// Observe console. This hook lifts such an Error into `err`.
function normalizeLogArgs(inputArgs) {
  const args = Array.from(inputArgs);
  if (args.length < 2) return args;
  const first = args[0];
  if (first instanceof Error) return args;

  const errIndex = args.findIndex((a, i) => i > 0 && a instanceof Error);
  if (errIndex === -1) return args;
  const err = args[errIndex];
  const rest = args.filter((_, i) => i !== errIndex);

  if (typeof first === 'string') return [{ err }, ...rest];
  if (first && typeof first === 'object') {
    if (first.err !== undefined) return rest;
    return [{ ...first, err }, ...rest.slice(1)];
  }
  return args;
}

module.exports = { normalizeLogArgs };
