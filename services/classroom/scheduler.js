// services/classroom/scheduler.js
//
// Posts scheduled classwork once its publish time has passed. Readers already
// treat a past-due scheduled row as posted (EFFECTIVE_POSTED), so this only
// makes the row say so, with posted_at = the time it was meant to post. The
// message notifier's tick calls it; the rows it returns are what T21 emails.

const db = require('../../config/database');
const q = require('../../queries/classwork.queries');

/**
 * @returns {Promise<{ item_id: string, class_id: string }[]>} the items just posted
 */
async function promoteScheduledItems() {
  const { rows } = await db.query(q.promoteScheduledItems, []);
  return rows;
}

module.exports = { promoteScheduledItems };
