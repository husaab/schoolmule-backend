// utils/avatar.js
//
// Avatars: an illustrated face every person picks (style, skin tone,
// background), stored as JSON {style, skin, bg} (NULL = the neutral avatar).
// The artwork itself lives in the frontend (src/lib/avatarShapes.json); emails
// use a PNG per combination, rendered ahead of time and hosted as static files.

const STYLES = Object.freeze(['short', 'long', 'hijab', 'kufi', 'beard', 'curly']);
const SKIN_COUNT = 5;
const BG_COUNT = 8;

const AVATAR_ERROR = 'Pick a style, skin tone and background';

const isIndex = (v, count) => Number.isInteger(v) && v >= 0 && v < count;

/**
 * Check an avatar from a request body.
 * @returns {{ value: {style:string, skin:number, bg:number} | null } | { error: string }}
 *   null/undefined means "no avatar" (neutral); extra keys are dropped.
 */
function validateAvatar(input) {
  if (input === null || input === undefined) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: AVATAR_ERROR };
  const { style, skin, bg } = input;
  if (typeof style !== 'string' || !STYLES.includes(style) || !isIndex(skin, SKIN_COUNT) || !isIndex(bg, BG_COUNT)) {
    return { error: AVATAR_ERROR };
  }
  return { value: { style, skin, bg } };
}

/** Where emails load an avatar from (96x96 PNG; the neutral one for no avatar). */
function avatarPngUrl(avatar) {
  const base = (process.env.EMAIL_ASSET_BASE_URL || 'https://schoolmule.ca').replace(/\/+$/, '');
  const { value } = validateAvatar(avatar);
  const file = value ? `${value.style}-${value.skin}-${value.bg}` : 'neutral';
  return `${base}/email/avatars/${file}.png`;
}

/**
 * SQL select item for a student's displayed avatar: the linked student login's
 * own pick when there is one, else the avatar a teacher set on the student row.
 * `alias` is the students table or alias in the query it is added to;
 * `as` names the column in the result.
 */
function studentAvatarSql(alias = 'students', as = 'avatar') {
  return `COALESCE((SELECT su.avatar FROM student_account_links sal JOIN users su ON su.user_id = sal.user_id WHERE sal.student_id = ${alias}.student_id), ${alias}.avatar) AS ${as}`;
}

module.exports = { STYLES, SKIN_COUNT, BG_COUNT, AVATAR_ERROR, validateAvatar, avatarPngUrl, studentAvatarSql };
