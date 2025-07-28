const jwt = require('jsonwebtoken');

const verifyUser = (req, res, next) => {
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

    // Check if user is fully verified (both email and school)
    if (!decoded.isVerified || !decoded.isVerifiedSchool) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: account not fully verified.',
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

module.exports = verifyUser;
