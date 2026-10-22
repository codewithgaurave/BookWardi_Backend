import mongoose from "mongoose";
import Product from "../models/Product.js";
import Seller from "../models/Seller.js";
import { clearCache } from "../utils/cache.js";
import { saveBase64ToFile } from "./sellerAuthController.js";

// Helper function to safely parse array inputs
const parseArray = (input) => {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter(Boolean);
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [trimmed];
      } catch (e) {}
    }
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

// Helper function to safely parse boolean inputs
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

// Timeout race wrapper to ensure responses under 15 seconds
const withTimeout = (promise, ms = 15000) => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Query execution exceeded ${ms}ms`)), ms)
    )
  ]);
};

// Clean fallback (no dummy products)
const FALLBACK_PRODUCTS = [];

// Helper to build flexible and case-insensitive category/subcategory filter queries
const buildCategoryFilter = (category) => {
  if (!category || category === "all" || category === "undefined" || category === "null") {
    return null;
  }
  const cleanCat = String(category).trim().replace(/[-_]+/g, " ");
  const lower = cleanCat.toLowerCase();

  if (category === "school_specific" || lower.includes("uniform")) {
    return {
      $or: [
        { category: new RegExp("uniform", "i") },
        { category: "school_specific" },
        { isSchoolSpecific: true }
      ]
    };
  }

  if (lower.includes("kit") || lower.includes("bundle")) {
    return {
      $or: [
        { category: new RegExp("kit", "i") },
        { category: new RegExp("bundle", "i") },
        { bundleType: "kit" },
        { subCategory: new RegExp("kit|bundle", "i") }
      ]
    };
  }

  if (lower.includes("ncert")) {
    return {
      $or: [
        { subCategory: new RegExp("ncert", "i") },
        { category: new RegExp("book", "i") },
        { name: new RegExp("ncert", "i") }
      ]
    };
  }

  if (lower.includes("practice")) {
    return {
      $or: [
        { subCategory: new RegExp("practice|olympiad", "i") },
        { name: new RegExp("practice", "i") }
      ]
    };
  }

  if (lower.includes("drawing")) {
    return {
      $or: [
        { subCategory: new RegExp("drawing", "i") },
        { category: new RegExp("drawing", "i") },
        { name: new RegExp("drawing", "i") }
      ]
    };
  }

  if (lower.includes("station") || lower.includes("notebook")) {
    return {
      $or: [
        { category: new RegExp("station|notebook", "i") },
        { subCategory: new RegExp("station|notebook", "i") }
      ]
    };
  }

  if (lower.includes("footwear") || lower.includes("shoe") || lower.includes("sock")) {
    return {
      $or: [
        { category: new RegExp("footwear|shoe|sock", "i") },
        { subCategory: new RegExp("shoe|sock", "i") }
      ]
    };
  }

  return {
    $or: [
      { category: new RegExp(`^${category}$`, "i") },
      { category: new RegExp(`^${cleanCat}$`, "i") },
      { category: new RegExp(cleanCat, "i") },
      { subCategory: new RegExp(cleanCat, "i") }
    ]
  };
};

// Get all products (with optional filtering by category, search, school, size, age, discount, offer, ids, tag)
export const getProducts = async (req, res) => {
  try {
    const {
      ids,
      tag,
      category,
      subCategory,
      schoolName,
      gender,
      classGrade,
      ageGroup,
      age,
      size,
      sizes,
      search,
      hasOffer,
      minDiscount,
      minPrice,
      maxPrice,
      sellerId,
      sortBy = "newest",
      page = 1,
      limit = 20
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));

    if (mongoose.connection.readyState !== 1) {
      return res.json({
        total: FALLBACK_PRODUCTS.length,
        page: pageNum,
        totalPages: 1,
        limit: limitNum,
        count: FALLBACK_PRODUCTS.length,
        products: FALLBACK_PRODUCTS
      });
    }

    const filter = (req.query.all === "true" || req.query.includePending === "true")
      ? { isDeleted: { $ne: true } }
      : { status: { $nin: ["deleted", "out-of-stock-removed"] }, isDeleted: { $ne: true }, approvalStatus: { $nin: ["Pending", "Rejected"] } };

    if (ids) {
      const parsedIds = parseArray(ids);
      const validObjectIds = parsedIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
      if (validObjectIds.length > 0) filter._id = { $in: validObjectIds };
    }
    const catQuery = buildCategoryFilter(category);
    if (catQuery) {
      Object.assign(filter, catQuery);
    }
    if (subCategory) filter.subCategory = subCategory;
    if (schoolName) filter.schoolName = { $regex: schoolName, $options: "i" };
    if (gender && gender !== "All") filter.gender = gender;
    if (classGrade) filter.classGrade = { $regex: classGrade, $options: "i" };
    if (sellerId) filter.sellerId = sellerId;

    const targetAge = ageGroup || age;
    if (targetAge) {
      filter.$or = [
        { ageGroup: { $regex: targetAge, $options: "i" } },
        { ages: { $in: [new RegExp(targetAge, "i")] } }
      ];
    }

    const targetSizes = size ? [size] : sizes ? parseArray(sizes) : null;
    if (targetSizes && targetSizes.length > 0) filter.sizes = { $in: targetSizes };

    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    if (minDiscount) {
      filter.$or = [
        { discountPercentage: { $gte: Number(minDiscount) } },
        { "offer.discountValue": { $gte: Number(minDiscount) } }
      ];
    }

    if (hasOffer === "true") {
      filter["offer.hasOffer"] = true;
      filter["offer.isActive"] = true;
    }

    if (search) {
      const searchRegex = { $regex: search, $options: "i" };
      const searchConditions = [
        { name: searchRegex },
        { description: searchRegex },
        { schoolName: searchRegex },
        { category: searchRegex },
        { brand: searchRegex },
        { ageGroup: searchRegex },
        { sizes: { $in: [new RegExp(search, "i")] } }
      ];

      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchConditions }];
        delete filter.$or;
      } else {
        filter.$or = searchConditions;
      }
    }

    let sortOption = { createdAt: -1 };
    if (sortBy === "price_asc") sortOption = { price: 1 };
    else if (sortBy === "price_desc") sortOption = { price: -1 };
    else if (sortBy === "rating") sortOption = { averageRating: -1, numReviews: -1 };
    else if (sortBy === "discount") sortOption = { discountPercentage: -1 };

    const skip = (pageNum - 1) * limitNum;

    let totalProducts = 0;
    let products = [];

    try {
      const [countResult, productsResult] = await Promise.all([
        Product.countDocuments(filter),
        Product.find(filter).sort(sortOption).skip(skip).limit(limitNum).lean()
      ]);
      totalProducts = countResult;
      products = productsResult;
    } catch (e) {
      console.warn("DB product query failed:", e.message);
    }

    // Only fallback if no explicit search/category filters were provided and no items exist in DB
    const hasExplicitFilter = Boolean(search || category || subCategory || schoolName);
    if (!hasExplicitFilter && (!products || products.length === 0)) {
      try {
        const fallbackFilter = (req.query.all === "true" || req.query.includePending === "true")
          ? { isDeleted: { $ne: true } }
          : { status: { $nin: ["deleted", "out-of-stock-removed"] }, isDeleted: { $ne: true }, approvalStatus: { $nin: ["Pending", "Rejected"] } };
        products = await Product.find(fallbackFilter).sort(sortOption).limit(limitNum).lean();
        totalProducts = products.length;
      } catch (err) {}
    }

    const normalizedProducts = (products || []).map(p => {
      const idStr = String(p._id || p.id || "");
      let cleanSku = p.sku;
      if (!cleanSku || !String(cleanSku).trim() || String(cleanSku).includes("6ab") || String(cleanSku).length > 20) {
        const numericSuffix = idStr.length >= 6 ? (parseInt(idStr.slice(-6), 16) % 9000 + 1000) : Math.floor(1000 + Math.random() * 9000);
        cleanSku = `SC-${numericSuffix}`;
      } else {
        cleanSku = String(cleanSku).trim().toUpperCase();
      }
      return {
        ...p,
        sku: cleanSku,
        displayId: cleanSku
      };
    });

    res.json({
      total: totalProducts || normalizedProducts.length,
      page: pageNum,
      totalPages: Math.ceil((totalProducts || normalizedProducts.length) / limitNum) || 1,
      limit: limitNum,
      count: normalizedProducts.length,
      products: normalizedProducts
    });
  } catch (error) {
    if (mongoose.connection.readyState !== 1) {
      return res.json({
        total: FALLBACK_PRODUCTS.length,
        page: 1,
        totalPages: 1,
        limit: 20,
        count: FALLBACK_PRODUCTS.length,
        products: FALLBACK_PRODUCTS
      });
    }
    res.status(500).json({ message: "Failed to fetch products", error: error.message });
  }
};

// Get Recently Viewed products
export const getRecentlyViewedProducts = async (req, res) => {
  try {
    const { ids, category, limit = 8 } = req.query;
    const limitNum = Math.max(1, Math.min(50, parseInt(limit, 10) || 8));

    if (mongoose.connection.readyState !== 1) {
      return res.json({ total: FALLBACK_PRODUCTS.length, count: FALLBACK_PRODUCTS.length, products: FALLBACK_PRODUCTS });
    }

    const parsedIds = parseArray(ids);
    const validObjectIds = parsedIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    let filter = { status: { $nin: ["deleted"] }, isDeleted: { $ne: true }, approvalStatus: { $nin: ["Pending", "Rejected"] } };
    const catQuery = buildCategoryFilter(category);
    if (catQuery) Object.assign(filter, catQuery);

    let products = [];
    try {
      if (validObjectIds.length > 0) {
        filter._id = { $in: validObjectIds };
        products = await Product.find(filter).lean();
        const productMap = new Map(products.map((p) => [p._id.toString(), p]));
        const orderedProducts = validObjectIds.map((id) => productMap.get(id.toString())).filter(Boolean);
        if (orderedProducts.length > 0) {
          return res.json({ total: orderedProducts.length, count: orderedProducts.length, products: orderedProducts.slice(0, limitNum) });
        }
      }

      delete filter._id;
      products = await Product.find(filter).sort({ createdAt: -1 }).limit(limitNum).lean();
    } catch (e) {
      products = [];
    }

    if (!products || products.length === 0) {
      try {
        products = await Product.find({ status: { $nin: ["deleted", "out-of-stock-removed"] }, isDeleted: { $ne: true }, approvalStatus: { $nin: ["Pending", "Rejected"] } }).sort({ createdAt: -1 }).limit(limitNum).lean();
      } catch (err) {}
    }

    res.json({ total: products.length, count: products.length, products });
  } catch (error) {
    if (mongoose.connection.readyState !== 1) {
      return res.json({ total: FALLBACK_PRODUCTS.length, count: FALLBACK_PRODUCTS.length, products: FALLBACK_PRODUCTS });
    }
    res.status(500).json({ message: "Failed to fetch recently viewed products", error: error.message });
  }
};

// Get Featured / Trending products
export const getFeaturedProducts = async (req, res) => {
  try {
    const { category, limit = 8 } = req.query;
    const limitNum = Math.max(1, Math.min(50, parseInt(limit, 10) || 8));

    if (mongoose.connection.readyState !== 1) {
      return res.json({ total: FALLBACK_PRODUCTS.length, count: FALLBACK_PRODUCTS.length, products: FALLBACK_PRODUCTS });
    }

    const filter = { status: { $nin: ["deleted"] }, isDeleted: { $ne: true }, approvalStatus: { $nin: ["Pending", "Rejected"] } };
    const catQuery = buildCategoryFilter(category);
    if (catQuery) Object.assign(filter, catQuery);

    let products = [];
    try {
      products = await Product.find(filter).sort({ createdAt: -1 }).limit(limitNum).lean();
    } catch (e) {
      products = [];
    }

    if (!products || products.length === 0) {
      try {
        products = await Product.find({ status: { $nin: ["deleted", "out-of-stock-removed"] }, isDeleted: { $ne: true }, approvalStatus: { $nin: ["Pending", "Rejected"] } }).sort({ createdAt: -1 }).limit(limitNum).lean();
      } catch (err) {}
    }

    res.json({ total: products.length, count: products.length, products });
  } catch (error) {
    if (mongoose.connection.readyState !== 1) {
      return res.json({ total: FALLBACK_PRODUCTS.length, count: FALLBACK_PRODUCTS.length, products: FALLBACK_PRODUCTS });
    }
    res.status(500).json({ message: "Failed to fetch featured products", error: error.message });
  }
};

// Get Special Offers products
export const getSpecialOffers = async (req, res) => {
  try {
    const { category, limit = 8 } = req.query;
    const limitNum = Math.max(1, Math.min(50, parseInt(limit, 10) || 8));

    if (mongoose.connection.readyState !== 1) {
      return res.json({ total: FALLBACK_PRODUCTS.length, count: FALLBACK_PRODUCTS.length, products: FALLBACK_PRODUCTS });
    }

    const filter = {
      status: { $nin: ["deleted"] },
      isDeleted: { $ne: true },
      approvalStatus: { $nin: ["Pending", "Rejected"] }
    };
    const catQuery = buildCategoryFilter(category);
    if (catQuery) Object.assign(filter, catQuery);

    let products = [];
    try {
      products = await Product.find(filter).sort({ createdAt: -1 }).limit(limitNum).lean();
    } catch (e) {
      products = [];
    }

    if (!products || products.length === 0) {
      try {
        products = await Product.find({ status: { $nin: ["deleted", "out-of-stock-removed"] }, isDeleted: { $ne: true }, approvalStatus: { $nin: ["Pending", "Rejected"] } }).sort({ createdAt: -1 }).limit(limitNum).lean();
      } catch (err) {}
    }

    res.json({ total: products.length, count: products.length, products });
  } catch (error) {
    if (mongoose.connection.readyState !== 1) {
      return res.json({ total: FALLBACK_PRODUCTS.length, count: FALLBACK_PRODUCTS.length, products: FALLBACK_PRODUCTS });
    }
    res.status(500).json({ message: "Failed to fetch special offers", error: error.message });
  }
};

// Get Recommended products
export const getRecommendedProducts = async (req, res) => {
  try {
    const { category, schoolName, classGrade, limit = 8 } = req.query;
    const limitNum = Math.max(1, Math.min(50, parseInt(limit, 10) || 8));

    if (mongoose.connection.readyState !== 1) {
      return res.json({ total: FALLBACK_PRODUCTS.length, count: FALLBACK_PRODUCTS.length, products: FALLBACK_PRODUCTS });
    }

    const filter = { status: { $nin: ["deleted"] }, isDeleted: { $ne: true }, approvalStatus: { $nin: ["Pending", "Rejected"] } };
    const catQuery = buildCategoryFilter(category);
    if (catQuery) Object.assign(filter, catQuery);
    if (schoolName) filter.schoolName = { $regex: schoolName, $options: "i" };
    if (classGrade) filter.classGrade = { $regex: classGrade, $options: "i" };

    let products = [];
    try {
      products = await Product.find(filter).sort({ createdAt: -1 }).limit(limitNum).lean();
    } catch (e) {
      products = [];
    }

    if (!products || products.length === 0) {
      try {
        products = await Product.find({ status: { $nin: ["deleted", "out-of-stock-removed"] }, isDeleted: { $ne: true }, approvalStatus: { $nin: ["Pending", "Rejected"] } }).sort({ createdAt: -1 }).limit(limitNum).lean();
      } catch (err) {}
    }

    res.json({ total: products.length, count: products.length, products });
  } catch (error) {
    if (mongoose.connection.readyState !== 1) {
      return res.json({ total: FALLBACK_PRODUCTS.length, count: FALLBACK_PRODUCTS.length, products: FALLBACK_PRODUCTS });
    }
    res.status(500).json({ message: "Failed to fetch recommended products", error: error.message });
  }
};

// Get single product by ID
export const getProductById = async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      const match = FALLBACK_PRODUCTS.find((p) => p._id === req.params.id) || FALLBACK_PRODUCTS[0];
      return res.json(match);
    }

    const allowPending = req.query.all === "true" || req.query.includePending === "true";
    const productQuery = allowPending
      ? { _id: req.params.id, isDeleted: { $ne: true }, status: { $ne: "deleted" } }
      : { _id: req.params.id, isDeleted: { $ne: true }, status: { $ne: "deleted" }, approvalStatus: { $nin: ["Pending", "Rejected"] } };

    const product = await withTimeout(
      Product.findOne(productQuery).populate("sellerId", "storeName name city phone").lean(),
      1500
    );
    if (!product) {
      return res.status(404).json({ message: "Product not found or has been deleted" });
    }
    res.json(product);
  } catch (error) {
    if (mongoose.connection.readyState !== 1) {
      const match = FALLBACK_PRODUCTS.find((p) => p._id === req.params.id) || FALLBACK_PRODUCTS[0];
      return res.json(match);
    }
    res.status(404).json({ message: "Product not found or has been deleted" });
  }
};

// Create new product (Admin / General)
export const createProduct = async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.id && !mongoose.Types.ObjectId.isValid(String(payload.id))) {
      delete payload.id;
    }
    if (payload._id && !mongoose.Types.ObjectId.isValid(String(payload._id))) {
      delete payload._id;
    }
    if (payload.sellerId) {
      if (payload.sellerId === "self" || !mongoose.Types.ObjectId.isValid(String(payload.sellerId))) {
        const foundSeller = await Seller.findOne({
          $or: [
            { sellerCode: payload.sellerId },
            { email: payload.sellerId }
          ]
        });
        if (foundSeller) {
          payload.sellerId = foundSeller._id;
        } else {
          delete payload.sellerId;
        }
      }
    } else {
      delete payload.sellerId;
    }
    if (typeof payload.sizeVariants === "string") {
      try { payload.sizeVariants = JSON.parse(payload.sizeVariants); } catch (e) { payload.sizeVariants = []; }
    }
    if (payload.sizes) payload.sizes = parseArray(payload.sizes);
    if (payload.ages) payload.ages = parseArray(payload.ages);
    if (payload.colors) payload.colors = parseArray(payload.colors);
    const explicitGstVal = payload.gst ?? payload.gstPercentage ?? payload.gstPercent ?? payload.gstRate;
    if (explicitGstVal !== undefined && explicitGstVal !== null && String(explicitGstVal).trim() !== "" && !isNaN(Number(explicitGstVal))) {
      const parsedGstVal = Number(explicitGstVal);
      payload.gst = parsedGstVal;
      payload.gstPercent = parsedGstVal;
      payload.gstPercentage = parsedGstVal;
      payload.gstRate = parsedGstVal;
    }
    payload.isGstInclusive = parseBool(payload.isGstInclusive, true);
    if (payload.isReturnable !== undefined) payload.isReturnable = parseBool(payload.isReturnable, true);
    if (payload.isExchangeable !== undefined) payload.isExchangeable = parseBool(payload.isExchangeable, true);
    if (payload.isRefundable !== undefined) payload.isRefundable = parseBool(payload.isRefundable, true);

    // Convert top-level image and images from base64 if present
    if (payload.image && typeof payload.image === "string" && payload.image.startsWith("data:")) {
      payload.image = saveBase64ToFile(payload.image, "products", "product");
    }
    if (Array.isArray(payload.images) && payload.images.length > 0) {
      payload.images = payload.images.map(img => {
        if (typeof img === "string" && img.startsWith("data:")) {
          return saveBase64ToFile(img, "products", "product");
        }
        return img;
      });
    }

    if (Array.isArray(payload.sizeVariants)) {
      payload.sizeVariants = payload.sizeVariants.filter(v => 
        v && 
        !v.isBase && 
        String(v.size || '').trim().toLowerCase() !== 'base product' && 
        String(v.measureValue || '').trim().toLowerCase() !== 'base product' && 
        !String(v.id || '').startsWith('base_option_')
      );
    }
    if (Array.isArray(payload.sizeVariants) && payload.sizeVariants.length > 0) {
      payload.sizeVariants = payload.sizeVariants.map((v, vIdx) => {
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
      }).filter(Boolean);

      if (!payload.sizes || payload.sizes.length === 0) {
        payload.sizes = payload.sizeVariants.map(v => v.size).filter(Boolean);
      }
      const validPrices = payload.sizeVariants.map(v => Number(v.price)).filter(p => !isNaN(p) && p > 0);
      if ((!payload.price || Number(payload.price) === 0) && validPrices.length > 0) {
        payload.price = Math.min(...validPrices);
      }
      const validMrps = payload.sizeVariants.map(v => Number(v.mrp)).filter(m => !isNaN(m) && m > 0);
      if ((!payload.mrp || Number(payload.mrp) === 0) && validMrps.length > 0) {
        payload.mrp = Math.min(...validMrps);
      }
      if (payload.stock === undefined || Number(payload.stock) === 0) {
        payload.stock = payload.sizeVariants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
      }
    }

    if (!payload.approvalStatus) {
      payload.approvalStatus = "Pending";
    }

    const product = new Product(payload);
    const savedProduct = await product.save();

    clearCache("product");
    console.log("New Product Added! Product ID:", savedProduct._id);

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      product: savedProduct,
      ...savedProduct.toObject()
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Update product
export const updateProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const updates = { ...req.body };
    if (updates.sellerId) {
      if (updates.sellerId === "self" || !mongoose.Types.ObjectId.isValid(String(updates.sellerId))) {
        const foundSeller = await Seller.findOne({
          $or: [
            { sellerCode: updates.sellerId },
            { email: updates.sellerId }
          ]
        });
        if (foundSeller) {
          updates.sellerId = foundSeller._id;
        } else {
          delete updates.sellerId;
        }
      }
    } else if (updates.sellerId === "" || updates.sellerId === null) {
      delete updates.sellerId;
    }
    if (typeof updates.sizeVariants === "string") {
      try { updates.sizeVariants = JSON.parse(updates.sizeVariants); } catch (e) { updates.sizeVariants = []; }
    }
    if (updates.sizes !== undefined) updates.sizes = parseArray(updates.sizes);
    if (updates.ages !== undefined) updates.ages = parseArray(updates.ages);
    if (updates.colors !== undefined) updates.colors = parseArray(updates.colors);
    if (updates.tags !== undefined) updates.tags = parseArray(updates.tags);
    if (updates.isGstInclusive !== undefined) {
      updates.isGstInclusive = parseBool(updates.isGstInclusive, true);
    }
    if (updates.isReturnable !== undefined) updates.isReturnable = parseBool(updates.isReturnable, true);
    if (updates.isExchangeable !== undefined) updates.isExchangeable = parseBool(updates.isExchangeable, true);
    if (updates.isRefundable !== undefined) updates.isRefundable = parseBool(updates.isRefundable, true);

    // Convert top-level image and images from base64 if present
    if (updates.image && typeof updates.image === "string" && updates.image.startsWith("data:")) {
      updates.image = saveBase64ToFile(updates.image, "products", "product");
    }
    if (Array.isArray(updates.images) && updates.images.length > 0) {
      updates.images = updates.images.map(img => {
        if (typeof img === "string" && img.startsWith("data:")) {
          return saveBase64ToFile(img, "products", "product");
        }
        return img;
      });
    }
    if (updates.paymentMethodAllowed !== undefined) {
      const pMethod = updates.paymentMethodAllowed;
      updates.paymentMethodsAllowed = pMethod === "COD_Only"
        ? ["COD"]
        : pMethod === "Online_Only"
        ? ["Online"]
        : ["COD", "Online"];
    }

    if (Array.isArray(updates.sizeVariants)) {
      updates.sizeVariants = updates.sizeVariants.filter(v => 
        v && 
        !v.isBase && 
        String(v.size || '').trim().toLowerCase() !== 'base product' && 
        String(v.measureValue || '').trim().toLowerCase() !== 'base product' && 
        !String(v.id || '').startsWith('base_option_')
      );
    }
    if (Array.isArray(updates.sizeVariants) && updates.sizeVariants.length > 0) {
      if (!updates.sizes || updates.sizes.length === 0) {
        updates.sizes = updates.sizeVariants.map(v => v.size).filter(Boolean);
      }
      const validPrices = updates.sizeVariants.map(v => Number(v.price)).filter(p => !isNaN(p) && p > 0);
      if ((!updates.price || Number(updates.price) === 0) && validPrices.length > 0) {
        updates.price = Math.min(...validPrices);
      }
      const validMrps = updates.sizeVariants.map(v => Number(v.mrp)).filter(m => !isNaN(m) && m > 0);
      if ((!updates.mrp || Number(updates.mrp) === 0) && validMrps.length > 0) {
        updates.mrp = Math.min(...validMrps);
      }
      if (updates.stock === undefined || Number(updates.stock) === 0) {
        updates.stock = updates.sizeVariants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
      }
    }

    Object.assign(product, updates);
    await product.save();

    clearCache("product");
    res.json(product);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Delete product
export const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }
    clearCache("product");
    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};