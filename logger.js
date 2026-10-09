const pino = require("pino");
const { Writable } = require("stream");
const { normalizeLogArgs } = require("./utils/logArgs");

// Every line at error or above is also handed to the observe mirror, which
// writes it to error_events. Required lazily inside write() so logger.js
// stays dependency-free at load (the mirror's buffer requires the db, which
// requires this logger).
const mirror = new Writable({
  write(chunk, _encoding, callback) {
    try {
      require("./services/observe/logMirror").onLogLine(chunk.toString());
    } catch {
      // never let observability break logging
    }
    callback();
  },
});

const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",

    hooks: {
      // logger.error('msg:', error) keeps its stack (see utils/logArgs.js).
      logMethod(inputArgs, method) {
        return method.apply(this, normalizeLogArgs(inputArgs));
      },
    },

    formatters: {
      level(label) {
        return { level: label };
      },
    },

    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },

    // Most catch blocks call logger.error('Doing x:', error). To pino that
    // second argument is a printf interpolation value, and with no %s in the
    // message it is silently dropped: the line reads "Doing x:" and nothing
    // else, which is how a production 500 can leave no trace of its cause.
    // Move a trailing error (or any object) into the err key so the stack
    // reaches stdout and the observe mirror.
    hooks: {
      logMethod(args, method) {
        if (
          args.length >= 2 &&
          typeof args[0] === "string" &&
          args[1] !== null &&
          typeof args[1] === "object" &&
          !/%[sdjoO]/.test(args[0])
        ) {
          const [msg, err, ...rest] = args;
          return method.apply(this, [{ err }, msg, ...rest]);
        }
        return method.apply(this, args);
      },
    },

    redact: {
      paths: [
        "password",
        "newPassword",
        "req.headers.authorization",
        "req.body.password",
        "req.body.newPassword",
        // Integration credentials must never reach the logs.
        "refresh_token",
        "access_token",
        "refreshToken",
        "accessToken",
        "*.refresh_token",
        "*.access_token",
      ],
      censor: "[REDACTED]",
    },
  },
  pino.multistream(
    [
      { level: "trace", stream: process.stdout },
      { level: "error", stream: mirror },
    ],
    { dedupe: false }
  )
);

module.exports = logger;
