const express = require("express");
const multer = require("multer");
const {
  getPatchNotes, getUnreadPatchNotes, dismissPatchNotes, createPatchNote,
  updatePatchNote, deletePatchNote, uploadPatchNoteImage, getAllPatchNotes,
} = require("../controllers/patchNote.controller");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PNG, JPEG, GIF, and WebP images are allowed"));
    }
  },
});

router.get("/", getPatchNotes);
router.get("/unread", getUnreadPatchNotes);
router.post("/dismiss", dismissPatchNotes);
router.get("/all", getAllPatchNotes);
router.post("/create", createPatchNote);
router.patch("/:id", updatePatchNote);
router.delete("/:id", deletePatchNote);
router.post("/:id/image", upload.single("image"), uploadPatchNoteImage);

module.exports = router;
