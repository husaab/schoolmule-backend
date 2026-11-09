// utils/messageEditRules.js
//
// How long a sent message can be changed. The limit follows the role the
// message was SENT as (messages.sender_role), not the view its author is in
// now, so a teacher who is also a parent keeps the parent limit on what they
// wrote as a parent. Web and app read the answer from the thread's `canEdit`.

const MINUTE = 60 * 1000;
const LIMITS = { PARENT: 30 * MINUTE, STUDENT: 15 * MINUTE };

/** The limit in ms for a message sent as this role; null means no limit (staff). */
const editWindowMs = (senderRole) => LIMITS[senderRole] ?? null;

/** True while the message is still inside its role's limit. */
function withinEditWindow(message, now = Date.now()) {
  const limit = editWindowMs(message.sender_role);
  return limit === null || now - new Date(message.created_at).getTime() < limit;
}

/** True when this user may edit this message now. */
function canEditMessage(message, userId, now = Date.now()) {
  return message.kind === 'message' && !message.deleted_at && message.sender_id === userId && withinEditWindow(message, now);
}

/** The refusal for a message past its limit. */
const editWindowText = (senderRole) => `Messages can be edited for ${editWindowMs(senderRole) / MINUTE} minutes after sending`;

module.exports = { editWindowMs, withinEditWindow, canEditMessage, editWindowText };
