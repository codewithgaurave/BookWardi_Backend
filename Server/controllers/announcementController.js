import Announcement from "../models/Announcement.js";
import User from "../models/User.js";
import Seller from "../models/Seller.js";
import {
  sendFast2SmsBackToSchoolPromo,
  sendFast2SmsSpecialDiscountPromo
} from "../services/smsService.js";

// Seed default announcement items if DB is empty
const defaultAnnouncements = [
  {
    text: "Free Delivery on Orders Over ₹99",
    badge: "FREE DELIVERY",
    link: "/offers",
    priority: 1,
    isActive: true,
    bgColor: "#0f766e",
    textColor: "#ffffff"
  },
  {
    text: "Exclusive Student & School Discounts Available",
    badge: "DISCOUNT",
    link: "/offers",
    priority: 2,
    isActive: true,
    bgColor: "#0f766e",
    textColor: "#ffffff"
  },
  {
    text: "7 Days Return & Exchange Assurance",
    badge: "TRUST",
    link: "/about-us",
    priority: 3,
    isActive: true,
    bgColor: "#0f766e",
    textColor: "#ffffff"
  }
];

// Get All Announcement Bar Items (Public & Admin)
export const getAnnouncements = async (req, res) => {
  try {
    let items = await Announcement.find().sort({ priority: 1, createdAt: -1 });

    // Seed defaults if empty
    if (items.length === 0) {
      items = await Announcement.insertMany(defaultAnnouncements);
    }

    const now = new Date();
    // Auto-disable expired items in DB
    const updates = [];
    for (const item of items) {
      if (item.expiryDate && new Date(item.expiryDate) <= now && item.isActive) {
        item.isActive = false;
        updates.push(item.save());
      }
    }
    if (updates.length > 0) {
      await Promise.all(updates);
    }

    res.json({
      success: true,
      count: items.length,
      announcements: items.map(item => ({
        ...item.toObject(),
        isExpired: item.expiryDate ? new Date(item.expiryDate) <= now : false
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch announcements", error: error.message });
  }
};

// Create New Top Announcement Bar Item
export const createAnnouncement = async (req, res) => {
  try {
    const { text, badge, link, priority, isActive, expiryDate, bgColor, textColor } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ success: false, message: "Announcement message text is required." });
    }

    const announcement = new Announcement({
      text: text.trim(),
      badge: badge ? badge.trim() : "",
      link: link ? link.trim() : "",
      priority: Number(priority) || 1,
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      bgColor: bgColor || "#0f766e",
      textColor: textColor || "#ffffff"
    });

    await announcement.save();

    res.status(201).json({
      success: true,
      message: "Top Announcement Bar item created successfully.",
      announcement
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to create announcement", error: error.message });
  }
};

// Update Announcement Bar Item (text, priority, active state, expiry date, etc.)
export const updateAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const { text, badge, link, priority, isActive, expiryDate, bgColor, textColor } = req.body;

    const item = await Announcement.findById(id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Announcement item not found." });
    }

    if (text !== undefined) item.text = text.trim();
    if (badge !== undefined) item.badge = badge.trim();
    if (link !== undefined) item.link = link.trim();
    if (priority !== undefined) item.priority = Number(priority);
    if (isActive !== undefined) item.isActive = Boolean(isActive);
    if (expiryDate !== undefined) item.expiryDate = expiryDate ? new Date(expiryDate) : null;
    if (bgColor !== undefined) item.bgColor = bgColor;
    if (textColor !== undefined) item.textColor = textColor;

    await item.save();

    res.json({
      success: true,
      message: "Announcement item updated successfully.",
      announcement: item
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update announcement", error: error.message });
  }
};

// Toggle Enable / Disable Announcement Item
export const toggleAnnouncementStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const item = await Announcement.findById(id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Announcement item not found." });
    }

    item.isActive = isActive !== undefined ? Boolean(isActive) : !item.isActive;
    await item.save();

    res.json({
      success: true,
      message: `Announcement item ${item.isActive ? "ENABLED" : "DISABLED"} successfully.`,
      announcement: item
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to toggle announcement status", error: error.message });
  }
};

// Delete Announcement Item
export const deleteAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;

    const item = await Announcement.findByIdAndDelete(id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Announcement item not found." });
    }

    res.json({
      success: true,
      message: "Announcement item deleted successfully."
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to delete announcement", error: error.message });
  }
};

// Broadcast Approved Fast2SMS DLT Promotional SMS (Templates 225925 / 225924)
export const broadcastPromotionalSms = async (req, res) => {
  try {
    const { templateType, storeUrl, audience = "all", customPhones } = req.body;
    // templateType: "back_to_school" (DLT: 225925) or "special_discount" (DLT: 225924)

    let phoneNumbers = [];

    if (customPhones) {
      if (Array.isArray(customPhones)) {
        phoneNumbers = customPhones;
      } else if (typeof customPhones === "string" && customPhones.trim()) {
        phoneNumbers = customPhones.split(",").map(p => p.trim()).filter(Boolean);
      }
    } else {
      const phonesSet = new Set();
      if (audience === "all" || audience === "users") {
        const users = await User.find({ phone: { $exists: true, $ne: "" } }).select("phone");
        users.forEach(u => {
          if (u.phone) {
            const clean = String(u.phone).replace(/\D/g, "").slice(-10);
            if (clean.length === 10) phonesSet.add(clean);
          }
        });
      }
      if (audience === "all" || audience === "sellers") {
        const sellers = await Seller.find({ phone: { $exists: true, $ne: "" } }).select("phone");
        sellers.forEach(s => {
          if (s.phone) {
            const clean = String(s.phone).replace(/\D/g, "").slice(-10);
            if (clean.length === 10) phonesSet.add(clean);
          }
        });
      }
      phoneNumbers = Array.from(phonesSet);
    }

    if (phoneNumbers.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid 10-digit mobile numbers found for promotional SMS broadcast."
      });
    }

    const results = [];
    for (const phone of phoneNumbers) {
      try {
        let resp;
        if (templateType === "back_to_school") {
          resp = await sendFast2SmsBackToSchoolPromo(phone, storeUrl || "https://bookvardi.in");
        } else {
          resp = await sendFast2SmsSpecialDiscountPromo(phone);
        }
        results.push({ phone, status: resp.success ? "sent" : "failed", message: resp.message });
      } catch (err) {
        results.push({ phone, status: "error", error: err.message });
      }
    }

    const successCount = results.filter(r => r.status === "sent").length;

    res.json({
      success: true,
      message: `Promotional broadcast completed. ${successCount} sent out of ${phoneNumbers.length}.`,
      templateType: templateType || "special_discount",
      totalRecipients: phoneNumbers.length,
      successCount,
      results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to dispatch promotional SMS broadcast",
      error: error.message
    });
  }
};

