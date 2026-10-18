import express from "express";
import {
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  toggleAnnouncementStatus,
  deleteAnnouncement,
  broadcastPromotionalSms
} from "../controllers/announcementController.js";
import { authenticateAdmin } from "../middlewares/auth.js";

const router = express.Router();

// Public & Admin: Fetch all announcement bar items
router.get("/", getAnnouncements);

// Admin only: Add, Update, Toggle & Delete announcement items
router.post("/", authenticateAdmin, createAnnouncement);
router.post("/broadcast-sms", authenticateAdmin, broadcastPromotionalSms);
router.put("/:id", authenticateAdmin, updateAnnouncement);
router.patch("/:id/status", authenticateAdmin, toggleAnnouncementStatus);
router.delete("/:id", authenticateAdmin, deleteAnnouncement);

export default router;
