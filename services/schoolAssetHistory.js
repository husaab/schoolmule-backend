// services/schoolAssetHistory.js
//
// Earlier versions of a school's logo, principal signature and stamp.
//
// The live file sits at one path in the public `school-assets` bucket and an
// upload overwrites it. Before that happens (and before a delete) the live
// file is copied into the private `school-assets-history` bucket and a
// school_asset_versions row says what it was, so School Assets can list the
// earlier versions and restore one. The newest KEEP per school and asset are
// kept; older ones are removed.
//
// The rule every caller relies on: archiveCurrent either keeps a copy, finds
// there is no live file to keep, or throws. A caller that gets a throw must
// not overwrite or delete the live file.

const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const logger = require('../logger');
const supabase = require('../config/supabaseClient');
const queries = require('../queries/schoolAssets.queries');

const LIVE_BUCKET = 'school-assets';
const HISTORY_BUCKET = 'school-assets-history';
const KEEP = 10;
const PREVIEW_SECONDS = 600;

const ASSET_TYPES = Object.freeze(['logo', 'principal_signature', 'school_stamp']);
const ASSET_LABELS = Object.freeze({
  logo: 'School logo',
  principal_signature: 'Principal signature',
  school_stamp: 'School stamp',
});
const isAssetType = (value) => ASSET_TYPES.includes(value);

const folderOf = (schoolCode) => String(schoolCode).replace(/\s+/g, '').toUpperCase();

/** Whether the live bucket really holds a file at `livePath`. Throws when storage can't say. */
async function liveFileExists(livePath) {
  const folder = path.posix.dirname(livePath);
  const name = path.posix.basename(livePath);
  const { data, error } = await supabase.storage.from(LIVE_BUCKET).list(folder, { search: name, limit: 100 });
  if (error) throw new Error(`Could not look for the current file: ${error.message || 'storage error'}`);
  return (data || []).some((object) => object.name === name);
}

/** A stored file's bytes and type. Throws when it can't be read. */
async function readFile(bucket, objectPath) {
  const { data, error } = await supabase.storage.from(bucket).download(objectPath);
  if (error || !data) throw new Error(`Could not read ${objectPath}: ${error?.message || 'no data'}`);
  return { buffer: Buffer.from(await data.arrayBuffer()), contentType: data.type || null };
}

/** Remove versions beyond the newest KEEP for one school and asset. Never throws. */
async function prune(schoolId, assetType) {
  try {
    const { rows } = await db.query(queries.selectVersionsBeyond, [schoolId, assetType, KEEP]);
    if (rows.length === 0) return;
    const { error } = await supabase.storage.from(HISTORY_BUCKET).remove(rows.map((r) => r.storage_path));
    if (error) logger.warn({ err: error }, 'Old school asset versions could not be removed from storage');
    await db.query(queries.deleteVersions, [rows.map((r) => r.version_id)]);
  } catch (err) {
    logger.warn({ err }, 'Old school asset versions could not be pruned');
  }
}

/**
 * Keep a copy of the live file before it is replaced or deleted.
 * -> the new version row, or null when there is no live file to keep.
 * Throws when there is a live file and it could not be copied.
 *
 * @param {{ schoolId: string, school: string, assetType: string, currentPath: string|null,
 *   userId?: string|null, reason: 'replaced'|'deleted'|'restored_over', sourceActionId?: string|null }} args
 */
async function archiveCurrent({ schoolId, school, assetType, currentPath, userId = null, reason, sourceActionId = null }) {
  if (!currentPath) return null;
  if (!(await liveFileExists(currentPath))) return null; // the path is stale: nothing to keep

  const { buffer, contentType } = await readFile(LIVE_BUCKET, currentPath);
  const liveExt = path.posix.extname(currentPath);
  const versionId = uuidv4();
  const storagePath = `${path.posix.dirname(currentPath)}/${assetType}/${versionId}${liveExt}`;

  const { error } = await supabase.storage.from(HISTORY_BUCKET).upload(storagePath, buffer, {
    contentType: contentType || undefined,
    upsert: false,
  });
  if (error) throw new Error(`Could not keep a copy of the current file: ${error.message || 'storage error'}`);

  const { rows } = await db.query(queries.insertVersion, [
    versionId, schoolId, school, assetType, storagePath, liveExt, contentType, buffer.length, userId, reason, sourceActionId,
  ]);
  await prune(schoolId, assetType);
  return rows[0];
}

/** The earlier versions of one asset, newest first, each with a short-lived preview URL. */
async function listVersions(schoolId, assetType) {
  const { rows } = await db.query(queries.selectVersions, [schoolId, assetType]);
  if (rows.length === 0) return [];
  const { data } = await supabase.storage.from(HISTORY_BUCKET).createSignedUrls(rows.map((r) => r.storage_path), PREVIEW_SECONDS);
  const urlOf = new Map((data || []).filter((d) => d && !d.error).map((d) => [d.path, d.signedUrl]));
  return rows.map((r) => ({
    versionId: r.version_id,
    assetType: r.asset_type,
    reason: r.reason,
    replacedAt: r.replaced_at,
    replacedByName: r.replaced_by_name || null,
    contentType: r.content_type,
    byteSize: r.byte_size,
    previewUrl: urlOf.get(r.storage_path) || null,
  }));
}

/**
 * Put an earlier version back as the live file. The file it replaces is kept
 * first (reason 'restored_over'), so a restore can itself be undone.
 * -> { assets (the updated school_assets row), livePath, previousPath }, or null when the version isn't this school's asset.
 */
async function restoreVersion({ schoolId, schoolCode, assetType, versionId, userId = null }) {
  const { rows: [version] } = await db.query(queries.selectVersion, [versionId, schoolId, assetType]);
  if (!version) return null;

  const { rows: [current = {}] } = await db.query(queries.getSchoolAssetsBySchoolId, [schoolId]);
  const previousPath = current[`${assetType}_path`] || null;

  // Read the version before touching anything, so a missing copy changes nothing.
  const { buffer, contentType } = await readFile(HISTORY_BUCKET, version.storage_path);
  await archiveCurrent({ schoolId, school: version.school, assetType, currentPath: previousPath, userId, reason: 'restored_over' });

  const livePath = `${folderOf(schoolCode)}/${assetType}${version.live_ext}`;
  const { error } = await supabase.storage.from(LIVE_BUCKET).upload(livePath, buffer, {
    contentType: version.content_type || contentType || undefined,
    upsert: true,
  });
  if (error) throw new Error(`Could not put the earlier version back: ${error.message || 'storage error'}`);

  const paths = {
    logo_path: current.logo_path ?? null,
    principal_signature_path: current.principal_signature_path ?? null,
    school_stamp_path: current.school_stamp_path ?? null,
    [`${assetType}_path`]: livePath,
  };
  const { rows: [assets] } = await db.query(queries.upsertSchoolAssets, [
    schoolCode, schoolId, paths.logo_path, paths.principal_signature_path, paths.school_stamp_path,
  ]);
  await removeLiveFile(previousPath, livePath);
  return { assets, livePath, previousPath, version };
}

/** Remove a live file that a new one with another extension has replaced. Never throws. */
async function removeLiveFile(oldPath, newPath) {
  if (!oldPath || oldPath === newPath) return;
  const { error } = await supabase.storage.from(LIVE_BUCKET).remove([oldPath]);
  if (error) logger.warn({ err: error, oldPath }, 'A replaced school asset file could not be removed');
}

module.exports = {
  ASSET_TYPES, ASSET_LABELS, isAssetType, KEEP,
  archiveCurrent, listVersions, restoreVersion, removeLiveFile,
};
