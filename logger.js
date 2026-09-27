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

});

module.exports = logger;
