import mongoose from "mongoose";
import SellerOffer from "../models/SellerOffer.js";
import Coupon from "../models/Coupon.js";

// Helper to extract authenticated seller ID
const resolveSellerId = (req) => {
  const id = req.user?.id || req.seller?._id || req.seller?.id || req.headers["x-seller-id"] || req.query?.sellerId || req.body?.sellerId || null;
  if (!id || id === "undefined" || id === "null" || id === "[object Object]") return null;
  return mongoose.Types.ObjectId.isValid(id) ? id : null;
};

// 1. Get All Offers for the Logged-in Seller
export const getSellerOffers = async (req, res) => {
  try {
    const sellerId = resolveSellerId(req);
    if (!sellerId) {
      return res.json([]);
    }
    const filter = { sellerId };
    const offers = await SellerOffer.find(filter).sort({ createdAt: -1 });

    const normalized = offers.map((o) => ({
      id: o._id,
      _id: o._id,
      code: o.code,
      title: o.title,
      description: o.description,
      discountType: o.discountType,
      discountValue: o.discountValue,
      minOrderAmount: o.minOrderAmount,
      minOrderValue: o.minOrderAmount,
      maxDiscount: o.maxDiscount,
      usageLimit: o.usageLimit || 0,
      usageCount: o.usageCount || 0,
      startDate: o.startDate,
      validFrom: o.startDate ? new Date(o.startDate).toISOString().split("T")[0] : "",
      endDate: o.endDate,
      validUntil: o.endDate ? new Date(o.endDate).toISOString().split("T")[0] : "",
      status: o.status,
      applicableScope: o.applicableScope || "storewide",
      applicableProducts: o.applicableProducts || [],
      applicableKits: o.applicableKits || [],
      specificProductId: o.specificProductId || "",
      specificProductName: o.specificProductName || "",
      specificKitId: o.specificKitId || "",
      specificKitTitle: o.specificKitTitle || "",
      specificKitImage: o.specificKitImage || "",
      createdAt: o.createdAt
    }));

    res.json(normalized);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch offers", error: error.message });
  }
};

// 2. Create a New Store Offer / Coupon
export const createSellerOffer = async (req, res) => {
  try {
    const sellerId = resolveSellerId(req);

    const {
      title,
      code,
      description,
      discountType,
      discountValue,
      minOrderAmount,
      minOrderValue,
      maxDiscount,
      usageLimit,
      startDate,
      validFrom,
      endDate,
      validUntil,
      applicableScope,
      specificProductId,
      specificProductName,
      specificKitId,
      specificKitTitle,
      specificKitImage,
      applicableProducts,
      applicableKits
    } = req.body;

    let targetApplicableProducts = [];
    if (Array.isArray(applicableProducts)) {
      targetApplicableProducts = applicableProducts.map(String);
    } else if (specificProductId) {
      targetApplicableProducts = [String(specificProductId)];
    }

    let targetApplicableKits = [];
    if (Array.isArray(applicableKits)) {
      targetApplicableKits = applicableKits.map(String);
    } else if (specificKitId) {
      targetApplicableKits = [String(specificKitId)];
    }

    const couponCode = code || req.body.couponCode;

    if (!couponCode || discountValue === undefined || (discountValue !== undefined && Number(discountValue) <= 0)) {
      return res.status(400).json({
        message: "Coupon code and a positive discount value are required."
      });
    }

    const cleanCode = String(couponCode).trim().toUpperCase();
    const offerTitle = title || cleanCode;
    const finalStartDate = startDate || validFrom ? new Date(startDate || validFrom) : new Date();
    const rawEndDate = endDate || validUntil;
    const finalEndDate = rawEndDate ? new Date(rawEndDate) : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    const finalMinAmount = Number(minOrderAmount ?? minOrderValue ?? 0);
    const finalMaxDiscount = Number(maxDiscount ?? 0);
    const finalUsageLimit = Number(usageLimit ?? 0);
    const scope = applicableScope || "storewide";

    let offer = null;
    if (sellerId && mongoose.Types.ObjectId.isValid(sellerId)) {
      offer = await SellerOffer.findOne({ sellerId, code: cleanCode });
    } else {
      offer = await SellerOffer.findOne({ code: cleanCode });
    }

    if (offer) {
      offer.title = offerTitle;
      offer.description = description || offer.description || "";
      offer.discountType = discountType || offer.discountType || "percentage";
      offer.discountValue = Number(discountValue);
      offer.minOrderAmount = finalMinAmount;
      offer.maxDiscount = finalMaxDiscount;
      offer.usageLimit = finalUsageLimit;
      offer.startDate = finalStartDate;
      offer.endDate = finalEndDate;
      offer.status = "active";
      offer.createdRole = "seller";
      offer.applicableScope = scope;
      offer.applicableProducts = targetApplicableProducts;
      offer.applicableKits = targetApplicableKits;
      if (specificProductId !== undefined) offer.specificProductId = specificProductId;
      if (specificProductName !== undefined) offer.specificProductName = specificProductName;
      if (specificKitId !== undefined) offer.specificKitId = specificKitId;
      if (specificKitTitle !== undefined) offer.specificKitTitle = specificKitTitle;
      if (specificKitImage !== undefined) offer.specificKitImage = specificKitImage;
      await offer.save();
    } else {
      const targetSellerId = (sellerId && mongoose.Types.ObjectId.isValid(sellerId))
        ? sellerId
        : new mongoose.Types.ObjectId();

      offer = new SellerOffer({
        sellerId: targetSellerId,
        title: offerTitle,
        code: cleanCode,
        description: description || "",
        discountType: discountType || "percentage",
        discountValue: Number(discountValue),
        minOrderAmount: finalMinAmount,
        maxDiscount: finalMaxDiscount,
        usageLimit: finalUsageLimit,
        usageCount: 0,
        startDate: finalStartDate,
        endDate: finalEndDate,
        status: "active",
        createdRole: "seller",
        applicableScope: scope,
        applicableProducts: targetApplicableProducts,
        applicableKits: targetApplicableKits,
        specificProductId: specificProductId || "",
        specificProductName: specificProductName || "",
        specificKitId: specificKitId || "",
        specificKitTitle: specificKitTitle || "",
        specificKitImage: specificKitImage || ""
      });
      await offer.save();
    }

    // Sync to Coupon collection for buyer cart validation
    try {
      await Coupon.findOneAndUpdate(
        { code: cleanCode },
        {
          code: cleanCode,
          discount: Number(discountValue),
          type: (discountType === "flat" || discountType === "fixed") ? "fixed" : "percentage",
          minAmount: finalMinAmount,
          maxDiscount: finalMaxDiscount,
          usageLimit: finalUsageLimit,
          expiryDate: finalEndDate,
          status: "active",
          storeId: offer.sellerId || null,
          sellerId: offer.sellerId || null,
          createdRole: "seller",
          applicableScope: scope,
          applicableProducts: targetApplicableProducts,
          applicableKits: targetApplicableKits,
          specificProductId: offer.specificProductId || "",
          specificProductName: offer.specificProductName || "",
          specificKitId: offer.specificKitId || "",
          specificKitTitle: offer.specificKitTitle || "",
          specificKitImage: offer.specificKitImage || ""
        },
        { upsert: true, new: true }
      );
    } catch (e) {
      console.warn("Coupon model sync notice:", e.message);
    }

    res.status(201).json({
      message: "Offer/Coupon created & saved to database successfully!",
      offer
    });
  } catch (error) {
    console.error("Create offer error:", error);
    res.status(500).json({ message: "Failed to create offer", error: error.message });
  }
};

// 3. Update Seller Offer
export const updateSellerOffer = async (req, res) => {
  try {
    const { id } = req.params;
    const sellerId = resolveSellerId(req);

    const filter = (sellerId && mongoose.Types.ObjectId.isValid(sellerId))
      ? { _id: id, sellerId }
      : { _id: id };

    const offer = await SellerOffer.findOne(filter);

    if (!offer) {
      return res.status(404).json({ message: "Offer not found" });
    }

    const {
      title,
      code,
      description,
      discountType,
      discountValue,
      minOrderAmount,
      minOrderValue,
      maxDiscount,
      usageLimit,
      startDate,
      validFrom,
      endDate,
      validUntil,
      status,
      applicableScope,
      applicableProducts,
      applicableKits,
      specificProductId,
      specificProductName,
      specificKitId,
      specificKitTitle,
      specificKitImage
    } = req.body;

    if (title) offer.title = title;
    if (code) offer.code = String(code).trim().toUpperCase();
    if (description !== undefined) offer.description = description;
    if (discountType) offer.discountType = discountType;
    if (discountValue !== undefined) offer.discountValue = Number(discountValue);
    if (minOrderAmount !== undefined || minOrderValue !== undefined) {
      offer.minOrderAmount = Number(minOrderAmount ?? minOrderValue);
    }
    if (maxDiscount !== undefined) offer.maxDiscount = Number(maxDiscount);
    if (usageLimit !== undefined) offer.usageLimit = Number(usageLimit);
    if (startDate || validFrom) offer.startDate = new Date(startDate || validFrom);
    if (endDate || validUntil) offer.endDate = new Date(endDate || validUntil);
    if (status) offer.status = status;
    if (applicableScope) offer.applicableScope = applicableScope;
    if (applicableProducts !== undefined) offer.applicableProducts = Array.isArray(applicableProducts) ? applicableProducts.map(String) : [];
    if (applicableKits !== undefined) offer.applicableKits = Array.isArray(applicableKits) ? applicableKits.map(String) : [];
    if (specificProductId !== undefined) offer.specificProductId = specificProductId;
    if (specificProductName !== undefined) offer.specificProductName = specificProductName;
    if (specificKitId !== undefined) offer.specificKitId = specificKitId;
    if (specificKitTitle !== undefined) offer.specificKitTitle = specificKitTitle;
    if (specificKitImage !== undefined) offer.specificKitImage = specificKitImage;

    await offer.save();

    // Sync to Coupon collection
    try {
      await Coupon.findOneAndUpdate(
        { code: offer.code },
        {
          code: offer.code,
          discount: offer.discountValue,
          type: (offer.discountType === "flat" || offer.discountType === "fixed") ? "fixed" : "percentage",
          minAmount: offer.minOrderAmount,
          maxDiscount: offer.maxDiscount || 0,
          usageLimit: offer.usageLimit || 0,
          expiryDate: offer.endDate,
          status: offer.status === "active" ? "active" : "inactive",
          applicableScope: offer.applicableScope,
          applicableProducts: offer.applicableProducts,
          applicableKits: offer.applicableKits,
          specificProductId: offer.specificProductId,
          specificProductName: offer.specificProductName,
          specificKitId: offer.specificKitId,
          specificKitTitle: offer.specificKitTitle,
          specificKitImage: offer.specificKitImage
        },
        { upsert: true }
      );
    } catch (e) {}

    res.json({
      message: "Offer updated successfully!",
      offer
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update offer", error: error.message });
  }
};

// 4. Delete Seller Offer
export const deleteSellerOffer = async (req, res) => {
  try {
    const { id } = req.params;
    const sellerId = resolveSellerId(req);

    const offer = await SellerOffer.findOneAndDelete({ _id: id, ...(sellerId ? { sellerId } : {}) });
    if (!offer) {
      return res.status(404).json({ message: "Offer not found or unauthorized" });
    }

    if (offer && offer.code) {
      try {
        await Coupon.findOneAndDelete({ code: offer.code });
      } catch (e) {}
    }

    res.json({ message: "Offer deleted successfully!" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete offer", error: error.message });
  }
};

// 5. Toggle Offer Active / Expired Status
export const toggleSellerOfferStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const sellerId = resolveSellerId(req);
    const offer = await SellerOffer.findOne({ _id: id, ...(sellerId ? { sellerId } : {}) });
    if (!offer) {
      return res.status(404).json({ message: "Offer not found or unauthorized" });
    }

    offer.status = offer.status === "active" ? "expired" : "active";
    await offer.save();

    try {
      await Coupon.findOneAndUpdate(
        { code: offer.code },
        { status: offer.status === "active" ? "active" : "expired" }
      );
    } catch (e) {}

    res.json({
      message: `Offer status toggled to ${offer.status}`,
      status: offer.status,
      offer
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to toggle offer status", error: error.message });
  }
};
