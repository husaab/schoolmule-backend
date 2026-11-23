// services/adminOverview/blocks.js
//
// One function per admin overview block: (q, ctx) => facts. q(text, params)
// runs on the lane's client (runBlocks.js), so a block's queries go one after
// another on one connection; ctx = { school, yearId, today, now, req }. Which
// blocks a caller gets is the controller's call (controllers/adminOverview.controller.js).
//
// Where an area already counts something for its own page, the block reads
// that same statement or rule, so the overview can't disagree with the page:
// pending student requests, the Forms badge, the student-accounts roster and
// its status rules, the latest QuickBooks job.

const Q = require('../../queries/adminOverview.queries');
const studentRequestQueries = require('../../queries/studentRequest.queries');
const registrationQueries = require('../../queries/registration.queries');
const studentAccountQueries = require('../../queries/studentAccount.queries');
const financeQueries = require('../../queries/finance.queries');
const { getSettings } = require('../classroom/classroomSettings');
const { toStudentAccountRow } = require('../classroom/studentAccounts');
const { formCreatorFilter } = require('../../middleware/requireFormAccess');
const S = require('./shape');

const rowsOf = async (q, text, params) => (await q(text, params)).rows;
const rowOf = async (q, text, params) => (await rowsOf(q, text, params))[0] || null;

const approvals = async (q, { school }) => S.shapeApprovals(
  await rowOf(q, Q.approvalCounts, [school]),
  await rowOf(q, studentRequestQueries.countPending, [school]),
);

const users = async (q, { school }) => S.shapeUsers(await rowOf(q, Q.userCounts, [school]));

// The Student accounts page's own roster and rules (GET /admin/student-accounts):
// no selected year, no students.
const studentAccounts = async (q, { school, yearId }) => {
  if (!yearId) return S.countStudentAccounts([]);
  const settings = await getSettings(school, { query: q });
  const rows = await rowsOf(q, studentAccountQueries.selectStudentAccountRows, [school, yearId]);
  return S.countStudentAccounts(rows.map((row) => toStudentAccountRow(row, settings)));
};

const relations = async (q, { school, yearId }) => S.shapeRelations(await rowOf(q, Q.guardianCoverage, [school, yearId]));

const messages = async (q, { school, yearId }) => S.shapeMessages(await rowOf(q, Q.messageCounts, [school, yearId]));

const schoolSettings = async (q, { school, yearId, today }) => {
  if (!yearId) return { currentTerm: null, nextTerm: null };
  return S.pickTerms(await rowsOf(q, Q.yearTerms, [school, yearId]), today);
};

const calendar = async (q, { school, yearId, today }) => S.shapeClosure(await rowOf(q, Q.nextClosure, [school, yearId, today]));

const assets = async (q, { school }) => S.shapeAssets(await rowOf(q, Q.assetPresence, [school]));

const reportTemplates = async (q, { school }) => S.shapeTemplates(await rowOf(q, Q.templateCounts, [school]));

const reportRuns = async (q, { school, yearId }) => S.shapeReportRuns(await rowOf(q, Q.reportRunCounts, [school, yearId]));

// The same creator filter as the Forms list and its badge.
const forms = async (q, { school, req }) => {
  const creator = formCreatorFilter(req);
  const badge = await rowOf(q, registrationQueries.countNewSubmissionsBySchool, [school, creator]);
  return S.shapeForms(badge?.count, await rowsOf(q, Q.formSummaries, [school, creator]));
};

const planner = async (q, { school, yearId }) => S.shapePlanner(await rowsOf(q, Q.plannerSchedules, [school, yearId]));

const agendas = async (q, { school }) => S.shapeAgenda(await rowOf(q, Q.latestAgenda, [school]));

const meetings = async (q, { school, yearId, now }) => S.pickMeeting(await rowsOf(q, Q.meetingEvents, [school, yearId]), now);

const finance = async (q, { school }) => S.shapeFinance(
  await rowOf(q, Q.financeConnection, [school]),
  await rowOf(q, financeQueries.selectLatestJob, [school]),
);

const roles = async (q, { school }) => S.shapeRoles(await rowOf(q, Q.customRoleCount, [school]));

const patchNotes = async (q) => S.shapePatchNotes(await rowOf(q, Q.patchNoteCounts, []));

module.exports = {
  approvals,
  users,
  studentAccounts,
  relations,
  messages,
  schoolSettings,
  calendar,
  assets,
  reportTemplates,
  reportRuns,
  forms,
  planner,
  agendas,
  meetings,
  finance,
  roles,
  patchNotes,
};
