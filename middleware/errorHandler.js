const logger = require("../logger");

// Global error handler — must be registered AFTER all routes.
// Express identifies this as an error handler because it has 4 parameters.
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const log = req.log || logger;

  const statusCode = err.status || err.statusCode || 500;

  log.error(
    {
      err,
      statusCode,
      method: req.method,
      url: req.originalUrl,
      userId: req.user?.userId,
    },
    `Unhandled error: ${err.message}`
  );

  if (res.headersSent) {
    return next(err);
  }

  const isProduction = process.env.NODE_ENV === "production";

  res.status(statusCode).json({
    success: false,
    message: isProduction
      ? "Internal Server Error"
      : err.message || "Internal Server Error",
    ...(!isProduction && { stack: err.stack }),
  });
};

module.exports = errorHandler;
