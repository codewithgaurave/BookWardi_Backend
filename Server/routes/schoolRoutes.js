import express from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import School from "../models/School.js";
import SchoolBulkOrder from "../models/SchoolBulkOrder.js";
import { cacheMiddleware, clearCache } from "../utils/cache.js";
import { downloadInvoice } from "../controllers/orderController.js";
import { broadcastRealtimeEvent } from "../services/realtimeService.js";

const router = express.Router();

const DEFAULT_CLASSES_ARRAY = [
  "Pre-Nursery", "Nursery", "LKG", "UKG", "Class 1", "Class 2", "Class 3",
  "Class 4", "Class 5", "Class 6", "Class 7", "Class 8",
  "Class 9", "Class 10", "Class 11", "Class 12"
];

function normalizeClasses(cls) {
  if (Array.isArray(cls) && cls.length > 0) return cls;
  if (typeof cls === "string" && cls.includes(",")) {
    return cls.split(",").map(s => s.trim()).filter(Boolean);
  }
  return DEFAULT_CLASSES_ARRAY;
}

// GET all partner schools with optional district/subdistrict filtering and pagination
router.get("/", cacheMiddleware(120), async (req, res) => {
  try {
    const { district, subdistrict, city, page, limit } = req.query;
    
    const query = {};
    if (district || subdistrict || city) {
      const conditions = [];
      if (district) {
        conditions.push({ district: new RegExp(district, "i") });
        conditions.push({ city: new RegExp(district, "i") });
        conditions.push({ address: new RegExp(district, "i") });
      }
      if (subdistrict) {
        conditions.push({ subdistrict: new RegExp(subdistrict, "i") });
        conditions.push({ address: new RegExp(subdistrict, "i") });
      }
      if (city) {
        conditions.push({ city: new RegExp(city, "i") });
      }
      if (conditions.length > 0) {
        query.$or = conditions;
      }
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 0; // 0 means return all if limit not explicitly specified

    const totalCount = await School.countDocuments(query);
    
    let schoolsQuery = School.find(query).sort({ createdAt: -1 });
    if (limitNum > 0) {
      schoolsQuery = schoolsQuery.skip((pageNum - 1) * limitNum).limit(limitNum);
    }
    
    const rawSchools = await schoolsQuery;

    // Ensure MongoDB school records store classes as an array
    const schools = await Promise.all(
      rawSchools.map(async (sch) => {
        if (!Array.isArray(sch.classes)) {
          sch.classes = normalizeClasses(sch.classes);
          try {
            await sch.save();
          } catch (e) {}
        }
        return sch;
      })
    );

    res.json({
      success: true,
      schools,
      total: totalCount,
      page: pageNum,
      limit: limitNum > 0 ? limitNum : totalCount,
      hasMore: limitNum > 0 ? (pageNum * limitNum < totalCount) : false
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET single school by ID
router.get("/:id", cacheMiddleware(120), async (req, res) => {
  try {
    const school = await School.findById(req.params.id);
    if (!school) {
      return res.status(404).json({ success: false, message: "School not found" });
    }
    res.json({ success: true, school });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create a new school (Admin onboarding)
router.post("/", async (req, res) => {
  try {
    const schoolData = req.body;
    if (!schoolData.name) {
      return res.status(400).json({ success: false, message: "School name is required." });
    }
    const shortName = schoolData.shortName || schoolData.code || schoolData.name.split(" ").map(w => w[0]).join("").slice(0, 8).toUpperCase();
    const code = schoolData.code || shortName;
    const schoolId = schoolData.schoolId || `SCH-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
    const school = new School({
      ...schoolData,
      shortName,
      code,
      schoolId,
      status: schoolData.status || "Partner Active"
    });
    await school.save();
    clearCache("school");
    res.status(201).json({ success: true, message: "School created successfully", school });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT update a school
router.put("/:id", async (req, res) => {
  try {
    const school = await School.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!school) {
      return res.status(404).json({ success: false, message: "School not found" });
    }
    clearCache("school");
    res.json({ success: true, message: "School updated successfully", school });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE a school
router.delete("/:id", async (req, res) => {
  try {
    const school = await School.findByIdAndDelete(req.params.id);
    if (!school) {
      return res.status(404).json({ success: false, message: "School not found" });
    }
    clearCache("school");
    res.json({ success: true, message: "School deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST submit a new School Bulk Order inquiry
router.post("/bulk-order", async (req, res) => {
  try {
    const {
      referenceId,
      institutionName,
      schoolId,
      institutionType,
      contactName,
      contactEmail,
      contactPhone,
      designation,
      address,
      city,
      state,
      pincode,
      requirements,
      totalQuantity,
      targetDeliveryDate,
      expectedQuotationDate,
      quotationDeadline,
      logoEmbroideryRequired,
      targetBudgetPerKit,
      additionalNotes
    } = req.body;

    if (!institutionName || !contactName || !contactPhone) {
      return res.status(400).json({
        success: false,
        message: "Please fill required fields: Institution Name, Contact Person, and Contact Phone Number."
      });
    }

    const uniqueTag = `${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;
    const refCode = referenceId || `BULK-${uniqueTag}`;

    const sanitizedRequirements = Array.isArray(requirements)
      ? requirements.map((reqItem) => ({
          category: reqItem.category || "General Bulk Procurement",
          itemName: reqItem.itemName || reqItem.name || "Bulk Item Demand",
          quantity: Number(reqItem.quantity) || 100,
          budgetPerUnit: Number(reqItem.budgetPerUnit || reqItem.budgetUnit) || 0,
          sellerPricePerUnit: Number(reqItem.sellerPricePerUnit || reqItem.sellerPrice) || 0,
          sampleImage: reqItem.sampleImage || (Array.isArray(reqItem.sampleImages) ? reqItem.sampleImages[0] : ""),
          sampleImages: Array.isArray(reqItem.sampleImages) ? reqItem.sampleImages : (reqItem.sampleImage ? [reqItem.sampleImage] : []),
          customizations: reqItem.customizations || "",
          notes: reqItem.notes || ""
        }))
      : [];

    const totalQty = Number(totalQuantity) || sanitizedRequirements.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
    const calculatedOverallBudget = Number(req.body.overallBudget) || sanitizedRequirements.reduce((sum, r) => sum + (r.quantity * r.budgetPerUnit), 0) || Number(targetBudgetPerKit) || 0;

    // Prepayment is NOT initiated by buyer; only specified by seller upon quotation
    const buyerAdvType = req.body.buyerAdvanceType || "percentage";
    const buyerAdvPct = Number(req.body.buyerAdvancePercentage) || 0;
    const buyerAdvAmt = Number(req.body.buyerAdvanceAmount) || 0;

    let authUserId = null;
    let authUserPhone = "";
    let authUserEmail = "";
    const authHeader = req.headers["authorization"] || "";
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const rawToken = authHeader.split(" ")[1]?.trim();
        if (rawToken && rawToken !== "undefined" && rawToken !== "null") {
          const decoded = jwt.decode(rawToken);
          if (decoded) {
            authUserId = decoded.id || decoded._id || decoded.userId || null;
            authUserPhone = decoded.phone || decoded.mobile || "";
            authUserEmail = decoded.email || "";
          }
        }
      } catch (e) {}
    }

    const userId = req.user?.id || req.user?._id || authUserId || req.headers["x-user-id"] || req.body.userId || null;
    const userPhone = req.body.userPhone || req.headers["x-user-phone"] || authUserPhone || contactPhone || "";
    const userEmail = req.body.userEmail || req.headers["x-user-email"] || authUserEmail || contactEmail || "";

    const bulkOrder = new SchoolBulkOrder({
      referenceId: refCode,
      institutionName,
      schoolId: schoolId || "",
      institutionType: institutionType || "K-12 School",
      contactName,
      contactEmail: contactEmail || "",
      contactPhone,
      designation: designation || "Administrator",
      userId: userId && mongoose.Types.ObjectId.isValid(userId) ? userId : null,
      customUserId: userId ? String(userId).trim() : "",
      userPhone,
      userEmail,
      address: address || "",
      city: city || "",
      state: state || "",
      pincode: pincode || "",
      requirements: sanitizedRequirements,
      totalQuantity: totalQty,
      overallBudget: calculatedOverallBudget,
      targetDeliveryDate: targetDeliveryDate || "",
      expectedQuotationDate: expectedQuotationDate || quotationDeadline || req.body.expectedQuotationReceivingDate || "",
      logoEmbroideryRequired: Boolean(logoEmbroideryRequired),
      targetBudgetPerKit: String(calculatedOverallBudget || targetBudgetPerKit || ""),
      additionalNotes: additionalNotes || "",
      buyerAdvanceType: buyerAdvType,
      buyerAdvancePercentage: buyerAdvPct,
      buyerAdvanceAmount: buyerAdvAmt,
      buyerAdvanceNote: req.body.buyerAdvanceNote || "",
      advancePaymentStatus: req.body.advancePaymentStatus || "pending",
      advanceReceiptNumber: "",
      assignmentMode: req.body.assignmentMode || "broadcast",
      status: "published"
    });

    await bulkOrder.save();

    try {
      broadcastRealtimeEvent({
        type: "SCHOOL_ORDER_UPDATED",
        orderId: bulkOrder.referenceId,
        institutionName: bulkOrder.institutionName,
        status: bulkOrder.status
      });
    } catch (rtErr) {}

    return res.status(201).json({
      success: true,
      message: "School Bulk Order inquiry submitted successfully and broadcast to sellers!",
      referenceId: bulkOrder.referenceId,
      bulkOrder
    });
  } catch (error) {
    console.error("School Bulk Order submission error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

import {
  getCustomerSchoolOrders,
  getSchoolOrderById,
  getAdminSchoolOrders,
  distributeSchoolOrder,
  setBulkOrderPrepaymentPercentage,
  approveSellerQuotation,
  confirmSellerAcceptance,
  confirmBuyerAcceptance,
  updateItemSellerPrices,
  downloadAdvanceReceipt,
  recordAdvancePayment,
  updateSellerSchoolOrder,
  submitBuyerCounterDemand,
  acceptBuyerCounterDemand,
  createSchoolBulkPrepaymentOrder,
  verifySchoolBulkPrepayment,
  createSchoolBulkRemainingPaymentOrder,
  verifySchoolBulkRemainingPayment
} from "../controllers/schoolBulkOrderController.js";

// GET Private Customer Bulk Orders
router.get("/bulk-orders/my-orders", getCustomerSchoolOrders);

// GET all School Bulk Orders (Admin view)
router.get("/bulk-orders/list", getAdminSchoolOrders);
router.get("/bulk-orders/admin-list", getAdminSchoolOrders);

// GET single School Bulk Order by ID or referenceId
router.get("/bulk-orders/:id", getSchoolOrderById);

// PATCH Admin Distribute Bulk Order (Direct, Selected, Broadcast)
router.patch("/bulk-orders/:id/distribute", distributeSchoolOrder);

// PATCH Admin Set Bulk Order Prepayment Percentage
router.patch("/bulk-orders/:id/prepayment-percentage", setBulkOrderPrepaymentPercentage);

// POST Buyer Submit 2nd Version / Counter-Demand on a Seller Quotation
router.post("/bulk-orders/:id/quotations/:quoteId/counter", submitBuyerCounterDemand);

// POST Seller / Admin Accept Buyer Counter-Demand on a Quotation
router.post("/bulk-orders/:id/quotations/:quoteId/accept-counter", acceptBuyerCounterDemand);

// POST Buyer Approve Specific Seller Quotation (Winning Quote)
router.post("/bulk-orders/:id/approve-quote", approveSellerQuotation);

// POST Seller Confirm Acceptance of Buyer-Accepted Quotation & Request Prepayment
router.post("/bulk-orders/:id/confirm-seller-acceptance", confirmSellerAcceptance);

// POST Buyer Confirm Seller's Acceptance of Counter-Demand & Proceed with Prepayment
router.post("/bulk-orders/:id/confirm-buyer-acceptance", confirmBuyerAcceptance);

// POST Create Online Razorpay Prepayment Order for Bulk Order
router.post("/bulk-orders/:id/advance-payment/create-order", createSchoolBulkPrepaymentOrder);

// POST Verify Razorpay Prepayment Signature and Release Order for Fulfillment
router.post("/bulk-orders/:id/advance-payment/verify", verifySchoolBulkPrepayment);

// POST Create Online Razorpay / UPI Order for Remaining Balance
router.post("/bulk-orders/:id/remaining-payment/create-order", createSchoolBulkRemainingPaymentOrder);

// POST Verify Razorpay Remaining Payment Signature and Mark Order Completed
router.post("/bulk-orders/:id/remaining-payment/verify", verifySchoolBulkRemainingPayment);

// PATCH Update Bulk Order Status & Self-Delivery Details (accepted, packed, out for delivery, received)
router.patch("/bulk-orders/:id/status", updateSellerSchoolOrder);

// PATCH Update Item-Level Seller Offered Prices
router.patch("/bulk-orders/:id/item-prices", updateItemSellerPrices);

// GET Download PDF Partial Advance Payment Receipt
router.get("/bulk-orders/:id/advance-receipt", downloadAdvanceReceipt);

// GET Download PDF Official Bulk Order Tax Invoice & PO Certificate
router.get("/bulk-orders/:id/invoice", downloadInvoice);

// PATCH/POST Record / Confirm Partial Advance Payment
router.patch("/bulk-orders/:id/advance-payment", recordAdvancePayment);
router.post("/bulk-orders/:id/advance-payment", recordAdvancePayment);

export default router;

