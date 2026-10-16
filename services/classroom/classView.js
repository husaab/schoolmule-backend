// services/classroom/classView.js
//
// How a classes row is shown: its identity (banner, icon, color) and options.
// Shared by the class API and the classroom API so every payload agrees.

const supabase = require('../../config/supabaseClient');
const logger = require('../../logger');
const { resolveIdentity } = require('../../utils/classIdentity');

const BANNER_BUCKET = 'school-assets'; // public; uploads at <SCHOOL>/class-banners/<classId>/<uuid>.<ext>

const bannerPublicUrl = (path) => supabase.storage.from(BANNER_BUCKET).getPublicUrl(path).data.publicUrl;

/** ClassIdentity for a classes row (needs subject, grade and the four identity columns). */
const identityOf = (row) => resolveIdentity(row, { bannerPublicUrl });

/** The three per-class switches; a row that does not carry them has the column defaults. */
const optionsOf = (row) => ({
  acceptLate: row.accept_late ?? true,
  emailNewPosts: row.email_new_posts ?? true,
  showClassAverage: row.show_class_average ?? false,
});

/** Best-effort delete of an uploaded banner; logs and never throws. */
async function removeBannerObject(path) {
  if (!path) return;
  try {
    await supabase.storage.from(BANNER_BUCKET).remove([path]);
  } catch (error) {
    logger.warn({ path, err: error?.message || error }, 'Removing a class banner failed');
  }
}

module.exports = { BANNER_BUCKET, bannerPublicUrl, identityOf, optionsOf, removeBannerObject };
