/*
  controllers/studentRequest.controller.js
  Student account requests (services/classroom/studentRequests.js):

    POST   /api/auth/student-request                     public: a student asks for an account
    GET    /api/admin/student-requests                   pending + declined, with the likeliest student
    GET    /api/admin/student-requests/:id/candidates    ?email=&studentId=  the review
    POST   /api/admin/student-requests/:id/approve       { studentId, email, consentConfirmed: true, noticeVersion? }
    POST   /api/admin/student-requests/:id/decline
    POST   /api/admin/student-requests/:id/restore
    DELETE /api/admin/student-requests/:id               declined only

  The admin school is always the caller's (req.user.school).
*/

const logger = require('../logger');
const requests = require('../services/classroom/studentRequests');
const { StudentRequestError } = require('../services/classroom/studentRequestRules');

const ok = (res, data) => res.status(200).json({ status: 'success', data });

function fail(res, err, fallback) {
  if (err instanceof StudentRequestError) {
    return res.status(err.status).json({ status: 'failed', code: err.code, message: err.message, data: err.data });
  }
  logger.error({ err }, fallback);
  return res.status(500).json({ status: 'failed', message: fallback });
}

// POST /api/auth/student-request. Every stored-or-not outcome gets the same
// answer, and the admins' email goes out after it, so nothing about the
// answer says whether a request was stored.
const submit = async (req, res) => {
  let result;
  try {
    result = await requests.submitRequest(req.body);
  } catch (err) {
    return fail(res, err, "Your request couldn't be sent. Try again.");
  }
  ok(res, { received: true });
  if (result.outcome === 'created') await requests.notifyAdminsOfRequest(result.school);
  return undefined;
};

const admin = (req) => ({ school: req.user.school, requestId: req.params.id });

const list = async (req, res) => {
  try {
    return ok(res, { requests: await requests.listRequests({ school: req.user.school }) });
  } catch (err) {
    return fail(res, err, 'Error loading student requests');
  }
};

const candidates = async (req, res) => {
  try {
    const { email, studentId } = req.query;
    return ok(res, await requests.requestCandidates({
      ...admin(req),
      email: typeof email === 'string' ? email : undefined,
      studentId: typeof studentId === 'string' ? studentId : undefined,
    }));
  } catch (err) {
    return fail(res, err, 'Error loading the request');
  }
};

const approve = async (req, res) => {
  try {
    const { studentId, email, consentConfirmed, noticeVersion } = req.body ?? {};
    return ok(res, await requests.approveRequest({
      ...admin(req),
      admin: { userId: req.user.userId, username: req.user.username },
      studentId, email, consentConfirmed, noticeVersion,
    }));
  } catch (err) {
    return fail(res, err, 'Error approving the request');
  }
};

const decline = async (req, res) => {
  try {
    return ok(res, { request: await requests.declineRequest({ ...admin(req), adminId: req.user.userId }) });
  } catch (err) {
    return fail(res, err, 'Error declining the request');
  }
};

const restore = async (req, res) => {
  try {
    return ok(res, { request: await requests.restoreRequest(admin(req)) });
  } catch (err) {
    return fail(res, err, 'Error restoring the request');
  }
};

const remove = async (req, res) => {
  try {
    return ok(res, await requests.deleteRequest(admin(req)));
  } catch (err) {
    return fail(res, err, 'Error deleting the request');
  }
};

module.exports = { submit, list, candidates, approve, decline, restore, remove };
