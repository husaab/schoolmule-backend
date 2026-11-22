// Guided tours. The tours live in client code; the server keeps, per person,
// what they did with each tour id, so a tour finished on the web is never
// offered again in the app. Any signed-in person may call these (students
// and parents included): every query is keyed on req.user.userId. An admin's
// "View as" preview never writes: verifyUser refuses its POSTs.
const db = require("../config/database");
const q = require("../queries/tour.queries");
const logger = require("../logger");
const { applyTourEvent, TOUR_EVENTS, TOUR_ID_PATTERN } = require("../services/tours/tourProgress");

const PLATFORMS = new Set(["web", "app"]);

const toCamel = (row) => ({
  tourId: row.tour_id,
  version: row.version,
  status: row.status,
  stepIndex: row.step_index,
  stepId: row.step_id,
  snoozedUntil: row.snoozed_until,
  completedAt: row.completed_at,
  updatedAt: row.updated_at,
});

// GET /api/tours/progress
const getTourProgress = async (req, res) => {
  try {
    const userId = req.user.userId;
    const [progress, user] = await Promise.all([
      db.query(q.selectProgress, [userId]),
      db.query(q.selectCreatedAt, [userId]),
    ]);
    return res.status(200).json({
      status: "success",
      data: {
        progress: progress.rows.map(toCamel),
        // Decides "new accounts only" for the welcome tours.
        createdAt: user.rows[0]?.created_at ?? null,
        // The server's clock, so a wrong device clock can't break Later or a tour's dates.
        serverNow: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error loading tour progress" });
  }
};

const readEvent = (params, body) => {
  const tourId = params.tourId;
  const { event, version = 1, stepIndex = null, stepId = null, platform = null } = body || {};
  if (!TOUR_ID_PATTERN.test(tourId || "")) return { error: "Invalid tour id" };
  if (!TOUR_EVENTS.includes(event)) return { error: "Invalid tour event" };
  if (!Number.isInteger(version) || version < 1 || version > 1000) return { error: "Invalid tour version" };
  if (stepIndex !== null && (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 200)) return { error: "Invalid step" };
  if (stepId !== null && (typeof stepId !== "string" || stepId.length > 64)) return { error: "Invalid step id" };
  if (platform !== null && !PLATFORMS.has(platform)) return { error: "Invalid platform" };
  return { tourId, event, version, stepIndex, stepId, platform };
};

// POST /api/tours/:tourId/event  { event, version, stepIndex?, stepId?, platform? }
const postTourEvent = async (req, res) => {
  const input = readEvent(req.params, req.body);
  if (input.error) return res.status(400).json({ status: "failed", message: input.error });

  const userId = req.user.userId;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(q.ensureProgress, [userId, input.tourId, input.version]);
    const { rows } = await client.query(q.selectProgressForUpdate, [userId, input.tourId]);
    const next = applyTourEvent(toCamel(rows[0]), input, new Date());

    await client.query(q.insertEvent, [
      userId, input.tourId, input.version, input.event, input.stepId, input.stepIndex,
      req.user.role || null, input.platform,
    ]);
    const saved = await client.query(q.updateProgress, [
      userId, input.tourId, next.version, next.status, next.stepIndex, next.stepId, next.snoozedUntil, next.completedAt,
    ]);
    await client.query("COMMIT");
    return res.status(200).json({ status: "success", data: toCamel(saved.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error saving tour progress" });
  } finally {
    client.release();
  }
};

module.exports = { getTourProgress, postTourEvent };
