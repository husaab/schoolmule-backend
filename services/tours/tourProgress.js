// services/tours/tourProgress.js
//
// The one rule for how a tour event moves a person's progress row. The web's
// src/lib/tours/progress.ts applies the same rule on the client for an
// instant update; keep the two in step (tourProgress.test.js and the web's
// progress.test.ts check the same cases).
//
// - A newer tour version starts over: the old row no longer counts. An event
//   from an older version (an old tab still open) changes nothing.
// - `started` always (re)opens the tour: it is only ever sent when the person
//   chose to start it (Show me how, the ? menu, a Show me how link).
// - `step`, `paused` and `resumed` never reopen a finished or dismissed tour,
//   so a late write from a second device can't undo "completed".
// - `snoozed` (Later) keeps the tour offerable after SNOOZE_DAYS.

const TOUR_EVENTS = Object.freeze(['offered', 'started', 'step', 'paused', 'resumed', 'completed', 'dismissed', 'snoozed']);
// A tour id from the client's catalog (lib/tours TOUR_ID_PATTERN). Also checks patch_notes.tour_id.
const TOUR_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const SNOOZE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {null|{status:string,version:number,stepIndex:number,stepId:string|null,snoozedUntil:Date|null,completedAt:Date|null}} row
 * @param {{event:string,version:number,stepIndex:number|null,stepId?:string|null}} input
 * @param {Date} now
 */
function applyTourEvent(row, { event, version, stepIndex, stepId = null }, now) {
  if (row && version < row.version) return row;
  const fresh = !row || version > row.version;
  const base = fresh
    ? { status: 'offered', version, stepIndex: 0, stepId: null, snoozedUntil: null, completedAt: null }
    : { ...row };
  const closed = base.status === 'completed' || base.status === 'dismissed';
  const moved = Number.isInteger(stepIndex) && stepIndex >= 0;
  const at = moved ? stepIndex : base.stepIndex;
  const atId = moved ? stepId : base.stepId;

  switch (event) {
    case 'offered':
      return base;
    case 'started':
      return { ...base, status: 'in_progress', stepIndex: at, stepId: atId, snoozedUntil: null, completedAt: null };
    case 'step':
    case 'paused':
    case 'resumed':
      return closed ? base : { ...base, status: 'in_progress', stepIndex: at, stepId: atId };
    case 'completed':
      return { ...base, status: 'completed', completedAt: now, snoozedUntil: null };
    case 'dismissed':
      return base.status === 'completed' ? base : { ...base, status: 'dismissed', snoozedUntil: null };
    case 'snoozed':
      return closed ? base : { ...base, status: 'offered', snoozedUntil: new Date(now.getTime() + SNOOZE_DAYS * DAY_MS) };
    default:
      throw new Error(`Unknown tour event: ${event}`);
  }
}

module.exports = { applyTourEvent, TOUR_EVENTS, TOUR_ID_PATTERN, SNOOZE_DAYS };
