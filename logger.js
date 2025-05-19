// logging.js
const pino = require("pino")

// const logger = pino({
//     level: 'info',
//     transport: {
//       target: 'pino-pretty',
//       options: {
//         colorize: true // for better readability in the console
//       }
//     }
//   });
const logger = pino();

module.exports = logger;
