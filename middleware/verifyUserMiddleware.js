const verifyUser = (req, res, next) => {
  const isEmailVerified = req.cookies['is_verified_email'] === 'true';
  const isSchoolVerified = req.cookies['is_verified_school'] === 'true';

  if (!isEmailVerified || !isSchoolVerified) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: account not fully verified.',
    });
  }

  next();
};

module.exports = verifyUser;
