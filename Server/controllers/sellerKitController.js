import mongoose from "mongoose";
import Kit from "../models/Kit.js";
import Product from "../models/Product.js";
import Seller from "../models/Seller.js";
import User from "../models/User.js";
import { clearCache } from "../utils/cache.js";

const normalizeGender = (g) => {
  if (!g) return "Unisex";
  const str = String(g).trim();
  const valid = ["Boy", "Girl", "Boys", "Girls", "Unisex", "All"];
  const matched = valid.find((v) => v.toLowerCase() === str.toLowerCase());
  if (matched) return matched;
  if (str.toLowerCase() === "male") return "Boys";
  if (str.toLowerCase() === "female") return "Girls";
  return "Unisex";
};

const ALLOWED_BADGES = ["Best Seller", "New Arrival", "Verified KV", "School Approved", "Trending", "Special Offer", ""];
const normalizeBadge = (b) => {
  if (!b) return "School Approved";
  const str = String(b).trim();
  const matched = ALLOWED_BADGES.find((v) => v.toLowerCase() === str.toLowerCase());
  return matched !== undefined ? matched : "School Approved";
};

const normalizePaymentMethod = (p) => {
  if (!p) return "Both";
  const str = String(p).trim();
  if (["Both", "Online_Only", "COD_Only"].includes(str)) return str;
  if (str.toLowerCase().includes("online")) return "Online_Only";
  if (str.toLowerCase().includes("cod")) return "COD_Only";
  return "Both";
};

const normalizeKitStatus = (s) => {
  if (!s) return "available";
  const str = String(s).trim().toLowerCase();
  if (["available", "active"].includes(str)) return "available";
  if (["out-of-stock", "outofstock"].includes(str)) return "out-of-stock";
  if (["inactive", "disabled"].includes(str)) return "inactive";
  if (["deleted"].includes(str)) return "deleted";
  if (["pending", "draft"].includes(str)) return "pending";
  return "available";
};

const normalizeApprovalStatus = (s) => {
  if (!s) return "Pending";
  const str = String(s).trim().toLowerCase();
  if (str === "approved") return "Approved";
  if (str === "rejected") return "Rejected";
  return "Pending";
};

const isValidObjectId = (id) => {
  if (!id) return false;
  if (id instanceof mongoose.Types.ObjectId) return true;
  const str = String(id);
  return /^[0-9a-fA-F]{24}$/.test(str);
};

const getExpandedSellerIds = async (req) => {
  try {
    const sellerSet = new Set();
    const idStrings = new Set();

    // Fast-path: When req.seller is already resolved by authenticateSeller middleware
    if (req.seller && req.seller._id && isValidObjectId(req.seller._id)) {
      const strId = String(req.seller._id);
      idStrings.add(strId);
      sellerSet.add(new mongoose.Types.ObjectId(strId));
      if (req.user?.id && isValidObjectId(req.user.id)) {
        const uStr = String(req.user.id);
        if (!idStrings.has(uStr)) {
          idStrings.add(uStr);
          sellerSet.add(new mongoose.Types.ObjectId(uStr));
        }
      }
      return Array.from(sellerSet);
    }

    const rawIds = [
      req.user?.id,
      req.seller?._id,
      req.seller?.id,
      req.user?._id,
      req.user?.phone,
      req.seller?.phone,
      req.headers?.["x-seller-id"],
      req.headers?.["x-user-phone"],
      req.headers?.["x-seller-phone"],
      req.query?.sellerId
    ].filter(id => id && id !== "undefined" && id !== "null" && id !== "[object Object]");

    rawIds.forEach((id) => {
      if (isValidObjectId(id)) {
        const strId = String(id);
        if (!idStrings.has(strId)) {
          idStrings.add(strId);
          sellerSet.add(new mongoose.Types.ObjectId(strId));
        }
      }
    });

    const validObjectIds = Array.from(sellerSet);
    const phoneList = rawIds.map((id) => String(id).replace(/\D/g, "")).filter((p) => p.length >= 8);
    const phoneVariants = phoneList.flatMap((p) => {
      const digits10 = p.slice(-10);
      return [p, digits10, `+91${digits10}`, `+91 ${digits10}`];
    });

    const orConditions = [
      ...(validObjectIds.length > 0 ? [{ _id: { $in: validObjectIds } }] : []),
      ...(phoneVariants.length > 0 ? [{ phone: { $in: phoneVariants } }] : [])
    ];

    if (orConditions.length > 0) {
      const sellerDocs = await Seller.find({ $or: orConditions }).select("_id phone email").lean();
      sellerDocs.forEach((doc) => {
        if (doc._id && isValidObjectId(doc._id)) {
          const strId = String(doc._id);
          if (!idStrings.has(strId)) {
            idStrings.add(strId);
            sellerSet.add(new mongoose.Types.ObjectId(strId));
          }
        }
      });

      const userDocs = await User.find({ $or: orConditions }).select("_id phone email").lean();
      userDocs.forEach((doc) => {
        if (doc._id && isValidObjectId(doc._id)) {
          const strId = String(doc._id);
          if (!idStrings.has(strId)) {
            idStrings.add(strId);
            sellerSet.add(new mongoose.Types.ObjectId(strId));
          }
        }
      });
    }

    return Array.from(sellerSet);
  } catch (err) {
    console.error("getExpandedSellerIds error:", err);
    return [];
  }
};

// Get all kits created by the logged-in Seller
export const getSellerKits = async (req, res) => {
  try {
    const validObjectIds = await getExpandedSellerIds(req);

    if (validObjectIds.length === 0) {
      return res.json([]);
    }

    const filter = {
      isDeleted: { $ne: true },
      status: { $nin: ["deleted"] },
      $or: [
        { sellerId: { $in: validObjectIds } },
        { sellerId: { $in: validObjectIds.map(id => id.toString()) } }
      ]
    };

    const kits = await Kit.find(filter)
      .populate("items.productId", "name price images image category stock")
      .sort({ createdAt: -1 })
      .lean();
    res.json(kits);
  } catch (error) {
    console.error("Get seller kits error:", error);
    res.status(500).json({ message: "Failed to fetch kits", error: error.message });
  }
};

// Get single seller kit by ID
export const getSellerKitById = async (req, res) => {
  try {
    const validObjectIds = await getExpandedSellerIds(req);

    if (validObjectIds.length === 0) {
      return res.status(404).json({ message: "Kit bundle not found or unauthorized" });
    }

    const kit = await Kit.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
      status: { $nin: ["deleted"] },
      sellerId: { $in: validObjectIds }
    }).populate("items.productId", "name price images image category stock").lean();

    if (!kit) {
      return res.status(404).json({ message: "Kit bundle not found or unauthorized" });
    }

    res.json(kit);
  } catch (error) {
    console.error("Get seller kit by ID error:", error);
    res.status(500).json({ message: "Failed to fetch kit", error: error.message });
  }
};

// Create a New Complete Kit Bundle
export const createKit = async (req, res) => {
  try {
    const {
      title,
      name,
      subtitle,
      schoolName,
      schoolCode,
      gender,
      classGrade,
      badgeTag,
      badge,
      items,
      bundlePrice,
      price,
      stock,
      stockQuantity,
      inventoryMode,
      lowStockThreshold,
      description,
      sku,
      gst,
      isGstInclusive,
      paymentMethodAllowed,
      status,
      approvalStatus,
      image,
      images
    } = req.body;

    const kitTitle = (title || name || "").trim();
    if (!kitTitle) {
      return res.status(400).json({ message: "Kit Title is required." });
    }
    if (!schoolName) {
      return res.status(400).json({ message: "School Name is required." });
    }
    if (!classGrade) {
      return res.status(400).json({ message: "Target Class/Grade is required." });
    }

    // Parse items if stringified
    let parsedItems = items;
    if (typeof items === "string") {
      try {
        parsedItems = JSON.parse(items);
      } catch (e) {
        return res.status(400).json({ message: "Invalid items format. Must be a valid JSON array." });
      }
    }

    if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
      return res.status(400).json({
        message: "Kit bundle must contain at least one item (e.g. Uniform Shirt, Pant, Notebooks, etc.)."
      });
    }

    // Process image uploads from multer or string array
    const imagePaths = [];
    if (req.files && req.files.length > 0) {
      req.files.forEach((file) => {
        imagePaths.push(`/uploads/products/${file.filename}`);
      });
    }

    if (Array.isArray(images) && images.length > 0) {
      images.forEach((img) => {
        if (typeof img === "string" && img.trim() && !imagePaths.includes(img.trim())) {
          imagePaths.push(img.trim());
        }
      });
    } else if (typeof images === "string") {
      try {
        const parsedImgs = JSON.parse(images);
        if (Array.isArray(parsedImgs)) {
          parsedImgs.forEach((img) => {
            if (typeof img === "string" && img.trim() && !imagePaths.includes(img.trim())) {
              imagePaths.push(img.trim());
            }
          });
        }
      } catch {}
    }

    if (image && typeof image === "string" && image.trim() && !imagePaths.includes(image.trim())) {
      imagePaths.unshift(image.trim());
    }

    // Format constituent items
    const formattedItems = parsedItems.map((item) => {
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const unitPrice = Number(item.unitPrice) || Number(item.price) || 0;
      return {
        productId: item.productId && mongoose.Types.ObjectId.isValid(String(item.productId)) ? item.productId : null,
        name: item.name || "Item",
        quantity,
        unitPrice,
        totalPrice: unitPrice * quantity,
        originalPrice: Number(item.originalPrice || item.mrp) || unitPrice,
        size: item.size || "",
        color: item.color || "",
        image: item.image || ""
      };
    });

    const totalMrp = formattedItems.reduce((acc, it) => acc + it.totalPrice, 0);
    const finalBundlePrice = Number(bundlePrice) || Number(price) || totalMrp;
    const savingsAmount = Math.max(0, totalMrp - finalBundlePrice);
    const discountPercentage = totalMrp > 0 ? Math.round((savingsAmount / totalMrp) * 100) : 0;

    const paymentAllowedStr = normalizePaymentMethod(paymentMethodAllowed);
    const paymentMethodsArr = paymentAllowedStr === "Online_Only"
      ? ["Online"]
      : (paymentAllowedStr === "COD_Only" ? ["COD"] : ["COD", "Online"]);

    const validObjectIds = await getExpandedSellerIds(req);
    const sellerId = (req.seller?._id && isValidObjectId(req.seller._id))
      ? new mongoose.Types.ObjectId(String(req.seller._id))
      : (validObjectIds.length > 0 ? validObjectIds[0] : null);

    const newKit = new Kit({
      sellerId,
      title: kitTitle,
      name: kitTitle,
      subtitle: subtitle || "",
      schoolName: schoolName.trim(),
      schoolCode: (schoolCode || "").trim(),
      gender: normalizeGender(gender),
      classGrade: classGrade.trim(),
      badgeTag: normalizeBadge(badgeTag || badge),
      badge: normalizeBadge(badgeTag || badge),
      items: formattedItems,
      totalMrp,
      mrp: totalMrp,
      originalPrice: totalMrp,
      bundlePrice: finalBundlePrice,
      price: finalBundlePrice,
      savingsAmount,
      discountPercentage,
      stock: Number(stock !== undefined ? stock : (stockQuantity !== undefined ? stockQuantity : 10)),
      stockQuantity: Number(stockQuantity !== undefined ? stockQuantity : (stock !== undefined ? stock : 10)),
      inventoryMode: inventoryMode === "dynamic" ? "dynamic" : "fixed",
      lowStockThreshold: Number(lowStockThreshold) || 5,
      sku: (sku || "").trim(),
      gst: Number(gst) || 5,
      isGstInclusive: isGstInclusive !== undefined ? Boolean(isGstInclusive) : true,
      images: imagePaths,
      image: imagePaths[0] || "",
      description: (description || "").trim(),
      paymentMethodAllowed: paymentAllowedStr,
      paymentMethodsAllowed: paymentMethodsArr,
      status: normalizeKitStatus(status || "available"),
      approvalStatus: normalizeApprovalStatus(approvalStatus || "Pending"),
      isApproved: normalizeApprovalStatus(approvalStatus || "Pending") === "Approved"
    });

    await newKit.save();
    clearCache("/kits");

    res.status(201).json({
      message: "Kit Bundle submitted successfully! Awaiting Admin review and approval.",
      kit: newKit
    });
  } catch (error) {
    console.error("Create kit error:", error);
    res.status(500).json({ message: "Failed to create kit", error: error.message });
  }
};

// Update Kit Bundle
export const updateKit = async (req, res) => {
  try {
    const { id } = req.params;
    const validObjectIds = await getExpandedSellerIds(req);

    if (validObjectIds.length === 0) {
      return res.status(404).json({ message: "Kit bundle not found or unauthorized" });
    }

    const kit = await Kit.findOne({
      _id: id,
      sellerId: { $in: validObjectIds }
    });

    if (!kit) {
      return res.status(404).json({ message: "Kit bundle not found or unauthorized" });
    }

    const updates = { ...req.body };

    if (updates.title || updates.name) {
      kit.title = (updates.title || updates.name).trim();
      kit.name = kit.title;
    }
    if (updates.subtitle !== undefined) kit.subtitle = updates.subtitle;
    if (updates.schoolName) kit.schoolName = updates.schoolName.trim();
    if (updates.schoolCode !== undefined) kit.schoolCode = updates.schoolCode.trim();
    if (updates.gender) kit.gender = normalizeGender(updates.gender);
    if (updates.classGrade) kit.classGrade = updates.classGrade.trim();
    if (updates.badgeTag || updates.badge) {
      kit.badgeTag = normalizeBadge(updates.badgeTag || updates.badge);
      kit.badge = kit.badgeTag;
    }
    if (updates.description !== undefined) kit.description = updates.description.trim();
    if (updates.sku !== undefined) kit.sku = updates.sku.trim();
    if (updates.gst !== undefined) kit.gst = Number(updates.gst);
    if (updates.isGstInclusive !== undefined) kit.isGstInclusive = Boolean(updates.isGstInclusive);
    if (updates.status !== undefined) kit.status = normalizeKitStatus(updates.status);
    if (updates.approvalStatus !== undefined) {
      kit.approvalStatus = normalizeApprovalStatus(updates.approvalStatus);
      kit.isApproved = kit.approvalStatus === "Approved";
    }

    if (updates.bundlePrice !== undefined || updates.price !== undefined) {
      kit.bundlePrice = Number(updates.bundlePrice !== undefined ? updates.bundlePrice : updates.price);
      kit.price = kit.bundlePrice;
    }

    if (updates.stock !== undefined || updates.stockQuantity !== undefined) {
      kit.stock = Number(updates.stock !== undefined ? updates.stock : updates.stockQuantity);
      kit.stockQuantity = kit.stock;
    }

    if (updates.inventoryMode) kit.inventoryMode = updates.inventoryMode;
    if (updates.lowStockThreshold !== undefined) kit.lowStockThreshold = Number(updates.lowStockThreshold);

    if (updates.paymentMethodAllowed) {
      kit.paymentMethodAllowed = updates.paymentMethodAllowed;
      kit.paymentMethodsAllowed = updates.paymentMethodAllowed === "Online_Only"
        ? ["Online"]
        : (updates.paymentMethodAllowed === "COD_Only" ? ["COD"] : ["COD", "Online"]);
    }

    // Handle parsed items if provided
    if (updates.items) {
      let parsedItems = updates.items;
      if (typeof updates.items === "string") {
        try {
          parsedItems = JSON.parse(updates.items);
        } catch (e) {
          return res.status(400).json({ message: "Invalid items JSON format." });
        }
      }
      if (Array.isArray(parsedItems)) {
        kit.items = parsedItems.map((item) => {
          const quantity = Math.max(1, Number(item.quantity) || 1);
          const unitPrice = Number(item.unitPrice) || Number(item.price) || 0;
          return {
            productId: item.productId && mongoose.Types.ObjectId.isValid(String(item.productId)) ? item.productId : null,
            name: item.name || "Item",
            quantity,
            unitPrice,
            totalPrice: unitPrice * quantity,
            originalPrice: Number(item.originalPrice || item.mrp) || unitPrice,
            size: item.size || "",
            color: item.color || "",
            image: item.image || ""
          };
        });
      }
    }

    // Process new uploaded images
    const existingImages = Array.isArray(kit.images) ? [...kit.images] : [];
    if (updates.images) {
      let incomingImages = updates.images;
      if (typeof incomingImages === "string") {
        try { incomingImages = JSON.parse(incomingImages); } catch { incomingImages = [incomingImages]; }
      }
      if (Array.isArray(incomingImages)) {
        kit.images = incomingImages.filter(Boolean);
      }
    }

    if (req.files && req.files.length > 0) {
      const newImages = req.files.map((file) => `/uploads/products/${file.filename}`);
      kit.images = [...(kit.images || []), ...newImages];
    }

    if (kit.images && kit.images.length > 0) {
      kit.image = kit.images[0];
    }

    // When seller updates kit details, set approvalStatus to Pending for admin review
    kit.approvalStatus = "Pending";
    kit.isApproved = false;

    await kit.save();
    clearCache("/kits");

    res.json({
      message: "Kit bundle updated successfully!",
      kit
    });
  } catch (error) {
    console.error("Update kit error:", error);
    res.status(500).json({ message: "Failed to update kit", error: error.message });
  }
};

// Delete Kit Bundle
export const deleteKit = async (req, res) => {
  try {
    const { id } = req.params;
    const validObjectIds = await getExpandedSellerIds(req);

    if (validObjectIds.length === 0) {
      return res.status(404).json({ message: "Kit bundle not found or unauthorized" });
    }

    const kit = await Kit.findOneAndUpdate(
      {
        _id: id,
        sellerId: { $in: validObjectIds }
      },
      { isDeleted: true, status: "deleted" },
      { new: true }
    );

    if (!kit) {
      return res.status(404).json({ message: "Kit bundle not found or unauthorized" });
    }

    clearCache("/kits");

    res.json({ message: "Kit bundle deleted successfully!" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete kit", error: error.message });
  }
};
