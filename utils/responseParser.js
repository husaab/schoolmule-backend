// utils/responseHandler.js
const logger = require("../logger");

const responseHandler = (controller) => {
    return async (req, res, next) => {
        try {
            const result = await controller(req, res, next);
            if (result) {
                logger.info("response:", result.message);
                return res.status(result.status || 200).json({
                    success: true,
                    message: result.message || "Request successful",
                    data: result.data || null,
                    ...(result.pagination && { pagination: result.pagination }),
                });
            }
        } catch (error) {
            logger.error("API Error:", error, error.message);
            console.log("error:", error);
            return res.status(error.status || 500).json({
                success: false,
                message: error.message || "Internal Server Error",
            });
        }
    };
};

module.exports = responseHandler;
