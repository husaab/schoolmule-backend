const logger = require("../logger")

function maskSensitiveData(data) {
    if (!data) return data;
    
    const maskedData = JSON.parse(JSON.stringify(data)); // Deep clone to avoid mutation
    for (const key in maskedData) {
        if (key.toLowerCase().includes("password")) {
            maskedData[key] = "***"; // Replace passwords with masked value
        } else if (typeof maskedData[key] === "object" && maskedData[key] !== null) {
            maskedData[key] = maskSensitiveData(maskedData[key]); // Recurse into nested objects
        }
    }
    return maskedData;
}


function maskCookies(cookies) {
  if (!cookies) return {};
  const safeCookies = { ...cookies };

  // Mask any sensitive cookie values
  for (const key in safeCookies) {
    if (key.toLowerCase().includes("token") || key.toLowerCase().includes("session")) {
      safeCookies[key] = "***";
    }
  }

  return safeCookies;
}

const RequestLogger = (req, res, next) => {
    const sanitizedBody = req.body ? maskSensitiveData(req.body) : null;
    logger.info({
        method: req.method,
        url: req.url,
        body: sanitizedBody,
        params: req.params ? JSON.stringify(req.params) : null,
        query: req.query ? JSON.stringify(req.query) : null,
        cookies: {
            user_id: req.cookies?.['user_id'],
            is_verified_email: req.cookies?.['is_verified_email'],
            is_verified_school: req.cookies?.['is_verified_school'],
        }
    }, 'Request received');
    next();
}

module.exports = RequestLogger