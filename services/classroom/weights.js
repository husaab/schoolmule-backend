// services/classroom/weights.js
//
// A category's points never change when a column joins or leaves it, so the
// class stays at 100 points. Pure; the caller writes the updates.

const round2 = (n) => Math.round(n * 100) / 100;
// A new child under a category keeps the category's points: existing children
// shrink by n/(n+1) (equal splits stay equal) and the new one takes parent/(n+1).
// Rounding drift lands on the last existing child so the sum is exact.
function rescaleForInsert(parentPoints, children) {
  const n = children.length;
  if (n === 0) return { updates: [], newWeight: round2(parentPoints) };
  const newWeight = round2(parentPoints / (n + 1));
  const updates = children.map((c) => ({ assessmentId: c.assessment_id, weightPoints: round2(Number(c.weight_points || 0) * (n / (n + 1))) }));
  const drift = round2(parentPoints - newWeight - updates.reduce((s, u) => s + u.weightPoints, 0));
  updates[updates.length - 1].weightPoints = round2(updates[updates.length - 1].weightPoints + drift);
  return { updates, newWeight };
}
// After a child leaves, the rest grow back to fill the category (equal split when they were all 0).
function rescaleForRemoval(parentPoints, remaining) {
  if (remaining.length === 0) return [];
  const total = remaining.reduce((s, c) => s + Number(c.weight_points || 0), 0);
  const updates = remaining.map((c) => ({ assessmentId: c.assessment_id,
    weightPoints: round2(total > 0 ? (Number(c.weight_points || 0) * parentPoints) / total : parentPoints / remaining.length) }));
  const drift = round2(parentPoints - updates.reduce((s, u) => s + u.weightPoints, 0));
  updates[updates.length - 1].weightPoints = round2(updates[updates.length - 1].weightPoints + drift);
  return updates;
}
module.exports = { rescaleForInsert, rescaleForRemoval, round2 };
