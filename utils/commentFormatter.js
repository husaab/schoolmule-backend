/**
 * Format comment text with markdown-style bold headers for HTML output.
 * Converts **text** to <strong> tags while preserving intentional line breaks.
 *
 * Normalizes text by:
 * - Keeping double newlines (paragraph breaks)
 * - Keeping newlines before **headers**
 * - Converting unwanted mid-paragraph newlines to spaces
 *
 * Example:
 *   Input: "**Reading Skills**\nAbbas is a smart student.\n\n**Spelling**\nHe spells well."
 *   Output: "<strong>Reading Skills</strong><br/>Abbas is a smart student.<br/><br/><strong>Spelling</strong><br/>He spells well."
 *
 * @param {string} text - The comment text to format
 * @returns {string} HTML string with formatted text
 */
function formatCommentHTML(text) {
  if (!text) return ''

  // Normalize line endings
  let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // Use placeholders to preserve intentional line breaks
  const DOUBLE_NEWLINE = '___DOUBLE_NEWLINE___'
  const HEADER_NEWLINE = '___HEADER_NEWLINE___'
  const AFTER_HEADER_NEWLINE = '___AFTER_HEADER___'

  // Preserve double newlines (paragraph breaks)
  normalized = normalized.replace(/\n\n+/g, DOUBLE_NEWLINE)

  // Preserve newlines before ** headers
  normalized = normalized.replace(/\n(\*\*)/g, HEADER_NEWLINE + '$1')

  // Preserve newlines after **header** (closing **)
  normalized = normalized.replace(/(\*\*)\n/g, '$1' + AFTER_HEADER_NEWLINE)

  // Convert remaining single newlines to spaces (these are unwanted wraps)
  normalized = normalized.replace(/\n/g, ' ')

  // Clean up multiple spaces
  normalized = normalized.replace(/  +/g, ' ')

  // Restore intentional line breaks
  normalized = normalized.replace(new RegExp(DOUBLE_NEWLINE, 'g'), '\n\n')
  normalized = normalized.replace(new RegExp(HEADER_NEWLINE, 'g'), '\n')
  normalized = normalized.replace(new RegExp(AFTER_HEADER_NEWLINE, 'g'), '\n')

  // Escape HTML entities to prevent XSS
  const escaped = normalized
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
