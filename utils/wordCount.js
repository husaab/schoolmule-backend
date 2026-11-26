// How many words a comment has: runs of anything that is not whitespace. The
// whitespace set is spelled out (space, tab, the line breaks, form feed,
// vertical tab, no-break space) so JavaScript, the web's src/lib/commentRules.ts
// and Postgres all count the same words: a comment the page shows as "50
// words" is 50 words to the server and to its queries.

const WORD = /[^ \t\n\r\f\v ]+/g;

/** The number of words in `text` (0 for nothing, or for anything but a string). */
const countWords = (text) => (typeof text === 'string' ? (text.match(WORD) || []).length : 0);

/** SQL twin of countWords for a TEXT expression, e.g. wordCountSql('f.comment'). */
const wordCountSql = (expr) =>
  `(SELECT count(*)::int FROM regexp_matches(COALESCE(${expr}, ''), '[^ \\t\\n\\r\\f\\v\\u00A0]+', 'g'))`;

module.exports = { countWords, wordCountSql };
