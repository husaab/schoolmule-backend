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
