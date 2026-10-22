import mongoose from "mongoose";
import Product from "../models/Product.js";
import Category from "../models/Category.js";
import Seller from "../models/Seller.js";
import User from "../models/User.js";
import { clearCache } from "../utils/cache.js";
import { saveBase64ToFile } from "./sellerAuthController.js";

// Helper function to safely parse array inputs from JSON or multipart form-data
const parseArray = (input) => {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter(Boolean);
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [trimmed];
      } catch (e) {
        // Fallback to comma separation
      }
    }
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

// Helper function to safely parse boolean inputs from JSON or multipart form-data
const parseBool = (val, defaultVal = true) => {
  if (val === undefined || val === null || val === "") return defaultVal;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (s === "false" || s === "0" || s === "off" || s === "no") return false;
    if (s === "true" || s === "1" || s === "on" || s === "yes") return true;
  }
  if (typeof val === "number") return val !== 0;
  return Boolean(val);
};

// Helper function to resolve expanded seller IDs across Seller and User collections
const getExpandedSellerIds = async (req) => {
  const sellerSet = new Set();

  // Fast-path: When req.seller is already authenticated & resolved by authenticateSeller middleware
  if (req.seller && req.seller._id) {
    sellerSet.add(req.seller._id);
    sellerSet.add(String(req.seller._id));
    if (req.seller.phone) {
      sellerSet.add(req.seller.phone);
      const cleanP = String(req.seller.phone).replace(/\D/g, "");
      if (cleanP.length >= 8) {
        const d10 = cleanP.slice(-10);
        sellerSet.add(d10);
        sellerSet.add(`+91${d10}`);
        sellerSet.add(`+91 ${d10}`);
      }
    }
    if (req.seller.email) sellerSet.add(req.seller.email);
    if (req.user?.id && mongoose.Types.ObjectId.isValid(req.user.id)) {
      sellerSet.add(new mongoose.Types.ObjectId(req.user.id));
      sellerSet.add(String(req.user.id));
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
    req.query?.sellerId
  ].filter(id => id && id !== "undefined" && id !== "null" && id !== "[object Object]");

  rawIds.forEach((id) => {
    sellerSet.add(String(id));
    if (mongoose.Types.ObjectId.isValid(id)) {
      sellerSet.add(new mongoose.Types.ObjectId(id));
    }
  });

  const validObjectIds = rawIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
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
      sellerSet.add(doc._id);
      sellerSet.add(String(doc._id));
      if (doc.phone) {
        sellerSet.add(doc.phone);
        const cleanP = String(doc.phone).replace(/\D/g, "");
        if (cleanP) {
          sellerSet.add(cleanP);
          sellerSet.add(cleanP.slice(-10));
          sellerSet.add(`+91${cleanP.slice(-10)}`);
          sellerSet.add(`+91 ${cleanP.slice(-10)}`);
        }
      }
      if (doc.email) sellerSet.add(doc.email);
    });

    const userDocs = await User.find({ $or: orConditions }).select("_id phone email").lean();
    userDocs.forEach((doc) => {
      sellerSet.add(doc._id);
      sellerSet.add(String(doc._id));
      if (doc.phone) {
        sellerSet.add(doc.phone);
        const cleanP = String(doc.phone).replace(/\D/g, "");
        if (cleanP) {
          sellerSet.add(cleanP);
          sellerSet.add(cleanP.slice(-10));
          sellerSet.add(`+91${cleanP.slice(-10)}`);
          sellerSet.add(`+91 ${cleanP.slice(-10)}`);
        }
      }
      if (doc.email) sellerSet.add(doc.email);
    });
  }

  return Array.from(sellerSet);
};

// Get Distinct Product Categories & Catalog Items for the Logged-in Seller
export const getSellerProductCategories = async (req, res) => {
  try {
    const expandedSellerIds = await getExpandedSellerIds(req);
    const validObjectIds = expandedSellerIds
      .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (validObjectIds.length === 0) {
      return res.json({ categories: [], items: [] });
    }

    const filter = {
      $or: [
        { sellerId: { $in: validObjectIds } },
        { userId: { $in: validObjectIds } },
        { seller: { $in: validObjectIds } },
        { user: { $in: validObjectIds } },
        { createdBy: { $in: validObjectIds } }
      ]
    };

    const categories = await Product.distinct("category", filter);
    const items = await Product.find(filter, "name price category status stock images").sort({ name: 1 }).lean();

    res.json({
      categories: categories.filter(Boolean),
      items: items.map(p => ({
        id: p._id,
        name: p.name,
        price: p.price,
        category: p.category,
        status: p.status,
        stock: p.stock
      }))
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch seller categories", error: error.message });
  }
};

// Get All Products for the Logged-in Seller (with optional filters)
export const getSellerProducts = async (req, res) => {
  try {
    const { category, schoolName, search, hasOffer, ageGroup, size } = req.query;
    const expandedSellerIds = await getExpandedSellerIds(req);
    const validObjectIds = expandedSellerIds
      .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (validObjectIds.length === 0) {
      return res.json([]);
    }

    let filter = {
      $or: [
        { sellerId: { $in: validObjectIds } },
        { userId: { $in: validObjectIds } },
        { seller: { $in: validObjectIds } },
        { user: { $in: validObjectIds } },
        { createdBy: { $in: validObjectIds } }
      ]
    };

    if (category) filter.category = category;
    if (schoolName) filter.schoolName = { $regex: schoolName, $options: "i" };
    if (ageGroup) filter.ageGroup = { $regex: ageGroup, $options: "i" };
    if (size) filter.sizes = { $in: [size] };
    if (hasOffer === "true") filter["offer.hasOffer"] = true;

    if (search) {
      const searchRegex = { $regex: search, $options: "i" };
      const searchOr = [
        { name: searchRegex },
        { description: searchRegex },
        { schoolName: searchRegex },
        { category: searchRegex },
        { ageGroup: searchRegex }
      ];
      filter = { $and: [{ $or: filter.$or }, { $or: searchOr }] };
    }

    const products = await Product.find(filter).sort({ createdAt: -1 }).lean();
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch products", error: error.message });
  }
};

// Create a New Product by Seller
export const createProduct = async (req, res) => {
  try {
    const {
      name,
      category,
      subCategory,
      schoolName,
      schoolCode,
      classGrade,
      gender,
      ageGroup,
      ages,
      sizes,
      colors,
      material,
      brand,
      mrp,
      price,
      discountPercentage,
      stock,
      stockQuantity,
      unit,
      isMeterBased,
      minMeter,
      meterStep,
      isReturnable,
      isRefundable,
      returnWindowDays,
      sizeChart,
      description,
      tags,
      status,
      gst,
      gstPercentage,
      paymentMethodAllowed,
      paymentMethodsAllowed,
      offerDiscountType,
      offerDiscountValue,
      offerStartDate,
      offerEndDate,
      hasOffer
    } = req.body;

    const parsedPrice = price !== undefined ? Number(price) : (mrp !== undefined && discountPercentage !== undefined ? Number(mrp) - (Number(mrp) * Number(discountPercentage)) / 100 : undefined);
    const parsedStock = stock !== undefined ? Number(stock) : (stockQuantity !== undefined ? Number(stockQuantity) : 50);
    let parsedGst = gst !== undefined ? Number(gst) : (gstPercentage !== undefined ? Number(gstPercentage) : undefined);

    if (parsedGst === undefined && category) {
      try {
        const catDoc = await Category.findOne({ name: { $regex: new RegExp(`^${category.trim()}$`, "i") } });
        if (catDoc && catDoc.gstPercentage !== undefined) {
          parsedGst = catDoc.gstPercentage;
        }
      } catch (err) {}
    }
    if (parsedGst === undefined) parsedGst = 5;

    if (!name || !category || parsedPrice === undefined || parsedStock === undefined) {
      return res.status(400).json({
        message: "Product name, category, price (or MRP & discount %), and stock are required."
      });
    }

    // Process uploaded images & JSON payload images
    const imagePaths = [];
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      req.files.forEach((file) => {
        imagePaths.push(`/uploads/products/${file.filename}`);
      });
    }

    if (req.body && req.body.images) {
      let rawImages = req.body.images;
      if (typeof rawImages === "string") {
        try {
          rawImages = JSON.parse(rawImages);
        } catch (e) {
          rawImages = [rawImages];
        }
      }
      if (Array.isArray(rawImages)) {
        rawImages.forEach((img) => {
          if (img && typeof img === "string") {
            const savedPath = saveBase64ToFile(img, "products", "product");
            if (savedPath && !imagePaths.includes(savedPath)) {
              imagePaths.push(savedPath);
            }
          }
        });
      }
    }

    if (req.body && req.body.image && typeof req.body.image === "string") {
      const savedPath = saveBase64ToFile(req.body.image, "products", "product");
      if (savedPath && !imagePaths.includes(savedPath)) {
        imagePaths.unshift(savedPath);
      }
    }

    if (imagePaths.length === 0) {
      imagePaths.push("https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=500&auto=format&fit=crop&q=80");
    }

    // Configure per-product offer if requested
    const isOfferActive = hasOffer === "true" || hasOffer === true;
    const offerConfig = {
      hasOffer: isOfferActive,
      discountType: offerDiscountType || "percentage",
      discountValue: Number(offerDiscountValue) || 0,
      startDate: offerStartDate ? new Date(offerStartDate) : null,
      endDate: offerEndDate ? new Date(offerEndDate) : null,
      isActive: isOfferActive
    };

    const payMethod = paymentMethodAllowed || "Both";
    const payMethodsArr = payMethod === "COD_Only"
      ? ["COD"]
      : payMethod === "Online_Only"
      ? ["Online"]
      : (paymentMethodsAllowed ? parseArray(paymentMethodsAllowed) : ["COD", "Online"]);

    // Parse sizeVariants safely with all metadata fields (size, measureScale, measureValue, unit, price, mrp, stock, image, images, sku)
    let parsedSizeVariants = [];
    if (req.body.sizeVariants) {
      if (typeof req.body.sizeVariants === "string") {
        try {
          parsedSizeVariants = JSON.parse(req.body.sizeVariants);
        } catch (e) {
          parsedSizeVariants = [];
        }
      } else if (Array.isArray(req.body.sizeVariants)) {
        parsedSizeVariants = req.body.sizeVariants;
      }
    }

    if (Array.isArray(parsedSizeVariants)) {
      parsedSizeVariants = parsedSizeVariants.filter(v => 
        v && 
        !v.isBase && 
        String(v.size || '').trim().toLowerCase() !== 'base product' && 
        String(v.measureValue || '').trim().toLowerCase() !== 'base product' && 
        !String(v.id || '').startsWith('base_option_')
      );
    }

    // Parse sizeChart
    let parsedSizeChart = {};
    if (sizeChart) {
      if (typeof sizeChart === "string") {
        try { parsedSizeChart = JSON.parse(sizeChart); } catch (e) {}
      } else if (typeof sizeChart === "object") {
        parsedSizeChart = sizeChart;
      }
    }

    const formattedVariants = Array.isArray(parsedSizeVariants)
      ? parsedSizeVariants.map((v, vIdx) => {
          if (!v) return null;
          const sz = String(v.size || v.measureValue || v.name || v.label || "").trim();
          const mv = String(v.measureValue || v.size || sz).trim();
          const p = Number(v.price) || 0;
          const m = Number(v.mrp || v.originalPrice || v.regularPrice) || p;
          const st = Number(v.stock !== undefined ? v.stock : (v.stockQuantity !== undefined ? v.stockQuantity : 0)) || 0;
          
          const rawVImg = v.image || (Array.isArray(v.images) && v.images[0]) || "";
          const savedVImg = rawVImg ? saveBase64ToFile(rawVImg, "products", "prod") : "";
          
          let savedVImgs = [];
          if (Array.isArray(v.images) && v.images.length > 0) {
            savedVImgs = v.images.map((img, i) => {
              if (!img) return "";
              if (img === rawVImg && savedVImg) return savedVImg;
              return saveBase64ToFile(img, "products", "prod");
            }).filter(Boolean);
          }
          if (savedVImg && !savedVImgs.includes(savedVImg)) {
            savedVImgs.unshift(savedVImg);
          }
          const finalVImg = savedVImg || (savedVImgs[0] || "");
          const finalVImgs = Array.from(new Set([finalVImg, ...savedVImgs].filter(Boolean)));

          return {
            size: sz || mv || `Variant #${vIdx + 1}`,
            measureScale: String(v.measureScale || "size").trim(),
            measureValue: mv || sz || `Variant #${vIdx + 1}`,
            unit: String(v.unit || "Size").trim(),
            price: p,
            mrp: m,
            originalPrice: m,
            stock: st,
            stockQuantity: st,
            image: finalVImg,
            images: finalVImgs,
            sku: v.sku || `SKU-VAR-${vIdx + 1}`
          };
        }).filter(Boolean)
      : [];

    let resolvedSizes = parseArray(sizes);
    if (formattedVariants.length > 0) {
      resolvedSizes = Array.from(new Set([...resolvedSizes, ...formattedVariants.map(v => v.size)]));
    }

    const effectivePrice = parsedPrice !== undefined 
      ? parsedPrice 
      : (formattedVariants.length > 0 ? Math.min(...formattedVariants.map(v => v.price)) : 0);
      
    const effectiveStock = parsedStock !== undefined 
      ? parsedStock 
      : (formattedVariants.length > 0 ? formattedVariants.reduce((sum, v) => sum + v.stock, 0) : 50);

    const sellerId = req.user?.id || req.seller?._id || req.user?._id;

    const isMeter = unit === "meter" || isMeterBased === true || isMeterBased === "true";

    // 1. Sanitize sellerId / userId so invalid ObjectIds or "self" don't trigger Mongoose CastError
    let validSellerId = undefined;
    const rawSellerId = req.user?.id || req.seller?._id || req.user?._id || req.headers["x-seller-id"] || req.body?.sellerId;
    if (rawSellerId && mongoose.Types.ObjectId.isValid(String(rawSellerId)) && String(rawSellerId) !== "self") {
      validSellerId = new mongoose.Types.ObjectId(String(rawSellerId));
    }

    const primaryImg = imagePaths[0];

    // 2. Construct explicit clean payload (omitting frontend temporary numeric IDs like 1790349222826)
    const productPayload = {
      name: String(name).trim(),
      subtitle: req.body.subtitle || "",
      category: String(category).trim(),
      subCategory: subCategory || "",
      schoolName: schoolName || "",
      schoolCode: schoolCode || "",
      classGrade: classGrade || "",
      gender: ["Boy", "Girl", "Boys", "Girls", "Unisex", "All"].includes(gender) ? gender : "Unisex",
      ageGroup: ageGroup || "",
      ages: parseArray(ages),
      sizes: resolvedSizes,
      sizeVariants: formattedVariants,
      colors: parseArray(colors),
      material: material || "",
      brand: brand || "",
      gst: parsedGst,
      gstPercentage: parsedGst,
      isGstInclusive: parseBool(req.body.isGstInclusive, true),
      mrp: mrp !== undefined ? Number(mrp) : Number(effectivePrice),
      originalPrice: req.body.originalPrice !== undefined ? Number(req.body.originalPrice) : (mrp !== undefined ? Number(mrp) : Number(effectivePrice)),
      price: Number(effectivePrice),
      discountPercentage: discountPercentage !== undefined ? Number(discountPercentage) : 0,
      discountBadge: req.body.discountBadge || req.body.badge || "",
      badgeTag: req.body.badgeTag || req.body.badge || "",
      badge: req.body.badge || req.body.discountBadge || "",
      bundleType: req.body.bundleType || "single",
      sku: req.body.sku || "",
      kitItems: req.body.kitItems || req.body.items || [],
      items: req.body.items || req.body.kitItems || [],
      totalMrp: req.body.totalMrp ? Number(req.body.totalMrp) : 0,
      bundlePrice: req.body.bundlePrice ? Number(req.body.bundlePrice) : 0,
      sellerStoreName: req.seller?.storeName || req.seller?.name || req.body.sellerStoreName || req.body.storeName || "Book Vardi Store",
      sellerName: req.seller?.name || req.body.sellerName || "Book Vardi Store",
      storeName: req.seller?.storeName || req.body.storeName || "Book Vardi Store",
      legalBusinessName: req.seller?.legalBusinessName || req.body.legalBusinessName || "",
      sellerAcceptsCod: req.seller?.acceptsCod !== false,
      sellerAcceptsOnline: req.seller?.acceptsOnline !== false,
      stock: Number(effectiveStock),
      stockQuantity: Number(effectiveStock),
      unit: isMeter ? "meter" : (unit || "piece"),
      isMeterBased: isMeter,
      minMeter: minMeter ? Number(minMeter) : 0.5,
      meterStep: meterStep ? Number(meterStep) : 0.5,
      isReturnable: isReturnable === undefined ? true : (isReturnable === true || isReturnable === "true"),
      isRefundable: isRefundable === undefined ? true : (isRefundable === true || isRefundable === "true"),
      returnWindowDays: returnWindowDays ? Number(returnWindowDays) : 7,
      sizeChart: parsedSizeChart,
      description: description || "",
      tags: parseArray(tags),
      image: primaryImg,
      images: imagePaths,
      status: status || "available",
      approvalStatus: "Pending",
      approvalComment: "Product submitted by seller. Awaiting admin review.",
      paymentMethodAllowed: payMethod,
      paymentMethodsAllowed: payMethodsArr,
      offer: offerConfig
    };

    if (validSellerId) {
      productPayload.sellerId = validSellerId;
      productPayload.userId = validSellerId;
    }

    const newProduct = new Product(productPayload);

    await newProduct.save();
    clearCache('product');

    console.log("🆕 New Product Added to DB! Product ID:", newProduct._id);

    res.status(201).json({
      success: true,
      message: "Product added successfully! Submitted for admin approval.",
      product: newProduct
    });
  } catch (error) {
    console.error("Create product error:", error);
    res.status(500).json({ message: "Failed to create product", error: error.message });
  }
};

// Helper to verify if the requesting seller or admin owns the given product
export const checkProductOwnership = async (req, product) => {
  if (!product) return false;
  if (req.user?.role === "admin" || req.user?.role === "super_admin") return true;

  const expandedSellerIds = await getExpandedSellerIds(req);
  const expandedStrSet = new Set(expandedSellerIds.map(s => String(s)));

  const productOwnerIds = [
    product.sellerId,
    product.userId,
    product.seller,
    product.user,
    product.createdBy
  ].filter(Boolean).map(s => String(s));

  if (productOwnerIds.length === 0) {
    // If no explicit owner ID, check store name matching
    const productStore = (product.sellerStoreName || product.storeName || "").trim().toLowerCase();
    const requestingStore = (req.seller?.storeName || req.seller?.name || "").trim().toLowerCase();
    if (productStore && requestingStore && productStore === requestingStore) return true;
    return false;
  }
  return productOwnerIds.some(ownerId => expandedStrSet.has(ownerId));
};

// Update Product
export const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ message: "Invalid product ID format" });
    }

    let product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Authorization check: verify seller ownership across all seller reference fields
    const isOwner = await checkProductOwnership(req, product);
    if (!isOwner) {
      return res.status(403).json({ message: "Unauthorized to modify this product" });
    }

    const updates = { ...req.body };

    // Strip immutable / internal fields to prevent Mongoose CastError / immutable field errors
    delete updates._id;
    delete updates.id;
    delete updates.__v;
    delete updates.createdAt;
    delete updates.updatedAt;

    if (updates.gst !== undefined) {
      updates.gst = Number(updates.gst);
      updates.gstPercentage = Number(updates.gst);
    } else if (updates.gstPercentage !== undefined) {
      updates.gst = Number(updates.gstPercentage);
      updates.gstPercentage = Number(updates.gstPercentage);
    }

    if (updates.isGstInclusive !== undefined) {
      updates.isGstInclusive = parseBool(updates.isGstInclusive, true);
    }

    // Parse sizeVariants / variants safely
    const rawVariantsInput = updates.sizeVariants !== undefined ? updates.sizeVariants : updates.variants;
    if (rawVariantsInput !== undefined) {
      let parsedVariants = [];
      if (typeof rawVariantsInput === "string") {
        try {
          parsedVariants = JSON.parse(rawVariantsInput);
        } catch (e) {
          parsedVariants = [];
        }
      } else if (Array.isArray(rawVariantsInput)) {
        parsedVariants = rawVariantsInput;
      }

      if (Array.isArray(parsedVariants)) {
        parsedVariants = parsedVariants.filter(v => 
          v && 
          !v.isBase && 
          String(v.size || '').trim().toLowerCase() !== 'base product' && 
          String(v.measureValue || '').trim().toLowerCase() !== 'base product' && 
          !String(v.id || '').startsWith('base_option_')
        );
      }

      const formattedVariants = Array.isArray(parsedVariants)
        ? parsedVariants.map((v, vIdx) => {
            if (!v || typeof v !== "object") return null;
            const sz = String(v.size || v.measureValue || v.name || v.label || "").trim();
            const mv = String(v.measureValue || v.size || sz).trim();
            const p = (v.price !== undefined && !isNaN(Number(v.price))) ? Number(v.price) : Number(product.price || 0);
            const m = (v.mrp !== undefined && !isNaN(Number(v.mrp))) ? Number(v.mrp) : (v.originalPrice !== undefined && !isNaN(Number(v.originalPrice)) ? Number(v.originalPrice) : p);
            const st = Number(v.stock !== undefined ? v.stock : (v.stockQuantity !== undefined ? v.stockQuantity : 0)) || 0;

            const rawVImg = v.image || (Array.isArray(v.images) && v.images[0]) || "";
            const savedVImg = rawVImg ? saveBase64ToFile(rawVImg, "products", "prod") : "";
            let savedVImgs = [];
            if (Array.isArray(v.images) && v.images.length > 0) {
              savedVImgs = v.images.map((img, i) => {
                if (!img) return "";
                if (img === rawVImg && savedVImg) return savedVImg;
                return saveBase64ToFile(img, "products", "prod");
              }).filter(Boolean);
            }
            if (savedVImg && !savedVImgs.includes(savedVImg)) {
              savedVImgs.unshift(savedVImg);
            }
            const finalVImg = savedVImg || (savedVImgs[0] || "");
            const finalVImgs = Array.from(new Set([finalVImg, ...savedVImgs].filter(Boolean)));

            return {
              size: sz || mv || `Variant #${vIdx + 1}`,
              measureScale: String(v.measureScale || "size").trim(),
              measureValue: mv || sz || `Variant #${vIdx + 1}`,
              unit: String(v.unit || "Size").trim(),
              price: p,
              mrp: m,
              originalPrice: m,
              stock: st,
              stockQuantity: st,
              image: finalVImg,
              images: finalVImgs,
              sku: v.sku || `SKU-VAR-${vIdx + 1}`
            };
          }).filter(Boolean)
        : [];

      updates.sizeVariants = formattedVariants;
      updates.variants = formattedVariants;

      if (formattedVariants.length > 0) {
        updates.sizes = Array.from(new Set([...(updates.sizes ? parseArray(updates.sizes) : (product.sizes || [])), ...formattedVariants.map(v => v.size)]));
        const validPrices = formattedVariants.map(v => Number(v.price)).filter(p => !isNaN(p) && p > 0);
        if (validPrices.length > 0) {
          updates.price = Math.min(...validPrices);
        }
        const totalVariantStock = formattedVariants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
        updates.stock = totalVariantStock;
        updates.stockQuantity = totalVariantStock;
      }
    }

    // Parse array fields safely
    if (updates.sizes !== undefined && updates.sizeVariants === undefined) updates.sizes = parseArray(updates.sizes);
    if (updates.ages !== undefined) updates.ages = parseArray(updates.ages);
    if (updates.colors !== undefined) updates.colors = parseArray(updates.colors);
    if (updates.tags !== undefined) updates.tags = parseArray(updates.tags);
    if (updates.price !== undefined) updates.price = Number(updates.price);
    if (updates.mrp !== undefined) updates.mrp = Number(updates.mrp);
    if (updates.discountPercentage !== undefined) updates.discountPercentage = Number(updates.discountPercentage);
    if (updates.isReturnable !== undefined) updates.isReturnable = parseBool(updates.isReturnable, true);
    if (updates.isRefundable !== undefined) updates.isRefundable = parseBool(updates.isRefundable, true);
    if (updates.stock !== undefined) updates.stock = Number(updates.stock);
    if (updates.paymentMethodAllowed !== undefined) {
      const pMethod = updates.paymentMethodAllowed;
      updates.paymentMethodsAllowed = pMethod === "COD_Only"
        ? ["COD"]
        : pMethod === "Online_Only"
        ? ["Online"]
        : ["COD", "Online"];
    }

    // Process new images in req.files or req.body.images or req.body.image
    const updatedImagePaths = [];
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      req.files.forEach((file) => {
        updatedImagePaths.push(`/uploads/products/${file.filename}`);
      });
    }

    if (updates.images) {
      let rawImages = updates.images;
      if (typeof rawImages === "string") {
        try {
          rawImages = JSON.parse(rawImages);
        } catch (e) {
          rawImages = [rawImages];
        }
      }
      if (Array.isArray(rawImages)) {
        rawImages.forEach((img) => {
          if (img && typeof img === "string") {
            const savedPath = saveBase64ToFile(img, "products", "product");
            if (savedPath && !updatedImagePaths.includes(savedPath)) {
              updatedImagePaths.push(savedPath);
            }
          }
        });
      }
      updates.images = Array.from(new Set(updatedImagePaths)).filter(Boolean);
    } else if (updatedImagePaths.length > 0) {
      updates.images = Array.from(new Set([...(product.images || []), ...updatedImagePaths])).filter(Boolean);
    }

    const effectivePrimaryImg = (updates.images && updates.images[0]) || (product.images && product.images[0]) || updates.image || product.image || "";
    if (effectivePrimaryImg && Array.isArray(updates.sizeVariants) && updates.sizeVariants.length > 0) {
      updates.sizeVariants = updates.sizeVariants.map(v => {
        const isPlaceholder = !v.image || (typeof v.image === "string" && (v.image.includes("unsplash.com") || v.image.includes("placeholder")));
        if (isPlaceholder) {
          return { ...v, image: effectivePrimaryImg, images: [effectivePrimaryImg] };
        }
        return v;
      });
      updates.variants = updates.sizeVariants;
    }

    // Whenever a product is updated by a seller, set approvalStatus to "Pending" for admin review
    updates.approvalStatus = "Pending";
    updates.approvalComment = "Product details updated by merchant. Awaiting administrative review.";
    updates.rejectionReason = "";

    // Apply updates safely
    Object.assign(product, updates);
    await product.save();
    clearCache('product');

    console.log("✅ Product Updated Successfully! ID:", product._id);

    res.json({
      success: true,
      message: "Product updated successfully!",
      product
    });
  } catch (error) {
    console.error("Seller updateProduct error:", error);
    res.status(500).json({ message: "Failed to update product", error: error.message });
  }
};

// Quick Update Product Stock Quantity & Status (Inventory Tab)
export const updateInventoryStock = async (req, res) => {
  try {
    const { id } = req.params;
    const { stockQuantity, inStock, stock } = req.body;

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const isOwner = await checkProductOwnership(req, product);
    if (!isOwner) {
      return res.status(403).json({ message: "Unauthorized to modify this product" });
    }

    const nextStock = stockQuantity !== undefined ? Number(stockQuantity) : (stock !== undefined ? Number(stock) : product.stock);
    product.stock = Math.max(0, nextStock);

    if (inStock !== undefined) {
      product.status = inStock ? "available" : "out-of-stock";
    } else {
      product.status = product.stock > 0 ? "available" : "out-of-stock";
    }

    await product.save();
    clearCache('product');

    res.json({
      message: "Inventory stock updated successfully!",
      stock: product.stock,
      status: product.status,
      product
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update inventory stock", error: error.message });
  }
};

// Delete Product
export const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const isOwner = await checkProductOwnership(req, product);
    if (!isOwner) {
      return res.status(403).json({ message: "Unauthorized to delete this product" });
    }

    await Product.findByIdAndDelete(id);
    clearCache('product');

    res.json({ message: "Product deleted successfully!" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete product", error: error.message });
  }
};

// Set / Update Special Offer on a Specific Product
export const setProductOffer = async (req, res) => {
  try {
    const { id } = req.params;
    const { discountType, discountValue, startDate, endDate, isActive } = req.body;

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const isOwner = await checkProductOwnership(req, product);
    if (!isOwner) {
      return res.status(403).json({ message: "Unauthorized to modify this product" });
    }

    if (discountValue === undefined || discountValue <= 0) {
      return res.status(400).json({ message: "Valid discount value is required" });
    }

    product.offer = {
      hasOffer: true,
      discountType: discountType || "percentage",
      discountValue: Number(discountValue),
      startDate: startDate ? new Date(startDate) : new Date(),
      endDate: endDate ? new Date(endDate) : null,
      isActive: isActive !== undefined ? Boolean(isActive) : true
    };

    await product.save();

    res.json({
      message: "Offer applied to product successfully!",
      product
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to set offer", error: error.message });
  }
};

// Remove Offer from Product
export const removeProductOffer = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const isOwner = await checkProductOwnership(req, product);
    if (!isOwner) {
      return res.status(403).json({ message: "Unauthorized to modify this product" });
    }

    product.offer = {
      hasOffer: false,
      discountType: "percentage",
      discountValue: 0,
      offerPrice: product.price,
      startDate: null,
      endDate: null,
      isActive: false
    };

    await product.save();

    res.json({
      message: "Offer removed from product",
      product
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to remove offer", error: error.message });
  }
};
