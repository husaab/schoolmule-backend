// logging.js
const pino = require("pino")

const logger = pino({
    level: 'info',
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err
    },
    formatters: {
      level(label) {
        return { level: label };
      }
    }
});

module.exports = logger;
