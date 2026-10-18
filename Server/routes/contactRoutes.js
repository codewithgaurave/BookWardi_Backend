import express from "express";
import ContactMsg from "../models/ContactMsg.js";

const router = express.Router();

// POST /api/contact - Submit a contact message to contactsmsg collection
router.post("/", async (req, res) => {
  try {
    const { name, email, subject, message, phone } = req.body;

    if (!name || !email || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: "All required fields (name, email, subject, message) must be provided."
      });
    }

    const newMsg = await ContactMsg.create({
      name: name.trim(),
      email: email.trim(),
      subject: subject.trim(),
      message: message.trim(),
      phone: phone ? String(phone).trim() : ""
    });

    console.log(`✉️ [CONTACT MSG STORED] Saved to contactsmsg collection in bookvardi_db_final: ID ${newMsg._id}`);

    return res.status(201).json({
      success: true,
      message: "Your message has been sent and recorded successfully!",
      contact: newMsg
    });
  } catch (error) {
    console.error("Error saving contact message:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to save contact message to database.",
      error: error.message
    });
  }
});

// GET /api/contact - Fetch all submitted messages
router.get("/", async (req, res) => {
  try {
    const messages = await ContactMsg.find().sort({ createdAt: -1 });
    return res.json({
      success: true,
      count: messages.length,
      messages
    });
  } catch (error) {
    console.error("Error fetching contact messages:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch contact messages."
    });
  }
});

export default router;
