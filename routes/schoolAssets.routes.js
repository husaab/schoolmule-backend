const express = require('express');
const router = express.Router();
const schoolAssetsController = require('../controllers/schoolAssets.controller');

// Get school assets by school code

// RBAC + tenancy. Every route is pinned to the caller's own school: a code or
// id naming another school reads as missing. Uploading and deleting assets is
// school setup; listing every school's assets is the platform owner's.
const db = require('../config/database');
const logger = require('../logger');
const requirePlatformOwner = require('../middleware/requirePlatformOwner');
const { requirePermission } = require('../middleware/access');

const NOT_FOUND = { status: 'error', message: 'School not found' };
const sameCode = (req, code) => String(code || '').replace(/\s+/g, '').toUpperCase() === String(req.user.school).toUpperCase();
const ownSchoolCode = (pick) => (req, res, next) => (sameCode(req, pick(req)) ? next() : res.status(404).json(NOT_FOUND));
const ownSchoolId = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT 1 FROM schools WHERE school_id = $1 AND school_code = $2',
      [req.params.schoolId, req.user.school],
    );
    return rows.length ? next() : res.status(404).json(NOT_FOUND);
  } catch (error) {
    logger.error({ err: error }, 'Error checking school asset ownership');
    return res.status(404).json(NOT_FOUND);
  }
};
const ownAssetPath = (req, res, next) => {
  const p = String(req.query.filePath || '');
  if (!p) return next(); // the handler answers 400
  return !p.includes('..') && p.startsWith(`${String(req.user.school).toUpperCase()}/`)
    ? next()
    : res.status(403).json({ status: 'error', message: 'Not authorized for this file' });
};
const schoolSetup = requirePermission('school_setup');

router.get('/school-code/:schoolCode', ownSchoolCode((req) => req.params.schoolCode), schoolAssetsController.getSchoolAssetsBySchoolCode);

// Get school assets by school ID
router.get('/school-id/:schoolId', ownSchoolId, schoolAssetsController.getSchoolAssetsBySchoolId);

// Upload single asset (logo, principal_signature, or school_stamp)
router.post('/upload', schoolSetup, schoolAssetsController.upload.single('file'), ownSchoolCode((req) => req.body && req.body.schoolCode), schoolAssetsController.uploadAsset);

// Delete specific asset
router.delete('/:schoolId/:assetType', schoolSetup, ownSchoolId, schoolAssetsController.deleteAsset);

// Get all schools with their assets (admin view)
router.get('/all', requirePlatformOwner, schoolAssetsController.getAllSchoolsWithAssets);

// Get signed URL for school assets folder (10 min cache)
router.get('/folder-url/:schoolCode', ownSchoolCode((req) => req.params.schoolCode), schoolAssetsController.getSchoolAssetsFolderUrl);

// Get signed URL for asset file (legacy)
router.get('/signed-url', ownAssetPath, schoolAssetsController.getAssetSignedUrl);

module.exports = router;