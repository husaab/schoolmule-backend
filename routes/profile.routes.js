const express = require("express");
const controller = require("../controllers/profile.controller");
const push = require("../controllers/pushDevices.controller");
const { singleImage } = require("../utils/imageUpload");
const requireLiveQrCard = require("../middleware/requireLiveQrCard");

// The signed-in person's own avatar, photo and push notifications. Any verified role may use it
// (the student fence lists this prefix); everything is keyed on req.user. A
// student session from a voided or reprinted QR card is over here too (N4).
const router = express.Router();

router.use(requireLiveQrCard);

const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

router.get("/", controller.getProfile);
router.put("/avatar", controller.setAvatar);
router.post("/photo", singleImage({ field: "photo", maxBytes: PHOTO_MAX_BYTES }), controller.setPhoto);
router.delete("/photo", controller.deletePhoto);

// The mobile app's push notifications: this phone, and the switches.
router.put("/push-device", push.registerDevice);
router.post("/push-device/remove", push.removeDevice);
router.get("/push-preferences", push.getPreferences);
router.put("/push-preferences", push.setPreferences);

module.exports = router;
