// utils/classIdentity.js
//
// A class's look: banner, icon and color. Nothing is stored for a class that
// uses the defaults (the columns are NULL): the defaults come from the subject
// name, so a renamed subject re-skins the class and a new class needs no setup.
// The 13 families and 11 colors match the Banners board and the SVG files in
// the frontend's public/class-banners and public/class-icons.

const FAMILIES = Object.freeze([
  'quran', 'arabic', 'islamic', 'french', 'computer', 'english', 'science',
  'math', 'social', 'pe', 'art', 'kindergarten', 'default',
]);

const COLORS = Object.freeze([
  'teal', 'blue', 'emerald', 'lime', 'yellow', 'orange', 'rose', 'pink', 'purple', 'sky', 'slate',
]);

const FAMILY_DEFAULT_COLOR = Object.freeze({
  quran: 'emerald', arabic: 'orange', islamic: 'pink', french: 'yellow', computer: 'slate',
  english: 'rose', science: 'teal', math: 'blue', social: 'sky', pe: 'lime', art: 'purple',
  kindergarten: 'sky', default: 'slate',
});

const isFamily = (k) => typeof k === 'string' && FAMILIES.includes(k);
const isColor = (k) => typeof k === 'string' && COLORS.includes(k);

// Evaluated in this order on the lower-cased subject; the first match wins, so
// "French Language Arts" is French (not English) and "Islamic Studies and
// Quran" is Quran. The word-boundary rules keep "art" and "pe" out of words
// like "Smart" and "Speech".
const RULES = [
  ['quran', /quran/], ['arabic', /arabic/], ['islamic', /islam/], ['french', /french|fran[cç]ais/],
  ['computer', /computer|coding|\bict\b|technology/], ['english', /english|language arts|literacy/],
  ['science', /science|physics|chemistry|biology/], ['math', /math/], ['social', /social|history|geography/],
  ['pe', /physical|\bgym\b|\bp\.?e\.?\b|sport/], ['art', /\barts?\b|drawing|visual/], ['kindergarten', /kindergarten/],
];

/** The family a subject belongs to; JK/SK classes with no keyword are kindergarten. */
function subjectFamily(subject, grade) {
  const s = String(subject || '').toLowerCase();
  const hit = RULES.find(([, re]) => re.test(s));
  if (hit) return hit[0];
  return grade === 'JK' || grade === 'SK' ? 'kindergarten' : 'default';
}

/**
 * The ClassIdentity for a classes row (`subject`, `grade`, and the nullable
 * `banner_key`, `banner_path`, `icon_key`, `color`). `bannerPublicUrl(path)`
 * turns an upload's storage path into its public URL.
 */
function resolveIdentity(row, { bannerPublicUrl }) {
  const family = subjectFamily(row.subject, row.grade == null ? null : String(row.grade));
  const bannerIsUpload = Boolean(row.banner_path);
  const bannerKey = bannerIsUpload ? null : (isFamily(row.banner_key) ? row.banner_key : family);
  const iconKey = isFamily(row.icon_key) ? row.icon_key : family;
  const color = isColor(row.color) ? row.color : FAMILY_DEFAULT_COLOR[family];
  return {
    family,
    bannerKey,
    bannerIsUpload,
    bannerUrl: bannerIsUpload ? bannerPublicUrl(row.banner_path) : `/class-banners/${bannerKey}.svg`,
    iconKey,
    iconUrl: `/class-icons/${iconKey}.svg`,
    color,
    isDefault: {
      banner: !bannerIsUpload && !isFamily(row.banner_key),
      icon: !isFamily(row.icon_key),
      color: !isColor(row.color),
    },
  };
}

module.exports = { FAMILIES, COLORS, FAMILY_DEFAULT_COLOR, subjectFamily, isFamily, isColor, resolveIdentity };
