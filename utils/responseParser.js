const logger = require("../logger");

const responseHandler = (controller) => {
    return async (req, res, next) => {
        try {
            const result = await controller(req, res, next);
            if (result) {
                const status = result.status || 200;
                return res.status(status).json({
                    success: status < 400,
                    message: result.message || "Request successful",
                    data: result.data || null,
                    ...(result.pagination && { pagination: result.pagination }),
                });
            }
        } catch (error) {
            const log = req.log || logger;
            log.error({ err: error }, "API Error");
            return res.status(error.status || 500).json({
                success: false,
                message: error.message || "Internal Server Error",
            });
        }
    };
};

module.exports = responseHandler;
