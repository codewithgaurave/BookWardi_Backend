import mongoose from "mongoose";
import Coupon from "../models/Coupon.js";
import SellerOffer from "../models/SellerOffer.js";

const formatCouponResponse = (c) => ({
  id: c._id ? String(c._id) : c.id,
  _id: c._id ? String(c._id) : c.id,
  code: c.code,
  title: c.title || `${c.code} Promo Offer`,
  description: c.description || "",
  subtitle: c.description || `${c.discount}${c.type === "percentage" ? "%" : "₹"} OFF`,
  discount: c.discount,
  discountValue: c.discount,
  type: c.type,
  discountType: (c.type === "fixed" || c.type === "flat") ? "flat" : "percentage",
  minAmount: c.minAmount || 0,
  minOrderValue: c.minAmount || 0,
  minOrderAmount: c.minAmount || 0,
  maxDiscount: c.maxDiscount || 0,
  usageLimit: c.usageLimit || 0,
  usageCount: c.usageCount || 0,
  status: c.status || "active",
  expiryDate: c.expiryDate,
  validUntil: c.expiryDate ? new Date(c.expiryDate).toISOString().split("T")[0] : "",
  createdRole: c.createdRole || "admin",
  sellerId: c.sellerId || null,
  storeId: c.storeId || null,
  applicableScope: c.applicableScope || "storewide",
  applicableProducts: c.applicableProducts || [],
  applicableKits: c.applicableKits || [],
  specificProductId: c.specificProductId || "",
  specificProductName: c.specificProductName || "",
  specificKitId: c.specificKitId || "",
  specificKitTitle: c.specificKitTitle || "",
  specificKitImage: c.specificKitImage || "",
  createdAt: c.createdAt,
  updatedAt: c.updatedAt
});

// 1. Validate & Apply Coupon
export const applyCoupon = async (req, res) => {
  try {
    const { code, cartTotal, cartItems } = req.body;

    if (!code) {
      return res.json({ success: false, message: "Coupon code is required" });
    }

    const totalNum = Number(cartTotal);
    if (cartTotal === undefined || isNaN(totalNum) || totalNum <= 0) {
      return res.json({ success: false, message: "Valid cart total is required" });
    }

    const cleanCode = String(code).toUpperCase().trim();
    let coupon = await Coupon.findOne({
      code: cleanCode,
      status: "active"
    });

    if (!coupon) {
      const offer = await SellerOffer.findOne({
        code: cleanCode,
        status: "active"
      });

      if (offer) {
        coupon = {
          code: offer.code,
          discount: offer.discountValue,
          type: (offer.discountType === "flat" || offer.discountType === "fixed") ? "fixed" : "percentage",
          minAmount: offer.minOrderAmount || 0,
          maxDiscount: offer.maxDiscount || 0,
          usageLimit: offer.usageLimit || 0,
          usageCount: offer.usageCount || 0,
          expiryDate: offer.endDate,
          sellerId: offer.sellerId,
          createdRole: "seller",
          applicableScope: offer.applicableScope || "storewide",
          applicableProducts: offer.applicableProducts || [],
          applicableKits: offer.applicableKits || [],
          specificProductId: offer.specificProductId || "",
          specificProductName: offer.specificProductName || "",
          specificKitId: offer.specificKitId || "",
          specificKitTitle: offer.specificKitTitle || "",
          specificKitImage: offer.specificKitImage || ""
        };
      }
    }

    if (!coupon) {
      return res.json({ success: false, message: "Invalid or inactive coupon code" });
    }

    // Check expiry
    if (coupon.expiryDate) {
      const expDate = new Date(coupon.expiryDate);
      if (typeof coupon.expiryDate === 'string' && !coupon.expiryDate.includes('T')) {
        expDate.setHours(23, 59, 59, 999);
      }
      if (expDate < new Date()) {
        if (typeof coupon.save === "function") {
          coupon.status = "expired";
          await coupon.save().catch(() => {});
        }
        return res.json({ success: false, message: "This coupon code has expired" });
      }
    }

    // Check usage limit / redemptions count
    const usageLimit = Number(coupon.usageLimit || 0);
    const usageCount = Number(coupon.usageCount || 0);
    if (usageLimit > 0 && usageCount >= usageLimit) {
      if (typeof coupon.save === "function" && coupon.status === "active") {
        coupon.status = "expired";
        await coupon.save().catch(() => {});
      }
      return res.json({
        success: false,
        message: "This coupon code has reached its maximum usage limit."
      });
    }

    const extractId = (val) => {
      if (!val) return null;
      if (typeof val === 'object') {
        return String(val._id || val.id || val.$oid || '').trim();
      }
      return String(val).trim();
    };

    // Determine coupon seller & product/kit scoping
    const targetSellerId = extractId(coupon.sellerId) || extractId(coupon.storeId);
    const isSellerScoped = Boolean(coupon.createdRole === "seller" || targetSellerId);
    const scope = coupon.applicableScope || "storewide";

    const applicableProds = (coupon.applicableProducts || [])
      .concat(coupon.specificProductId ? [coupon.specificProductId] : [])
      .map(p => extractId(p))
      .filter(Boolean);

    const applicableKits = (coupon.applicableKits || [])
      .concat(coupon.specificKitId ? [coupon.specificKitId] : [])
      .map(k => extractId(k))
      .filter(Boolean);

    let eligibleSubtotal = totalNum;

    if (Array.isArray(cartItems) && cartItems.length > 0) {
      const eligibleItems = cartItems.filter((item) => {
        const itemSellerId = extractId(item.sellerId) || extractId(item.sellerDetails?.sellerId) || extractId(item.seller) || extractId(item.storeId) || extractId(item.userId);
        const prodCandidateIds = [
          extractId(item.productId),
          extractId(item.id),
          extractId(item._id),
          extractId(item.customId),
          extractId(item.itemProductId)
        ].filter(Boolean);

        const kitCandidateIds = [
          extractId(item.kitId),
          extractId(item.bundleId),
          extractId(item.id),
          extractId(item._id)
        ].filter(Boolean);

        const isKit = Boolean(item.isKit || item.kitId || item.bundleId || item.itemType === 'kit' || item.type === 'kit' || (item.category && String(item.category).toLowerCase().includes('kit')));
        const isCustomized = Boolean(item.isCustomized || (item.name && item.name.includes('(Custom Bundle)')));

        const isProdMatched = applicableProds.length > 0 && prodCandidateIds.some(cand => applicableProds.some(p => p.toLowerCase() === cand.toLowerCase()));
        const isKitMatched = applicableKits.length > 0 && kitCandidateIds.some(cand => applicableKits.some(k => k.toLowerCase() === cand.toLowerCase()));

        if (isSellerScoped) {
          // Seller-created coupon applies ONLY to items from that seller
          if (targetSellerId && itemSellerId && itemSellerId.toLowerCase() !== targetSellerId.toLowerCase()) {
            return false;
          }
        }

        if (scope === "all_kits") {
          if (!isKit) return false;
          if (isCustomized) return false;
          return true;
        }

        if (scope === "specific_kit") {
          if (!isKit) return false;
          if (isCustomized) return false;
          const specificKitName = String(coupon.specificKitTitle || "").trim().toLowerCase();
          const isNameMatched = Boolean(specificKitName && item.name && String(item.name).toLowerCase().includes(specificKitName));
          if (applicableKits.length === 0 && !specificKitName) return false;
          return isKitMatched || isNameMatched;
        }

        if (scope === "specific_product") {
          if (isKit) return false;
          const specificProdName = String(coupon.specificProductName || "").trim().toLowerCase();
          const isNameMatched = Boolean(specificProdName && item.name && String(item.name).toLowerCase().includes(specificProdName));
          if (applicableProds.length === 0 && !specificProdName) return false;
          return isProdMatched || isNameMatched;
        }

        // Storewide / fallback logic
        if (applicableProds.length > 0) {
          if (isProdMatched) return true;
          if (applicableKits.length > 0 && isKit && !isCustomized) {
            return isKitMatched;
          }
          return false;
        }

        if (applicableKits.length > 0) {
          if (!isKit || isCustomized) return false;
          return isKitMatched;
        }

        return true;
      });

      if (eligibleItems.length === 0) {
        const hasCustomizedKitInCart = cartItems.some(i => i.isCustomized || (i.name && i.name.includes('(Custom Bundle)')));
        if ((scope === "specific_kit" || scope === "all_kits") && hasCustomizedKitInCart) {
          return res.json({
            success: false,
            message: "This coupon is only applicable when purchasing the full bundle of the kit."
          });
        }

        if (isSellerScoped) {
          return res.json({
            success: false,
            message: applicableProds.length > 0
              ? "This coupon is only applicable to specific products from this seller."
              : "This seller-created coupon is only applicable to products from this seller."
          });
        } else {
          return res.json({
            success: false,
            message: "This coupon is not applicable to any items in your cart."
          });
        }
      }

      const calculatedSum = eligibleItems.reduce((sum, item) => {
        const price = Number(item.price ?? item.sellingPrice ?? item.discountPrice ?? item.unitPrice ?? 0);
        const qty = Number(item.quantity ?? item.qty ?? 1);
        return sum + (price * qty);
      }, 0);

      eligibleSubtotal = calculatedSum > 0 ? calculatedSum : totalNum;
    }

    // Check minimum purchase requirement on eligible subtotal
    if (eligibleSubtotal < (coupon.minAmount || 0)) {
      return res.json({
        success: false,
        message: `Minimum purchase of ₹${coupon.minAmount} on eligible items is required to use this coupon.`
      });
    }

    // Calculate discount
    let discountAmount = 0;
    let isCapped = false;
    let uncappedDiscount = 0;
    const isPercent = coupon.type === "percentage" || coupon.type === "percent" || coupon.discountType === "percentage";
    const maxCap = Number(coupon.maxDiscount || coupon.maxDiscountAmount || coupon.maxCap || 0);

    if (isPercent) {
      uncappedDiscount = Math.round(((eligibleSubtotal * coupon.discount) / 100) * 100) / 100;
      discountAmount = uncappedDiscount;
      if (maxCap > 0 && discountAmount > maxCap) {
        discountAmount = maxCap;
        isCapped = true;
      }
    } else {
      uncappedDiscount = Math.min(eligibleSubtotal, coupon.discount);
      discountAmount = uncappedDiscount;
      if (maxCap > 0 && discountAmount > maxCap) {
        discountAmount = maxCap;
        isCapped = true;
      }
    }

    const finalPayable = Math.max(0, Math.round((totalNum - discountAmount) * 100) / 100);

    res.json({
      success: true,
      message: isCapped
        ? `Coupon applied successfully (Capped at Max ₹${coupon.maxDiscount})`
        : "Coupon applied successfully",
      coupon: {
        code: coupon.code,
        discount: coupon.discount,
        type: coupon.type,
        minAmount: coupon.minAmount,
        maxDiscount: coupon.maxDiscount || 0,
        usageLimit: coupon.usageLimit || 0,
        usageCount: coupon.usageCount || 0,
        createdRole: coupon.createdRole || (targetSellerId ? "seller" : "admin"),
        sellerId: targetSellerId,
        applicableScope: scope,
        specificProductId: coupon.specificProductId || null,
        specificKitId: coupon.specificKitId || null,
        applicableProducts: applicableProds,
        applicableKits: applicableKits
      },
      cartTotal: totalNum,
      eligibleSubtotal,
      discountAmount,
      isCapped,
      maxDiscount: coupon.maxDiscount || 0,
      finalPayable
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to apply coupon", error: error.message });
  }
};

// 2. Get All Active Coupons (Public list for storefront banners/promos/product pages)
export const getActiveCoupons = async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const rawCoupons = await Coupon.find({
      status: "active",
      $or: [
        { expiryDate: { $gte: todayStart } },
        { expiryDate: null },
        { expiryDate: { $exists: false } }
      ]
    }).sort({ createdAt: -1 });

    // Exclude coupons that reached max redemptions limit
    const coupons = rawCoupons.filter(c => {
      const uLimit = Number(c.usageLimit || 0);
      const uCount = Number(c.usageCount || 0);
      return !(uLimit > 0 && uCount >= uLimit);
    });

    const couponCodes = new Set(coupons.map(c => String(c.code).toUpperCase().trim()));

    // Also pull active seller offers that may not yet be in Coupon collection
    const rawSellerOffers = await SellerOffer.find({
      status: "active",
      $or: [
        { endDate: { $gte: todayStart } },
        { endDate: null },
        { endDate: { $exists: false } }
      ]
    }).sort({ createdAt: -1 });

    const sellerOffers = rawSellerOffers.filter(o => {
      const uLimit = Number(o.usageLimit || 0);
      const uCount = Number(o.usageCount || 0);
      return !(uLimit > 0 && uCount >= uLimit);
    });

    const formattedList = coupons.map(formatCouponResponse);

    for (const offer of sellerOffers) {
      const codeUpper = String(offer.code).toUpperCase().trim();
      if (!couponCodes.has(codeUpper)) {
        couponCodes.add(codeUpper);
        formattedList.push({
          id: offer._id ? String(offer._id) : offer.id,
          _id: offer._id ? String(offer._id) : offer.id,
          code: offer.code,
          title: offer.title || `${offer.code} Offer`,
          description: offer.description || "",
          subtitle: offer.description || `${offer.discountValue}${offer.discountType === "percentage" ? "%" : "₹"} OFF`,
          discount: offer.discountValue,
          discountValue: offer.discountValue,
          type: (offer.discountType === "flat" || offer.discountType === "fixed") ? "fixed" : "percentage",
          discountType: (offer.discountType === "flat" || offer.discountType === "fixed") ? "flat" : "percentage",
          minAmount: offer.minOrderAmount || 0,
          minOrderValue: offer.minOrderAmount || 0,
          minOrderAmount: offer.minOrderAmount || 0,
          maxDiscount: offer.maxDiscount || 0,
          usageLimit: offer.usageLimit || 0,
          usageCount: offer.usageCount || 0,
          status: offer.status || "active",
          expiryDate: offer.endDate,
          validUntil: offer.endDate ? new Date(offer.endDate).toISOString().split("T")[0] : "",
          createdRole: "seller",
          sellerId: offer.sellerId || null,
          storeId: offer.sellerId || null,
          applicableScope: offer.applicableScope || "storewide",
          applicableProducts: offer.applicableProducts || [],
          applicableKits: offer.applicableKits || [],
          specificProductId: offer.specificProductId || "",
          specificProductName: offer.specificProductName || "",
          specificKitId: offer.specificKitId || "",
          specificKitTitle: offer.specificKitTitle || "",
          specificKitImage: offer.specificKitImage || "",
          createdAt: offer.createdAt,
          updatedAt: offer.updatedAt
        });
      }
    }

    res.json(formattedList);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch coupons", error: error.message });
  }
};

// 3. Admin / Seller: Create or Update Coupon
export const createCoupon = async (req, res) => {
  try {
    const rawCode = req.body.code || req.body.couponCode;
    const rawDiscount = req.body.discount !== undefined ? req.body.discount : req.body.discountValue;
    const rawType = req.body.type || req.body.discountType || "percentage";
    const rawMin = req.body.minAmount !== undefined 
      ? req.body.minAmount 
      : (req.body.minOrderValue !== undefined ? req.body.minOrderValue : (req.body.minOrderAmount !== undefined ? req.body.minOrderAmount : 0));
    const rawExpiry = req.body.expiryDate || req.body.validUntil || req.body.endDate;

    if (!rawCode || rawDiscount === undefined || !rawExpiry) {
      return res.status(400).json({ message: "Coupon code, discount value, and expiry date are required" });
    }

    const cleanCode = String(rawCode).toUpperCase().trim();
    const cleanDiscount = Number(rawDiscount);
    if (isNaN(cleanDiscount) || cleanDiscount <= 0) {
      return res.status(400).json({ message: "Discount must be a positive number" });
    }

    const cleanType = (rawType === "flat" || rawType === "fixed") ? "fixed" : "percentage";
    const cleanMinAmount = Math.max(0, Number(rawMin || 0));
    const cleanExpiryDate = new Date(rawExpiry);
    if (isNaN(cleanExpiryDate.getTime())) {
      return res.status(400).json({ message: "Invalid expiry date provided" });
    }

    const title = req.body.title ? String(req.body.title).trim() : `${cleanCode} Promo Offer`;
    const description = req.body.description ? String(req.body.description).trim() : (req.body.subtitle || "");
    const maxDiscount = Number(req.body.maxDiscount || 0);
    const usageLimit = Number(req.body.usageLimit || 0);
    const storeId = req.body.storeId || req.body.sellerId || null;
    const sellerId = req.body.sellerId || req.body.storeId || null;
    const createdRole = req.body.createdRole || (sellerId || storeId ? "seller" : "admin");
    const applicableScope = req.body.applicableScope || "storewide";
    const applicableProducts = Array.isArray(req.body.applicableProducts) ? req.body.applicableProducts.map(String) : (req.body.specificProductId ? [String(req.body.specificProductId)] : []);
    const applicableKits = Array.isArray(req.body.applicableKits) ? req.body.applicableKits.map(String) : (req.body.specificKitId ? [String(req.body.specificKitId)] : []);
    const specificProductId = req.body.specificProductId || "";
    const specificProductName = req.body.specificProductName || "";
    const specificKitId = req.body.specificKitId || "";
    const specificKitTitle = req.body.specificKitTitle || "";
    const specificKitImage = req.body.specificKitImage || "";

    let coupon = await Coupon.findOne({ code: cleanCode });
    if (coupon) {
      coupon.title = title;
      coupon.description = description;
      coupon.discount = cleanDiscount;
      coupon.type = cleanType;
      coupon.minAmount = cleanMinAmount;
      coupon.maxDiscount = maxDiscount;
      coupon.usageLimit = usageLimit;
      coupon.expiryDate = cleanExpiryDate;
      coupon.status = req.body.status || "active";
      if (storeId) coupon.storeId = storeId;
      if (sellerId) coupon.sellerId = sellerId;
      coupon.createdRole = createdRole;
      coupon.applicableScope = applicableScope;
      coupon.applicableProducts = applicableProducts;
      coupon.applicableKits = applicableKits;
      coupon.specificProductId = specificProductId;
      coupon.specificProductName = specificProductName;
      coupon.specificKitId = specificKitId;
      coupon.specificKitTitle = specificKitTitle;
      coupon.specificKitImage = specificKitImage;
      await coupon.save();
    } else {
      coupon = await Coupon.create({
        code: cleanCode,
        title,
        description,
        discount: cleanDiscount,
        type: cleanType,
        minAmount: cleanMinAmount,
        maxDiscount,
        usageLimit,
        usageCount: 0,
        status: req.body.status || "active",
        expiryDate: cleanExpiryDate,
        storeId,
        sellerId,
        createdRole,
        applicableScope,
        applicableProducts,
        applicableKits,
        specificProductId,
        specificProductName,
        specificKitId,
        specificKitTitle,
        specificKitImage
      });
    }

    const formatted = formatCouponResponse(coupon);
    res.status(201).json({ message: "Coupon created successfully", coupon: formatted });
  } catch (error) {
    res.status(500).json({ message: "Failed to create coupon", error: error.message });
  }
};

// 4. Admin: Get all coupons (with normalized fields)
export const getAllCouponsAdmin = async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    const couponCodes = new Set(coupons.map(c => String(c.code).toUpperCase().trim()));

    const sellerOffers = await SellerOffer.find().sort({ createdAt: -1 });
    const formattedList = coupons.map(formatCouponResponse);

    for (const offer of sellerOffers) {
      const codeUpper = String(offer.code).toUpperCase().trim();
      if (!couponCodes.has(codeUpper)) {
        couponCodes.add(codeUpper);
        formattedList.push({
          id: offer._id ? String(offer._id) : offer.id,
          _id: offer._id ? String(offer._id) : offer.id,
          code: offer.code,
          title: offer.title || `${offer.code} Offer`,
          description: offer.description || "",
          subtitle: offer.description || `${offer.discountValue}${offer.discountType === "percentage" ? "%" : "₹"} OFF`,
          discount: offer.discountValue,
          discountValue: offer.discountValue,
          type: (offer.discountType === "flat" || offer.discountType === "fixed") ? "fixed" : "percentage",
          discountType: (offer.discountType === "flat" || offer.discountType === "fixed") ? "flat" : "percentage",
          minAmount: offer.minOrderAmount || 0,
          minOrderValue: offer.minOrderAmount || 0,
          minOrderAmount: offer.minOrderAmount || 0,
          maxDiscount: offer.maxDiscount || 0,
          usageLimit: 0,
          usageCount: 0,
          status: offer.status || "active",
          expiryDate: offer.endDate,
          validUntil: offer.endDate ? new Date(offer.endDate).toISOString().split("T")[0] : "",
          createdRole: "seller",
          sellerId: offer.sellerId || null,
          storeId: offer.sellerId || null,
          applicableScope: offer.applicableScope || "storewide",
          applicableProducts: offer.applicableProducts || [],
          applicableKits: offer.applicableKits || [],
          specificProductId: offer.specificProductId || "",
          specificProductName: offer.specificProductName || "",
          specificKitId: offer.specificKitId || "",
          specificKitTitle: offer.specificKitTitle || "",
          specificKitImage: offer.specificKitImage || "",
          createdAt: offer.createdAt,
          updatedAt: offer.updatedAt
        });
      }
    }

    res.json(formattedList);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch coupons", error: error.message });
  }
};

// 5. Admin: Delete Coupon
export const deleteCoupon = async (req, res) => {
  try {
    const targetId = req.params.id;
    let deleted = false;

    if (mongoose.Types.ObjectId.isValid(targetId)) {
      const c = await Coupon.findByIdAndDelete(targetId);
      if (c) {
        deleted = true;
        await SellerOffer.findOneAndDelete({ code: c.code }).catch(() => {});
      } else {
        const o = await SellerOffer.findByIdAndDelete(targetId);
        if (o) deleted = true;
      }
    }

    if (!deleted) {
      const clean = String(targetId).toUpperCase().trim();
      await Coupon.findOneAndDelete({ code: clean });
      await SellerOffer.findOneAndDelete({ code: clean });
    }

    res.json({ message: "Coupon deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete coupon", error: error.message });
  }
};

// 6. Admin / Seller: Update Coupon Status or Details
export const updateCoupon = async (req, res) => {
  try {
    const targetId = req.params.id;
    const filter = mongoose.Types.ObjectId.isValid(targetId)
      ? { _id: targetId }
      : { code: String(targetId).toUpperCase().trim() };

    let coupon = await Coupon.findOne(filter);
    if (!coupon) {
      return res.status(404).json({ message: "Coupon not found" });
    }

    if (req.body.status) coupon.status = req.body.status;
    if (req.body.title) coupon.title = req.body.title;
    if (req.body.description !== undefined) coupon.description = req.body.description;
    if (req.body.discount !== undefined || req.body.discountValue !== undefined) {
      coupon.discount = Number(req.body.discount ?? req.body.discountValue);
    }
    if (req.body.type || req.body.discountType) {
      const rawT = req.body.type || req.body.discountType;
      coupon.type = (rawT === "flat" || rawT === "fixed") ? "fixed" : "percentage";
    }
    if (req.body.minAmount !== undefined || req.body.minOrderValue !== undefined) {
      coupon.minAmount = Number(req.body.minAmount ?? req.body.minOrderValue);
    }
    if (req.body.maxDiscount !== undefined) {
      coupon.maxDiscount = Number(req.body.maxDiscount || 0);
    }
    if (req.body.expiryDate || req.body.validUntil) {
      coupon.expiryDate = new Date(req.body.expiryDate || req.body.validUntil);
    }
    if (req.body.applicableScope) coupon.applicableScope = req.body.applicableScope;
    if (req.body.applicableProducts !== undefined) coupon.applicableProducts = Array.isArray(req.body.applicableProducts) ? req.body.applicableProducts.map(String) : [];
    if (req.body.applicableKits !== undefined) coupon.applicableKits = Array.isArray(req.body.applicableKits) ? req.body.applicableKits.map(String) : [];
    if (req.body.specificProductId !== undefined) coupon.specificProductId = req.body.specificProductId;
    if (req.body.specificProductName !== undefined) coupon.specificProductName = req.body.specificProductName;
    if (req.body.specificKitId !== undefined) coupon.specificKitId = req.body.specificKitId;
    if (req.body.specificKitTitle !== undefined) coupon.specificKitTitle = req.body.specificKitTitle;
    if (req.body.specificKitImage !== undefined) coupon.specificKitImage = req.body.specificKitImage;

    await coupon.save();
    res.json({ message: "Coupon updated successfully", coupon: formatCouponResponse(coupon) });
  } catch (error) {
    res.status(500).json({ message: "Failed to update coupon", error: error.message });
  }
};
