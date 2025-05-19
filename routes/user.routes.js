const express = require("express");
const { getAllUser, getUser, updateUser, deleteUser, updateInterest, getUserByEmail, updatePassword } = require("../controllers/user.controller");

const router = express.Router();

router.get("/", getAllUser);
router.get("/email/:email", getUserByEmail);
router.get("/:id", getUser);
router.put("/:id", updateUser);
router.delete("/:id", deleteUser)
router.put("/:id/password", updatePassword);

module.exports = router;