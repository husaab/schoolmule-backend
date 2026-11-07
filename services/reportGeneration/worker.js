// services/reportGeneration/worker.js
//
// Prints queued reports (report_generation_items) one at a time. The loop
// itself comes next; for now kick() is a no-op so runs can be queued.

function kick() {}

module.exports = { kick };
