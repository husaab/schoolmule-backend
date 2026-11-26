// Get school assets by school code
const getSchoolAssetsBySchoolCode = `
  SELECT 
    school_code,
    school_id,
    logo_path,
    principal_signature_path,
    school_stamp_path,
    created_at,
    updated_at
  FROM school_assets
  WHERE school_code = $1
`;

// Get school assets by school ID
const getSchoolAssetsBySchoolId = `
  SELECT 
    school_code,
    school_id,
    logo_path,
    principal_signature_path,
    school_stamp_path,
    created_at,
    updated_at
  FROM school_assets
  WHERE school_id = $1
`;

// Create or update school assets (upsert)
const upsertSchoolAssets = `
  INSERT INTO school_assets (
    school_code,
    school_id,
    logo_path,
    principal_signature_path,
    school_stamp_path
  )
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (school_id)
  DO UPDATE SET
    logo_path = EXCLUDED.logo_path,
    principal_signature_path = EXCLUDED.principal_signature_path,
    school_stamp_path = EXCLUDED.school_stamp_path,
    updated_at = NOW()
  RETURNING *
`;

// Update specific asset path
const updateAssetPath = `
  UPDATE school_assets
  SET 
    ${1} = $2,
    updated_at = NOW()
  WHERE school_id = $3
  RETURNING *
`;

// Delete school assets
const deleteSchoolAssets = `
  DELETE FROM school_assets
  WHERE school_id = $1
`;

// Get all schools with their assets
const getAllSchoolsWithAssets = `
  SELECT 
    s.school_id,
    s.school_code,
    s.name as school_name,
    sa.logo_path,
    sa.principal_signature_path,
    sa.school_stamp_path,
    sa.created_at,
    sa.updated_at
  FROM schools s
  LEFT JOIN school_assets sa ON s.school_id = sa.school_id
  ORDER BY s.name
`;

// ── Earlier versions (services/schoolAssetHistory.js) ──────────────────

// $1 version_id … $11 source_action_id
const insertVersion = `
  INSERT INTO school_asset_versions (
    version_id, school_id, school, asset_type, storage_path, live_ext,
    content_type, byte_size, replaced_by, reason, source_action_id
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  RETURNING *
`;

// One asset's earlier versions, newest first. $1 school_id, $2 asset_type
const selectVersions = `
  SELECT
    v.version_id, v.asset_type, v.storage_path, v.reason, v.replaced_at,
    v.content_type, v.byte_size,
    NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS replaced_by_name
  FROM school_asset_versions v
  LEFT JOIN users u ON u.user_id = v.replaced_by
  WHERE v.school_id = $1 AND v.asset_type = $2
  ORDER BY v.replaced_at DESC, v.version_id
`;

// One version, only when it is this school's and this asset's. $1 version_id, $2 school_id, $3 asset_type
const selectVersion = `
  SELECT *
  FROM school_asset_versions
  WHERE version_id = $1 AND school_id = $2 AND asset_type = $3
`;

// The versions past the newest $3 for one school and asset.
const selectVersionsBeyond = `
  SELECT version_id, storage_path
  FROM school_asset_versions
  WHERE school_id = $1 AND asset_type = $2
  ORDER BY replaced_at DESC, version_id
  OFFSET $3
`;

const deleteVersions = `
  DELETE FROM school_asset_versions
  WHERE version_id = ANY($1::uuid[])
`;

module.exports = {
  getSchoolAssetsBySchoolCode,
  getSchoolAssetsBySchoolId,
  upsertSchoolAssets,
  updateAssetPath,
  deleteSchoolAssets,
  getAllSchoolsWithAssets,
  insertVersion,
  selectVersions,
  selectVersion,
  selectVersionsBeyond,
  deleteVersions,
};