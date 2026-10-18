import mongoose from "mongoose";
import Kit from "../models/Kit.js";
import { clearCache } from "../utils/cache.js";

// Fetch all kits for Admin dashboard
export const getAdminKits = async (req, res) => {
  try {
    const { search, approvalStatus, status, schoolName, classGrade } = req.query;

    const filter = {
      isDeleted: { $ne: true },
      status: { $nin: ["deleted"] }
    };

    if (approvalStatus && approvalStatus !== "all") {
      filter.approvalStatus = approvalStatus;
    }

    if (status && status !== "all") {
      filter.status = status;
    }

    if (schoolName && schoolName !== "all") {
      filter.schoolName = { $regex: schoolName, $options: "i" };
    }

    if (classGrade && classGrade !== "all") {
      filter.classGrade = { $regex: classGrade, $options: "i" };
    }

    if (search && search.trim()) {
      filter.$or = [
        { title: { $regex: search.trim(), $options: "i" } },
        { name: { $regex: search.trim(), $options: "i" } },
        { schoolName: { $regex: search.trim(), $options: "i" } },
        { sku: { $regex: search.trim(), $options: "i" } },
        { "items.name": { $regex: search.trim(), $options: "i" } }
      ];
    }

    const kits = await Kit.find(filter)
      .populate("sellerId", "name storeName email phone businessName city")
      .populate("items.productId", "name price images image category stock")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: kits.length,
      kits
    });
  } catch (error) {
    console.error("Admin fetch kits error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch kits", error: error.message });
  }
};

// Get single kit by ID for Admin
export const getAdminKitById = async (req, res) => {
  try {
    const kit = await Kit.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
      .populate("sellerId", "name storeName email phone businessName city")
      .populate("items.productId", "name price images image category stock");

    if (!kit) {
      return res.status(404).json({ success: false, message: "Kit bundle not found" });
    }

    res.json(kit);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch kit", error: error.message });
  }
};

// Admin Approve / Reject Kit
export const updateKitApproval = async (req, res) => {
  try {
    const { id } = req.params;
    const { approvalStatus, rejectionReason, approvalComment } = req.body;

    if (!["Approved", "Pending", "Rejected"].includes(approvalStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid approvalStatus. Choose 'Approved', 'Pending', or 'Rejected'."
      });
    }

    const kit = await Kit.findById(id);
    if (!kit) {
      return res.status(404).json({ success: false, message: "Kit bundle not found" });
    }

    kit.approvalStatus = approvalStatus;
    kit.isApproved = (approvalStatus === "Approved");
    if (rejectionReason !== undefined) kit.rejectionReason = rejectionReason;
    if (approvalComment !== undefined) kit.approvalComment = approvalComment;

    if (approvalStatus === "Approved") {
      kit.status = "available";
      kit.isApproved = true;
    } else if (approvalStatus === "Pending") {
      kit.status = "pending";
      kit.isApproved = false;
    } else if (approvalStatus === "Rejected") {
      kit.status = "inactive";
      kit.isApproved = false;
    }

    await kit.save();
    clearCache("/kits");
    clearCache("/products");

    res.json({
      success: true,
      message: `Kit bundle ${approvalStatus.toLowerCase()} successfully!`,
      kit
    });
  } catch (error) {
    console.error("Admin update kit approval error:", error);
    res.status(500).json({ success: false, message: "Failed to update kit approval", error: error.message });
  }
};

// Admin Create Official Platform Kit
export const createAdminKit = async (req, res) => {
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
      items,
      bundlePrice,
      price,
      stock,
      stockQuantity,
      sellerId,
      description,
      sku,
      gst,
      isGstInclusive,
      paymentMethodAllowed,
      status,
      image,
      images
    } = req.body;

    const kitTitle = (title || name || "").trim();
    if (!kitTitle) return res.status(400).json({ message: "Kit Title is required." });
    if (!schoolName) return res.status(400).json({ message: "School Name is required." });
    if (!classGrade) return res.status(400).json({ message: "Class/Grade is required." });

    let parsedItems = items;
    if (typeof items === "string") {
      try { parsedItems = JSON.parse(items); } catch { return res.status(400).json({ message: "Invalid items JSON" }); }
    }
    if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
      return res.status(400).json({ message: "Kit must contain at least one item." });
    }

    const imagePaths = [];
    if (req.files && req.files.length > 0) {
      req.files.forEach(f => imagePaths.push(`/uploads/products/${f.filename}`));
    }
    if (Array.isArray(images)) {
      images.forEach(img => { if (typeof img === "string" && img.trim()) imagePaths.push(img.trim()); });
    }
    if (image && typeof image === "string" && !imagePaths.includes(image.trim())) {
      imagePaths.unshift(image.trim());
    }

    const formattedItems = parsedItems.map(item => {
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

    const newKit = new Kit({
      sellerId: sellerId && mongoose.Types.ObjectId.isValid(String(sellerId)) ? sellerId : null,
      title: kitTitle,
      name: kitTitle,
      subtitle: subtitle || "",
      schoolName: schoolName.trim(),
      schoolCode: (schoolCode || "").trim(),
      gender: gender || "Unisex",
      classGrade: classGrade.trim(),
      badgeTag: badgeTag || "School Approved",
      badge: badgeTag || "School Approved",
      items: formattedItems,
      totalMrp,
      mrp: totalMrp,
      originalPrice: totalMrp,
      bundlePrice: finalBundlePrice,
      price: finalBundlePrice,
      stock: Number(stock !== undefined ? stock : (stockQuantity !== undefined ? stockQuantity : 50)),
      stockQuantity: Number(stockQuantity !== undefined ? stockQuantity : (stock !== undefined ? stock : 50)),
      sku: (sku || "").trim(),
      gst: Number(gst) || 5,
      isGstInclusive: isGstInclusive !== undefined ? Boolean(isGstInclusive) : true,
      images: imagePaths,
      image: imagePaths[0] || "",
      description: (description || "").trim(),
      paymentMethodAllowed: paymentMethodAllowed || "Both",
      status: status || "available",
      approvalStatus: "Approved",
      isApproved: true
    });

    await newKit.save();
    clearCache("/kits");
    clearCache("/products");

    res.status(201).json({
      success: true,
      message: "Admin Kit bundle created successfully!",
      kit: newKit
    });
  } catch (error) {
    console.error("Admin create kit error:", error);
    res.status(500).json({ success: false, message: "Failed to create kit", error: error.message });
  }
};

// Admin Update Kit Bundle
export const updateAdminKit = async (req, res) => {
  try {
    const { id } = req.params;
    const kit = await Kit.findById(id);
    if (!kit) {
      return res.status(404).json({ success: false, message: "Kit bundle not found" });
    }

    const updates = { ...req.body };
    if (updates.title || updates.name) {
      kit.title = (updates.title || updates.name).trim();
      kit.name = kit.title;
    }
    if (updates.schoolName) kit.schoolName = updates.schoolName.trim();
    if (updates.schoolCode !== undefined) kit.schoolCode = updates.schoolCode.trim();
    if (updates.gender) kit.gender = updates.gender;
    if (updates.classGrade) kit.classGrade = updates.classGrade.trim();
    if (updates.badgeTag) {
      kit.badgeTag = updates.badgeTag;
      kit.badge = updates.badgeTag;
    }
    if (updates.description !== undefined) kit.description = updates.description.trim();
    if (updates.sku !== undefined) kit.sku = updates.sku.trim();
    if (updates.gst !== undefined) kit.gst = Number(updates.gst);
    if (updates.status) kit.status = updates.status;
    if (updates.approvalStatus) {
      kit.approvalStatus = updates.approvalStatus;
      kit.isApproved = (updates.approvalStatus === "Approved");
    }

    if (updates.bundlePrice !== undefined || updates.price !== undefined) {
      kit.bundlePrice = Number(updates.bundlePrice !== undefined ? updates.bundlePrice : updates.price);
      kit.price = kit.bundlePrice;
    }

    if (updates.stock !== undefined || updates.stockQuantity !== undefined) {
      kit.stock = Number(updates.stock !== undefined ? updates.stock : updates.stockQuantity);
      kit.stockQuantity = kit.stock;
    }

    if (updates.items) {
      let parsedItems = updates.items;
      if (typeof updates.items === "string") {
        try { parsedItems = JSON.parse(updates.items); } catch {}
      }
      if (Array.isArray(parsedItems)) {
        kit.items = parsedItems.map(item => {
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

    if (updates.images && Array.isArray(updates.images)) {
      kit.images = updates.images;
      kit.image = updates.images[0] || "";
    }

    await kit.save();
    clearCache("/kits");
    clearCache("/products");

    res.json({
      success: true,
      message: "Kit bundle updated successfully!",
      kit
    });
  } catch (error) {
    console.error("Admin update kit error:", error);
    res.status(500).json({ success: false, message: "Failed to update kit", error: error.message });
  }
};

// Admin Delete Kit Bundle
export const deleteAdminKit = async (req, res) => {
  try {
    const { id } = req.params;
    const kit = await Kit.findByIdAndUpdate(
      id,
      { isDeleted: true, status: "deleted" },
      { new: true }
    );
    if (!kit) {
      return res.status(404).json({ success: false, message: "Kit bundle not found" });
    }
    clearCache("/kits");
    clearCache("/products");
    res.json({ success: true, message: "Kit bundle removed from platform successfully!" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to delete kit", error: error.message });
  }
};
