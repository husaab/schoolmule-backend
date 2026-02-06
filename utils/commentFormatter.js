/**
 * Format comment text with markdown-style bold headers for HTML output.
 * Converts **text** to <strong> tags while preserving whitespace and newlines.
 *
 * Example:
 *   Input: "**Reading Skills**\nAbbas is a smart student."
 *   Output: "<strong>Reading Skills</strong><br/>Abbas is a smart student."
 *
 * @param {string} text - The comment text to format
 * @returns {string} HTML string with formatted text
 */
function formatCommentHTML(text) {
  if (!text) return ''

  // Escape HTML entities first to prevent XSS
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

  // Replace **text** with <strong> tags
  const withBold = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  // Convert newlines to <br/> for proper line breaks in HTML
  const withBreaks = withBold.replace(/\n/g, '<br/>')

  return withBreaks
}

module.exports = { formatCommentHTML }
