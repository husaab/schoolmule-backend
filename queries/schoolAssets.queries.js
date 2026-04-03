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

module.exports = {
  getSchoolAssetsBySchoolCode,
  getSchoolAssetsBySchoolId,
  upsertSchoolAssets,
  updateAssetPath,
  deleteSchoolAssets,
  getAllSchoolsWithAssets
};