const pinoHttp = require("pino-http");
const crypto = require("crypto");
const logger = require("../logger");

const httpLogger = pinoHttp({
  logger,

  genReqId: (req, res) => {
    const existing = req.headers["x-request-id"];
    const id = existing || crypto.randomUUID();
    res.setHeader("X-Request-Id", id);
    return id;
  },

  serializers: {
    req(req) {
      return {
        method: req.method,
        url: req.url,
        headers: {
          "user-agent": req.headers["user-agent"],
          "content-type": req.headers["content-type"],
          host: req.headers.host,
        },
        remoteAddress: req.remoteAddress,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
  },

  customLogLevel: (_req, res, error) => {
    if (res.statusCode >= 500 || error) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },

  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} completed ${res.statusCode}`;
  },

  customErrorMessage: (req, _res, error) => {
    return `${req.method} ${req.url} errored: ${error.message}`;
  },

  customAttributeKeys: {
    req: "req",
    res: "res",
    err: "err",
    responseTime: "responseTime",
    reqId: "reqId",
  },
});

module.exports = httpLogger;
