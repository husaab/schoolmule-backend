const jwt = require('jsonwebtoken');

// Requests that only read. An admin "view as" preview token (payload carries
// `impersonator`) may do nothing else, so an admin can look around as a
// teacher or parent without ever acting as them.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const isImpersonation = (decoded) => Boolean(decoded && decoded.impersonator);

// requireVerified=false checks only that the token is valid: for the few
// self-service routes a pending account must still reach (delete account).
const createVerifier = ({ requireVerified }) => (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Access denied: no token provided.',
    });
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Add user info to request object for downstream use
    req.user = decoded;

    // Not fully verified (email and school). A token minted before approval
    // keeps the old claims, so the client keys off `code` to sign out.
    if (requireVerified && (!decoded.isVerified || !decoded.isVerifiedSchool)) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_NOT_VERIFIED',
        message: 'Access denied: account not fully verified.',
      });
    }

    // Preview sessions are read-only. This lives here (not in a separate
    // middleware) so every route that verifies a token is covered, including
    // the few mounted with verifyUser inline ahead of the global guard.
    if (isImpersonation(decoded) && !READ_METHODS.has(req.method)) {
      return res.status(403).json({
        success: false,
        status: 'failed',
        code: 'IMPERSONATION_READ_ONLY',
        message: "You're previewing School Mule as another user, so changes are turned off. Exit the preview to make changes.",
      });
    }

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Access denied: invalid token.',
      });
    } else if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Access denied: token expired.',
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Access denied: token verification failed.',
      });
    }
  }
};

const verifyUser = createVerifier({ requireVerified: true });
verifyUser.tokenOnly = createVerifier({ requireVerified: false });

module.exports = verifyUser;
