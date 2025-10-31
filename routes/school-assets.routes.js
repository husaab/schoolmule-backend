const express = require('express');
const router = express.Router();
const schoolAssetsController = require('../controllers/school-assets.controller');

// Get school assets by school code
router.get('/school-code/:schoolCode', schoolAssetsController.getSchoolAssetsBySchoolCode);

// Get school assets by school ID
router.get('/school-id/:schoolId', schoolAssetsController.getSchoolAssetsBySchoolId);

// Upload single asset (logo, principal_signature, or school_stamp)
router.post('/upload', schoolAssetsController.upload.single('file'), schoolAssetsController.uploadAsset);

// Delete specific asset
router.delete('/:schoolId/:assetType', schoolAssetsController.deleteAsset);

// Get all schools with their assets (admin view)
router.get('/all', schoolAssetsController.getAllSchoolsWithAssets);

// Get signed URL for school assets folder (10 min cache)
router.get('/folder-url/:schoolCode', schoolAssetsController.getSchoolAssetsFolderUrl);

// Get signed URL for asset file (legacy)
router.get('/signed-url', schoolAssetsController.getAssetSignedUrl);

module.exports = router;