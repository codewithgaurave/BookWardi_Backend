import mongoose from "mongoose";
import Ticket from "../models/Ticket.js";
import Seller from "../models/Seller.js";

// Helper: Generate clean numeric Ticket ID
const generateTicketId = () => {
  return `TKT-${Math.floor(10000 + Math.random() * 90000)}`;
};

// 1. Create a Support Ticket (Seller or Customer)
export const createTicket = async (req, res) => {
  try {
    const {
      category = "payout",
      subject,
      message,
      email,
      phone = "",
      priority = "Medium",
      userType = "seller"
    } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ success: false, message: "Subject and Message are required." });
    }

    let sellerId = req.user?.id || req.body.sellerId || null;
    let storeName = "";
    let customerName = "";
    let resolvedEmail = email || req.user?.email || "";
    let resolvedPhone = phone || req.user?.phone || "";

    if (sellerId) {
      const seller = await Seller.findById(sellerId).lean().catch(() => null);
      if (seller) {
        storeName = seller.storeName || seller.businessName || "";
        customerName = seller.name || seller.ownerDetails?.ownerFullName || storeName;
        if (!resolvedEmail) resolvedEmail = seller.email;
        if (!resolvedPhone) resolvedPhone = seller.phone;
      }
    }

    if (!resolvedEmail) {
      return res.status(400).json({ success: false, message: "Contact email is required to receive ticket resolution." });
    }

    const tid = generateTicketId();

    const newTicket = await Ticket.create({
      id: tid,
      ticketId: tid,
      userType,
      sellerId,
      storeName: storeName || "Verified Merchant",
      customerName: customerName || storeName || "Merchant Partner",
      email: resolvedEmail.toLowerCase().trim(),
      phone: resolvedPhone,
      category,
      subject: subject.trim(),
      message: message.trim(),
      lastMessage: message.trim(),
      priority,
      status: "Open"
    });

    res.status(201).json({
      success: true,
      message: `Support ticket #${tid} created successfully. Our team will contact you at ${resolvedEmail}.`,
      ticket: newTicket
    });
  } catch (error) {
    console.error("❌ Error creating ticket:", error);
    res.status(500).json({ success: false, message: "Failed to create ticket", error: error.message });
  }
};

// 2. Get Tickets for Logged-In Seller
export const getSellerTickets = async (req, res) => {
  try {
    const sellerId = req.user?.id;
    const sellerEmail = req.user?.email;

    const query = {
      $or: [
        ...(sellerId ? [{ sellerId }] : []),
        ...(sellerEmail ? [{ email: sellerEmail.toLowerCase().trim() }] : [])
      ]
    };

    const tickets = await Ticket.find(query).sort({ createdAt: -1 }).lean();
    res.json({ success: true, count: tickets.length, tickets });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch seller tickets", error: error.message });
  }
};

// 3. Get All Tickets for Admin Console
export const getAdminTickets = async (req, res) => {
  try {
    const { status, category, userType, search } = req.query;
    const filter = {};

    if (status && status !== "all") {
      filter.status = status;
    }
    if (category && category !== "all") {
      filter.category = category;
    }
    if (userType && userType !== "all") {
      filter.userType = userType;
    }
    if (search) {
      filter.$or = [
        { id: { $regex: search, $options: "i" } },
        { subject: { $regex: search, $options: "i" } },
        { customerName: { $regex: search, $options: "i" } },
        { storeName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } }
      ];
    }

    const tickets = await Ticket.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, count: tickets.length, tickets });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch tickets", error: error.message });
  }
};

// 4. Update Ticket Lifecycle Status (Admin)
export const updateTicketStatusAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["Open", "In Progress", "Resolved", "Closed"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status value" });
    }

    const orConditions = [{ id }, { ticketId: id }];
    if (mongoose.Types.ObjectId.isValid(id)) {
      orConditions.push({ _id: id });
    }

    const ticket = await Ticket.findOneAndUpdate(
      { $or: orConditions },
      { $set: { status } },
      { new: true }
    );

    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found" });
    }

    res.json({ success: true, message: `Ticket #${ticket.id} status updated to '${status}'`, ticket });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update ticket status", error: error.message });
  }
};

// 5. Reply to Ticket (Admin)
export const replyTicketAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { replyText, status = "In Progress" } = req.body;

    if (!replyText || !replyText.trim()) {
      return res.status(400).json({ success: false, message: "Reply text is required" });
    }

    const orConditions = [{ id }, { ticketId: id }];
    if (mongoose.Types.ObjectId.isValid(id)) {
      orConditions.push({ _id: id });
    }

    const ticket = await Ticket.findOneAndUpdate(
      { $or: orConditions },
      {
        $push: {
          adminReplies: {
            reply: replyText.trim(),
            repliedAt: new Date(),
            repliedBy: req.user?.name || "Admin Support"
          }
        },
        $set: {
          lastMessage: `[Admin Response]: ${replyText.trim()}`,
          status
        }
      },
      { new: true }
    );

    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found" });
    }

    res.json({ success: true, message: `Reply added to ticket #${ticket.id}`, ticket });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to reply to ticket", error: error.message });
  }
};
