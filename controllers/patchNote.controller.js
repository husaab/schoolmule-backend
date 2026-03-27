const db = require("../config/database");
const patchNoteQueries = require("../queries/patchNote.queries");
const supabase = require("../config/supabaseClient");
const logger = require("../logger");

const toCamel = (row) => ({
  patchNoteId: row.patch_note_id,
  title: row.title,
  body: row.body,
  version: row.version,
  category: row.category,
  targetRoles: row.target_roles,
  imageUrl: row.image_url,
  publishedAt: row.published_at,
  autoDismissAt: row.auto_dismiss_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const getPatchNotes = async (req, res) => {
  try {
    const role = req.user.role.toLowerCase();
    const { rows } = await db.query(patchNoteQueries.selectByRole, [role]);
    return res.status(200).json({ status: "success", data: rows.map(toCamel) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching patch notes" });
  }
};

const getUnreadPatchNotes = async (req, res) => {
  try {
    const role = req.user.role.toLowerCase();
    const userId = req.user.userId;
    const { rows } = await db.query(patchNoteQueries.selectUnread, [role, userId]);
    return res.status(200).json({
      status: "success",
      data: { hasUnread: rows.length > 0, notes: rows.map(toCamel) },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error checking unread patch notes" });
  }
};

const dismissPatchNotes = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { lastSeenPatchNoteId } = req.body;
    if (!lastSeenPatchNoteId) {
      return res.status(400).json({ status: "failed", message: "Missing lastSeenPatchNoteId" });
    }
    await db.query(patchNoteQueries.upsertDismissal, [userId, lastSeenPatchNoteId]);
    return res.status(200).json({ status: "success", message: "Dismissed" });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error dismissing patch notes" });
  }
};

const createPatchNote = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ status: "failed", message: "Admin access required" });
    }
    const { title, body, version, category, targetRoles, publishedAt, imageUrl } = req.body;
    if (!title || !body || !version || !category || !targetRoles || targetRoles.length === 0) {
      return res.status(400).json({ status: "failed", message: "Missing required fields" });
    }
    const pubDate = publishedAt || new Date().toISOString();
    const { rows } = await db.query(patchNoteQueries.create, [
      title, body, version, category, targetRoles, imageUrl || null, pubDate, req.user.userId,
    ]);
    return res.status(201).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error creating patch note" });
  }
};

const updatePatchNote = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ status: "failed", message: "Admin access required" });
    }
    const { id } = req.params;
    const { title, body, version, category, targetRoles, imageUrl, publishedAt } = req.body;
    const { rows } = await db.query(patchNoteQueries.update, [
      title || null, body || null, version || null, category || null,
      targetRoles || null, imageUrl !== undefined ? imageUrl : null,
      publishedAt || null, id,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ status: "failed", message: "Patch note not found" });
    }
    return res.status(200).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error updating patch note" });
  }
};

const deletePatchNote = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ status: "failed", message: "Admin access required" });
    }
    await db.query(patchNoteQueries.delete, [req.params.id]);
    return res.status(200).json({ status: "success", message: "Deleted" });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error deleting patch note" });
  }
};

const uploadPatchNoteImage = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ status: "failed", message: "Admin access required" });
    }
    if (!req.file) {
      return res.status(400).json({ status: "failed", message: "No image file provided" });
    }
    const { id } = req.params;
    const fileName = `${id}-${Date.now()}.${req.file.originalname.split('.').pop()}`;
    const { error: uploadError } = await supabase.storage
      .from("patch-note-images")
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (uploadError) {
      logger.error(uploadError);
      return res.status(500).json({ status: "failed", message: "Error uploading image" });
    }
    const { data: urlData } = supabase.storage.from("patch-note-images").getPublicUrl(fileName);
    const { rows } = await db.query(patchNoteQueries.updateImageUrl, [urlData.publicUrl, id]);
    if (rows.length === 0) {
      return res.status(404).json({ status: "failed", message: "Patch note not found" });
    }
    return res.status(200).json({ status: "success", data: { imageUrl: urlData.publicUrl } });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error uploading image" });
  }
};

const getAllPatchNotes = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ status: "failed", message: "Admin access required" });
    }
    const { rows } = await db.query(patchNoteQueries.selectAll);
    return res.status(200).json({ status: "success", data: rows.map(toCamel) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching patch notes" });
  }
};

module.exports = {
  getPatchNotes, getUnreadPatchNotes, dismissPatchNotes, createPatchNote,
  updatePatchNote, deletePatchNote, uploadPatchNoteImage, getAllPatchNotes,
};
