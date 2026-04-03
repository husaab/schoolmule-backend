const pino = require("pino");

const isProduction = process.env.NODE_ENV === "production";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",

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
    ],
    censor: "[REDACTED]",
  },

});

module.exports = logger;
