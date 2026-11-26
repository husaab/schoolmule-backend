const db = require("../config/database");
const schoolAssetsQueries = require("../queries/schoolAssets.queries");
const logger = require("../logger");
const supabase = require('../config/supabaseClient');
const multer = require('multer');
const path = require('path');
const history = require('../services/schoolAssetHistory');
const audit = require('../services/audit/auditLog');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The live file was not touched: its copy could not be made first.
const NOT_KEPT = {
  status: 'error',
  code: 'ASSET_COPY_FAILED',
  message: "The current file couldn't be saved to its history, so nothing was changed. Try again.",
};

const toCamel = row => ({
  schoolCode: row.school_code,
  schoolId: row.school_id,
  logoPath: row.logo_path,
  principalSignaturePath: row.principal_signature_path,
  schoolStampPath: row.school_stamp_path,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  // For joined queries
  schoolName: row.school_name
});

// Configure multer for file upload
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
    }
  }
});

// Get school assets by school code
const getSchoolAssetsBySchoolCode = async (req, res) => {
  try {
    const { schoolCode } = req.params;

    if (!schoolCode) {
      return res.status(400).json({
        status: 'error',
        message: 'School code is required'
      });
    }

    const result = await db.query(schoolAssetsQueries.getSchoolAssetsBySchoolCode, [schoolCode]);
    
    res.json({
      status: 'success',
      data: result.rows[0] ? toCamel(result.rows[0]) : null
    });
  } catch (error) {
    logger.error('Error fetching school assets by school code:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch school assets',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get school assets by school ID
const getSchoolAssetsBySchoolId = async (req, res) => {
  try {
    const { schoolId } = req.params;

    if (!schoolId) {
      return res.status(400).json({
        status: 'error',
        message: 'School ID is required'
      });
    }

    const result = await db.query(schoolAssetsQueries.getSchoolAssetsBySchoolId, [schoolId]);
    
    res.json({
      status: 'success',
      data: result.rows[0] ? toCamel(result.rows[0]) : null
    });
  } catch (error) {
    logger.error('Error fetching school assets by school ID:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch school assets',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Upload single asset file
const uploadAsset = async (req, res) => {
  try {
    const { schoolCode, assetType } = req.body;
    const file = req.file;

    if (!schoolCode || !assetType || !file) {
      return res.status(400).json({
        status: 'error',
        message: 'School code, asset type, and file are required'
      });
    }

    const allowedAssetTypes = ['logo', 'principal_signature', 'school_stamp'];
    if (!allowedAssetTypes.includes(assetType)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid asset type. Allowed types: logo, principal_signature, school_stamp'
      });
    }

    // Get school information
    const { rows: schoolRows } = await db.query('SELECT school_id FROM schools WHERE school_code = $1', [schoolCode]);
    if (schoolRows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'School not found'
      });
    }
    const schoolId = schoolRows[0].school_id;

    // Create folder structure similar to progress reports
    const schoolFolder = schoolCode.replace(/\s+/g, '').toUpperCase();
    const fileExtension = path.extname(file.originalname);
    const fileName = `${schoolFolder}/${assetType}${fileExtension}`;

    // The file being replaced is kept first (School Assets -> earlier
    // versions). If it can't be kept, it isn't overwritten.
    const { rows: existingAssets } = await db.query(schoolAssetsQueries.getSchoolAssetsBySchoolId, [schoolId]);
    const currentAssets = existingAssets.length > 0 ? existingAssets[0] : {};
    const previousPath = currentAssets[`${assetType}_path`] || null;
    let kept = null;
    try {
      kept = await history.archiveCurrent({
        schoolId, school: req.user.school, assetType, currentPath: previousPath,
        userId: req.user.userId, reason: 'replaced',
      });
    } catch (archiveError) {
      logger.error({ err: archiveError }, 'School asset upload stopped: the current file could not be kept');
      return res.status(500).json(NOT_KEPT);
    }

    // Upload to Supabase storage
    const { error } = await supabase
      .storage
      .from('school-assets')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (error) {
      logger.error('Supabase upload error:', error);
      throw new Error('Upload to storage failed');
    }

    // Update the specific asset path
    const updatedAssets = {
      logo_path: currentAssets.logo_path,
      principal_signature_path: currentAssets.principal_signature_path,
      school_stamp_path: currentAssets.school_stamp_path
    };
    
    updatedAssets[`${assetType}_path`] = fileName;

    // Upsert the record
    const result = await db.query(schoolAssetsQueries.upsertSchoolAssets, [
      schoolCode,
      schoolId,
      updatedAssets.logo_path,
      updatedAssets.principal_signature_path,
      updatedAssets.school_stamp_path
    ]);

    // A new file with another extension lives at another path: the old one
    // would otherwise stay public for good.
    await history.removeLiveFile(previousPath, fileName);
    await audit.record({
      ...audit.actorOf(req),
      action: 'school_asset.replace',
      entityType: 'school_asset',
      entityId: schoolId,
      summary: `${history.ASSET_LABELS[assetType]} ${previousPath ? 'replaced' : 'added'}`,
      changes: [{ key: assetType, label: history.ASSET_LABELS[assetType], before: previousPath, after: fileName }],
    });

    res.json({
      status: 'success',
      message: 'Asset uploaded successfully',
      data: {
        ...toCamel(result.rows[0]),
        uploadedAsset: assetType,
        filePath: fileName,
        // The version the replaced file was kept as, when there was one.
        keptVersionId: kept ? kept.version_id : null
      }
    });
  } catch (error) {
    logger.error('Error uploading asset:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to upload asset',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete specific asset
const deleteAsset = async (req, res) => {
  try {
    const { schoolId, assetType } = req.params;

    if (!schoolId || !assetType) {
      return res.status(400).json({
        status: 'error',
        message: 'School ID and asset type are required'
      });
    }

    const allowedAssetTypes = ['logo', 'principal_signature', 'school_stamp'];
    if (!allowedAssetTypes.includes(assetType)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid asset type'
      });
    }

    // Get current assets
    const { rows: existingAssets } = await db.query(schoolAssetsQueries.getSchoolAssetsBySchoolId, [schoolId]);
    
    if (existingAssets.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'School assets not found'
      });
    }

    const currentAssets = existingAssets[0];
    const assetPath = currentAssets[`${assetType}_path`];

    // Deleting keeps the file as an earlier version first, so it can be restored.
    try {
      await history.archiveCurrent({
        schoolId, school: req.user.school, assetType, currentPath: assetPath,
        userId: req.user.userId, reason: 'deleted',
      });
    } catch (archiveError) {
      logger.error({ err: archiveError }, 'School asset delete stopped: the current file could not be kept');
      return res.status(500).json(NOT_KEPT);
    }

    if (assetPath) {
      // Delete from Supabase storage
      const { error } = await supabase.storage
        .from('school-assets')
        .remove([assetPath]);

      if (error) {
        logger.error('Supabase delete error:', error);
      }
    }

    // Update database to set asset path to null
    const updatedAssets = {
      logo_path: currentAssets.logo_path,
      principal_signature_path: currentAssets.principal_signature_path,
      school_stamp_path: currentAssets.school_stamp_path
    };
    
    updatedAssets[`${assetType}_path`] = null;

    const result = await db.query(schoolAssetsQueries.upsertSchoolAssets, [
      currentAssets.school_code,
      schoolId,
      updatedAssets.logo_path,
      updatedAssets.principal_signature_path,
      updatedAssets.school_stamp_path
    ]);

    if (assetPath) {
      await audit.record({
        ...audit.actorOf(req),
        action: 'school_asset.delete',
        entityType: 'school_asset',
        entityId: schoolId,
        summary: `${history.ASSET_LABELS[assetType]} removed`,
        changes: [{ key: assetType, label: history.ASSET_LABELS[assetType], before: assetPath, after: null }],
      });
    }

    res.json({
      status: 'success',
      message: 'Asset deleted successfully',
      data: toCamel(result.rows[0])
    });
  } catch (error) {
    logger.error('Error deleting asset:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete asset',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// GET /:schoolId/:assetType/versions -> the asset's earlier versions, newest first
const listAssetVersions = async (req, res) => {
  const { schoolId, assetType } = req.params;
  if (!history.isAssetType(assetType)) {
    return res.status(400).json({ status: 'error', message: 'Invalid asset type' });
  }
  try {
    const versions = await history.listVersions(schoolId, assetType);
    return res.json({ status: 'success', data: versions });
  } catch (error) {
    logger.error('Error listing school asset versions:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load earlier versions' });
  }
};

// POST /:schoolId/:assetType/versions/:versionId/restore -> the earlier version becomes the live file
const restoreAssetVersion = async (req, res) => {
  const { schoolId, assetType, versionId } = req.params;
  if (!history.isAssetType(assetType)) {
    return res.status(400).json({ status: 'error', message: 'Invalid asset type' });
  }
  if (!UUID_RE.test(versionId)) {
    return res.status(404).json({ status: 'error', message: 'Version not found' });
  }
  try {
    const restored = await history.restoreVersion({
      schoolId, schoolCode: req.user.school, assetType, versionId, userId: req.user.userId,
    });
    if (!restored) {
      return res.status(404).json({ status: 'error', message: 'Version not found' });
    }
    await audit.record({
      ...audit.actorOf(req),
      action: 'school_asset.restore',
      entityType: 'school_asset',
      entityId: schoolId,
      summary: `${history.ASSET_LABELS[assetType]} restored to an earlier version`,
      changes: [{ key: assetType, label: history.ASSET_LABELS[assetType], before: restored.previousPath, after: restored.livePath }],
    });
    return res.json({
      status: 'success',
      message: 'Earlier version restored',
      data: { ...toCamel(restored.assets), restoredAsset: assetType, filePath: restored.livePath },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error restoring a school asset version');
    return res.status(500).json({
      status: 'error',
      message: "The earlier version couldn't be restored. Nothing was changed.",
    });
  }
};

// Get all schools with their assets
const getAllSchoolsWithAssets = async (req, res) => {
  try {
    const result = await db.query(schoolAssetsQueries.getAllSchoolsWithAssets);
    
    res.json({
      status: 'success',
      data: result.rows.map(toCamel)
    });
  } catch (error) {
    logger.error('Error fetching all schools with assets:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch schools with assets',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get public bucket URL for school assets
const getSchoolAssetsFolderUrl = async (req, res) => {
  try {
    const { schoolCode } = req.params;

    if (!schoolCode) {
      return res.status(400).json({
        status: 'error',
        message: 'School code is required'
      });
    }

    // Get the folder path for the school
    const schoolFolder = schoolCode.replace(/\s+/g, '').toUpperCase();
    
    // Build public bucket URL (exclude 'public' since bucket is already public)
    const supabaseUrl = process.env.SUPABASE_URL;
    const baseUrl = `${supabaseUrl}/storage/v1/object/school-assets`;
    
    res.json({
      status: 'success',
      data: {
        baseUrl,
        schoolFolder,
        fullPath: `${baseUrl}/${schoolFolder}`,
        expiresIn: null // Public URLs don't expire
      }
    });
  } catch (error) {
    logger.error('Error getting public bucket URL:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to get bucket URL',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get signed URL for asset (legacy - keeping for compatibility)
const getAssetSignedUrl = async (req, res) => {
  try {
    const { filePath } = req.query;

    if (!filePath) {
      return res.status(400).json({
        status: 'error',
        message: 'File path is required'
      });
    }

    const { data, error } = await supabase
      .storage
      .from('school-assets')
      .createSignedUrl(filePath, 60 * 60); // valid for 1 hour

    if (error) {
      logger.error('Error creating signed URL:', error);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to create signed URL'
      });
    }

    res.json({
      status: 'success',
      data: {
        signedUrl: data.signedUrl,
        expiresIn: 3600 // seconds
      }
    });
  } catch (error) {
    logger.error('Error getting asset signed URL:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to get signed URL',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  upload,
  getSchoolAssetsBySchoolCode,
  getSchoolAssetsBySchoolId,
  uploadAsset,
  deleteAsset,
  listAssetVersions,
  restoreAssetVersion,
  getAllSchoolsWithAssets,
  getSchoolAssetsFolderUrl,
  getAssetSignedUrl
};