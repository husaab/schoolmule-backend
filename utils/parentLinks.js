// utils/parentLinks.js
//
// "Ask the teacher about this" links in parent emails. The link opens Parent
// Messages with a new message about one child already set up; the frontend
// (src/lib/askLink.ts, whose parameter names these are) anchors it to the
// assessment when that has been shared with parents, and otherwise writes to
// the class teacher as a General message titled after `about`.

const ABOUT_MAX = 100;

/** /parent/messages?tab=conversations&ask=<studentId>&askClass=…[&askAssessment=…][&askAbout=…] */
const parentAskPath = ({ studentId, classId, assessmentId = null, about = null }) => {
  const params = new URLSearchParams({ tab: 'conversations', ask: studentId, askClass: classId });
  if (assessmentId) params.set('askAssessment', assessmentId);
  const title = String(about || '').replace(/\s+/g, ' ').trim().slice(0, ABOUT_MAX);
  if (title) params.set('askAbout', title);
  return `/parent/messages?${params}`;
};

/** parentAskPath on the portal's origin. */
const parentAskLink = (link) => `${process.env.FRONTEND_URL || ''}${parentAskPath(link)}`;

/** "Ask Ms. Clarke about this", or "Ask the teacher about this" with no name on file. */
const askLabel = (teacherName) => `Ask ${String(teacherName || '').trim() || 'the teacher'} about this`;

/** An email row's { askUrl, askLabel }, as the templates' askLine reads them. */
const askFields = ({ teacherName, ...link }) => ({ askUrl: parentAskLink(link), askLabel: askLabel(teacherName) });

/** The grade email's button: "Speak to Doha Chahade about this", or "…about these grades" for several. */
const speakLabel = (teacherName, count = 1) =>
  `Speak to ${String(teacherName || '').trim() || 'the teacher'} about ${count > 1 ? 'these grades' : 'this'}`;

module.exports = { parentAskPath, parentAskLink, askLabel, askFields, speakLabel };
