const db = require("../config/database");
const schoolAssetsQueries = require("../queries/school-assets.queries");
const logger = require("../logger");
const supabase = require('../config/supabaseClient');
const multer = require('multer');
const path = require('path');

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

    // Get existing assets
    const { rows: existingAssets } = await db.query(schoolAssetsQueries.getSchoolAssetsBySchoolId, [schoolId]);
    
    const currentAssets = existingAssets.length > 0 ? existingAssets[0] : {};
    
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

    res.json({
      status: 'success',
      message: 'Asset uploaded successfully',
      data: {
        ...toCamel(result.rows[0]),
        uploadedAsset: assetType,
        filePath: fileName
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
  getAllSchoolsWithAssets,
  getSchoolAssetsFolderUrl,
  getAssetSignedUrl
};