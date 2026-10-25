// utils/appPaths.js
//
// Screens an email links to and a push notification opens: the path only,
// the same on the website and in the app (its routes mirror the website's).
// Emails put FRONTEND_URL in front.

/** A conversation in the recipient's inbox. */
function threadPath(role, conversationId) {
  if (role === 'PARENT') return `/parent/messages?thread=${conversationId}`;
  if (role === 'STUDENT') return `/student/messages?thread=${conversationId}`;
  return `/messages?thread=${conversationId}`;
}

module.exports = { threadPath };
