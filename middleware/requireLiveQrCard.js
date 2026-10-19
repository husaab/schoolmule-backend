// A student session opened with a QR card ends once that card is voided or
// reprinted. requireStudent checks it on every /api/student request and
// /api/auth/me does too; this is the same check for the other routes the
// student fence lets a student reach (their own /api/profile, re-review N4),
// so a voided card can't keep changing the student's avatar or photo.
// It also ends any student session revoked by an address change. Staff and
// parents pass straight through.

const db = require('../config/database');
const logger = require('../logger');
const { isStudentToken } = require('./studentFence');
const { MESSAGES, qrCardLive, sessionRevoked } = require('../services/classroom/studentLogin');

const SQL = 'SELECT qr_secret_hash, qr_voided_at, sessions_revoked_at FROM student_accounts WHERE user_id = $1';

module.exports = async function requireLiveQrCard(req, res, next) {
  if (!isStudentToken(req.user)) return next();
  try {
    const { rows: [r] } = await db.query(SQL, [req.user.userId]);
    // Sessions revoked by an address change end here too (student invitations).
    if (sessionRevoked(req.user.iat, r?.sessions_revoked_at)) {
      return res.status(401).json({ status: 'failed', code: 'SESSION_REVOKED', message: MESSAGES.SESSION_REVOKED });
    }
    if (qrCardLive(req.user.qrCard, { qrSecretHash: r?.qr_secret_hash, qrVoidedAt: r?.qr_voided_at })) return next();
    return res.status(401).json({ status: 'failed', code: 'QR_INVALID', message: MESSAGES.QR_INVALID });
  } catch (error) {
    logger.error({ err: error }, 'requireLiveQrCard failed');
    return res.status(403).json({ status: 'failed', message: 'Student access required' });
  }
};
