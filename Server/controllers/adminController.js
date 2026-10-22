import mongoose from "mongoose";
import Admin from "../models/Admin.js";
import User from "../models/User.js";
import Seller from "../models/Seller.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import PlatformSetting from "../models/PlatformSetting.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { saveBase64ToFile } from "./sellerAuthController.js";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

export const loginAdmin = async (req, res) => {
  try {
    const { email, password, phone } = req.body;
    const identifier = (email || phone || "").trim();

    if (!identifier || !password) {
      return res.status(400).json({ message: "Email or phone number, and password are required" });
    }

    // 1. Search dynamically in Admin collection by email or phone
    let admin = await Admin.findOne({
      $or: [
        { email: identifier.toLowerCase() },
        { phone: identifier }
      ]
    });

    // 2. Fallback to User collection if registered with administrative privileges
    if (!admin) {
      const userAdmin = await User.findOne({
        $or: [
          { email: identifier.toLowerCase() },
          { phone: identifier }
        ],
        role: { $in: ["admin", "super_admin"] }
      });

      if (userAdmin) {
        admin = userAdmin;
      }
    }

    if (!admin) {
      return res.status(401).json({ message: "Invalid credentials: No admin account found with these details." });
    }

    if (admin.status === "suspended") {
      return res.status(403).json({ message: "Account suspended. Please contact Super Administrator." });
    }

    // Dynamic password verification via bcrypt
    let isMatch = false;
    try {
      isMatch = await bcrypt.compare(password, admin.password);
    } catch (err) {
      isMatch = false;
    }

    if (!isMatch && password === admin.password) {
      isMatch = true;
    }

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials: Password does not match." });
    }

    const token = jwt.sign(
      {
        id: admin._id,
        email: admin.email,
        role: admin.role || "admin",
        permissions: admin.permissions || {}
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      message: "Admin login successful",
      token,
      admin: {
        id: admin._id,
        name: admin.name || "Admin",
        email: admin.email,
        phone: admin.phone || "",
        role: admin.role || "admin",
        permissions: admin.permissions || {},
        status: admin.status || "active"
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const createAdmin = async (req, res) => {
  try {
    const { name, email, password, role, permissions, phone } = req.body;
    
    const existingAdmin = await Admin.findOne({ email: email?.toLowerCase() });
    if (existingAdmin) {
      return res.status(400).json({ message: "Admin already exists" });
    }

    const admin = new Admin({
      name,
      email: email?.toLowerCase(),
      phone: phone || "",
      password,
      role: role || "admin",
      permissions: permissions || {},
      status: "active"
    });
    await admin.save();

    res.status(201).json({ message: "Admin created successfully", admin: { id: admin._id, name: admin.name, email: admin.email, role: admin.role } });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ==========================================
// Sub-Admin RBAC Team Controllers
// ==========================================
export const getAllSubadmins = async (req, res) => {
  try {
    const admins = await Admin.find().select("-password").sort({ createdAt: -1 });
    res.json(admins);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch sub-admins", error: error.message });
  }
};

export const createSubadmin = async (req, res) => {
  try {
    const { name, email, phone, password, role, permissions, status } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email, and password are required" });
    }

    const cleanEmail = email.toLowerCase().trim();
    const existing = await Admin.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(400).json({ message: "An administrator with this email already exists" });
    }

    const subadmin = new Admin({
      name: name.trim(),
      email: cleanEmail,
      phone: phone ? phone.trim() : "",
      password,
      role: role || "subadmin",
      permissions: permissions || {},
      status: status || "active",
      createdBy: req.user?.id || null
    });

    await subadmin.save();

    const result = subadmin.toObject();
    delete result.password;

    res.status(201).json({
      message: "Sub-admin account created successfully",
      admin: result
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to create sub-admin", error: error.message });
  }
};

export const updateSubadmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, password, role, permissions, status } = req.body;

    const target = await Admin.findById(id);
    if (!target) {
      return res.status(404).json({ message: "Admin account not found" });
    }

    if (name) target.name = name.trim();
    if (email) target.email = email.toLowerCase().trim();
    if (phone !== undefined) target.phone = phone.trim();
    if (role) target.role = role;
    if (permissions !== undefined) target.permissions = permissions;
    if (status) target.status = status;
    if (password && String(password).trim().length >= 6) {
      target.password = password; // Trigger pre('save') hash
    }

    await target.save();

    const result = target.toObject();
    delete result.password;

    res.json({
      message: "Sub-admin account updated successfully",
      admin: result
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update sub-admin", error: error.message });
  }
};

export const deleteSubadmin = async (req, res) => {
  try {
    const { id } = req.params;

    const target = await Admin.findById(id);
    if (!target) {
      return res.status(404).json({ message: "Admin account not found" });
    }

    if (target.email === "admin@admin.com") {
      return res.status(400).json({ message: "Cannot delete the primary root Super Admin account" });
    }

    await Admin.findByIdAndDelete(id);

    res.json({ message: `Admin account '${target.name}' deleted successfully` });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete sub-admin", error: error.message });
  }
};


// get user

export const getUsers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 100));
    const skip = (page - 1) * limit;

    const users = await User.find()
      .select('-password -fcmTokens -fcmToken')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};


// create user

export const createUser = async (req, res) => {
  try {
    const { name, email, role, status } = req.body;
    
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const user = new User({ name, email, role, status });
    await user.save();

    res.status(201).json({ message: "User created successfully", user });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};


// update user

export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const user = await User.findByIdAndUpdate(id, updates, { new: true });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "User updated successfully", user });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};


// delete user

export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findByIdAndDelete(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const getDashboardStats = async (req, res) => {
  try {
    const [
      totalUsers,
      activeUsers,
      inactiveUsers,
      totalAdmins,
      totalSellers,
      activeSellers,
      pendingSellers,
      totalProducts,
      pendingProducts,
      totalOrders,
      revenueAgg
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ status: 'active' }),
      User.countDocuments({ status: 'inactive' }),
      Admin.countDocuments(),
      Seller.countDocuments(),
      Seller.countDocuments({ status: 'approved' }),
      Seller.countDocuments({ status: 'pending' }),
      Product.countDocuments(),
      Product.countDocuments({ approvalStatus: 'Pending' }),
      Order.countDocuments(),
      Order.aggregate([
        {
          $group: {
            _id: null,
            totalRevenue: {
              $sum: {
                $ifNull: ["$payableAmount", { $ifNull: ["$totalAmount", { $ifNull: ["$total", 0] }] }]
              }
            }
          }
        }
      ])
    ]);

    const totalRevenue = revenueAgg[0]?.totalRevenue || 0;

    res.json({
      totalUsers,
      activeUsers,
      inactiveUsers,
      totalAdmins,
      totalSellers,
      activeSellers,
      pendingSellers,
      totalProducts,
      pendingProducts,
      totalOrders,
      totalRevenue
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const getAdminProducts = async (req, res) => {
  try {
    const {
      search,
      category,
      subCategory,
      status,
      approvalStatus,
      sellerId,
      stockStatus,
      sort = "-createdAt",
      page,
      limit,
      all
    } = req.query;

    const filter = {};

    const filterStatus = approvalStatus || (status && status !== "all" ? status : null);
    if (filterStatus && filterStatus !== "all") {
      filter.approvalStatus = filterStatus;
    }

    if (category && category !== "all") {
      filter.category = category;
    }

    if (subCategory && subCategory !== "all") {
      filter.subCategory = subCategory;
    }

    if (sellerId && sellerId !== "all") {
      if (mongoose.Types.ObjectId.isValid(sellerId)) {
        filter.sellerId = sellerId;
      }
    }

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), "i");
      filter.$or = [
        { name: searchRegex },
        { sku: searchRegex },
        { schoolName: searchRegex },
        { brand: searchRegex },
        { subCategory: searchRegex }
      ];
    }

    if (stockStatus && stockStatus !== "all") {
      if (stockStatus === "out_of_stock" || stockStatus === "out") {
        filter.stock = { $lte: 0 };
      } else if (stockStatus === "low_stock" || stockStatus === "low") {
        filter.stock = { $gt: 0, $lte: 10 };
      } else if (stockStatus === "in_stock" || stockStatus === "healthy") {
        filter.stock = { $gt: 10 };
      }
    }

    let query = Product.find(filter)
      .populate("sellerId", "storeName businessName name email phone")
      .sort(sort);

    if (all !== "true" && page && limit) {
      const p = Math.max(1, parseInt(page, 10) || 1);
      const l = Math.max(1, parseInt(limit, 10) || 50);
      query = query.skip((p - 1) * l).limit(l);
    }

    const [products, totalCount] = await Promise.all([
      query.lean(),
      Product.countDocuments(filter)
    ]);

    const formatted = products.map((p) => {
      const seller = p.sellerId;
      const sellerName = seller?.storeName || seller?.businessName || seller?.name || "Direct Marketplace";
      const primaryImage = (Array.isArray(p.images) && p.images.length > 0) ? p.images[0] : (p.image || "");
      const imageList = (Array.isArray(p.images) && p.images.length > 0) ? p.images : (primaryImage ? [primaryImage] : []);

      return {
        ...p,
        id: p._id.toString(),
        _id: p._id.toString(),
        sellerName,
        stock: p.stock ?? 0,
        stockQuantity: p.stock ?? 0,
        price: p.price ?? 0,
        mrp: p.mrp || p.price || 0,
        originalPrice: p.mrp || p.price || 0,
        image: primaryImage,
        images: imageList
      };
    });

    res.json({
      success: true,
      count: formatted.length,
      total: totalCount,
      products: formatted
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch admin products", error: error.message });
  }
};

export const getAdminProductById = async (req, res) => {
  try {
    const { id } = req.params;
    let product = null;

    if (mongoose.Types.ObjectId.isValid(id)) {
      product = await Product.findById(id).populate("sellerId", "storeName businessName name email phone");
    }
    if (!product) {
      product = await Product.findOne({ sku: id }).populate("sellerId", "storeName businessName name email phone");
    }
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const seller = product.sellerId;
    const sellerName = seller?.storeName || seller?.businessName || seller?.name || "Direct Marketplace";
    const primaryImage = (Array.isArray(product.images) && product.images.length > 0) ? product.images[0] : (product.image || "");
    const imageList = (Array.isArray(product.images) && product.images.length > 0) ? product.images : (primaryImage ? [primaryImage] : []);

    res.json({
      success: true,
      product: {
        ...product.toObject(),
        id: product._id.toString(),
        _id: product._id.toString(),
        sellerName,
        stock: product.stock ?? 0,
        stockQuantity: product.stock ?? 0,
        price: product.price ?? 0,
        mrp: product.mrp || product.price || 0,
        originalPrice: product.mrp || product.price || 0,
        image: primaryImage,
        images: imageList
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch product", error: error.message });
  }
};

export const updateProductApproval = async (req, res) => {
  try {
    const { id } = req.params;
    let product = null;

    if (mongoose.Types.ObjectId.isValid(id)) {
      product = await Product.findById(id);
    }
    if (!product) {
      product = await Product.findOne({ _id: id });
    }
    if (!product) {
      product = await Product.findOne({ sku: id });
    }
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const { status, approvalStatus, remark, comment, reason } = req.body;
    const targetStatus = status || approvalStatus;

    if (targetStatus && ["Approved", "Pending", "Rejected"].includes(targetStatus)) {
      product.approvalStatus = targetStatus;
    }

    const finalRemark = remark !== undefined ? remark : (comment !== undefined ? comment : (reason !== undefined ? reason : undefined));
    if (finalRemark !== undefined) {
      product.approvalComment = finalRemark;
      if (product.approvalStatus === "Rejected") {
        product.rejectionReason = finalRemark;
      } else if (product.approvalStatus === "Approved") {
        product.rejectionReason = "";
      }
    }

    await product.save();
    clearCache("product");

    console.log(`✅ Admin updated product ${product._id} approval status to: ${product.approvalStatus}`);

    res.json({
      success: true,
      message: `Product approval status updated to ${product.approvalStatus}`,
      product: {
        ...product.toObject(),
        id: product._id.toString(),
        _id: product._id.toString(),
        stock: product.stock,
        stockQuantity: product.stock,
        approvalStatus: product.approvalStatus,
        approvalComment: product.approvalComment,
        rejectionReason: product.rejectionReason
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update product approval", error: error.message });
  }
};

export const deleteAdminProduct = async (req, res) => {
  try {
    const { id } = req.params;
    let product = null;

    if (mongoose.Types.ObjectId.isValid(id)) {
      product = await Product.findByIdAndDelete(id);
    }
    if (!product) {
      product = await Product.findOneAndDelete({ sku: id });
    }
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    res.json({ success: true, message: "Product deleted successfully from catalog" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to delete product", error: error.message });
  }
};

export const createAdminProduct = async (req, res) => {
  try {
    const payload = { ...req.body };

    delete payload.id;
    delete payload._id;
    delete payload.createdAt;
    delete payload.updatedAt;

    if (payload.sellerId) {
      if (!mongoose.Types.ObjectId.isValid(payload.sellerId)) {
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
      try {
        payload.sizeVariants = JSON.parse(payload.sizeVariants);
      } catch (e) {
        payload.sizeVariants = [];
      }
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
    } else {
      if (payload.stockQuantity !== undefined && (payload.stock === undefined || Number(payload.stock) === 0)) {
        payload.stock = Number(payload.stockQuantity) || 0;
      }
      if (payload.originalPrice !== undefined && (!payload.mrp || Number(payload.mrp) === 0)) {
        payload.mrp = Number(payload.originalPrice) || payload.price;
      }
    }

    if (!payload.approvalStatus) {
      payload.approvalStatus = "Approved";
    }

    // Convert base64 images to lightweight physical files
    if (payload.image && typeof payload.image === "string") {
      payload.image = saveBase64ToFile(payload.image, "products", "prod");
    }
    if (Array.isArray(payload.images)) {
      payload.images = payload.images.map(img => typeof img === "string" ? saveBase64ToFile(img, "products", "prod") : img).filter(Boolean);
    }
    if ((!payload.image || payload.image === "") && Array.isArray(payload.images) && payload.images.length > 0) {
      payload.image = payload.images[0];
    } else if (payload.image && (!payload.images || payload.images.length === 0)) {
      payload.images = [payload.image];
    }

    if (Array.isArray(payload.sizeVariants)) {
      payload.sizeVariants = payload.sizeVariants.map(v => {
        if (!v || typeof v !== "object") return v;
        const vImg = v.image ? saveBase64ToFile(v.image, "products", "prod") : "";
        let vImgs = Array.isArray(v.images) ? v.images.map(img => saveBase64ToFile(img, "products", "prod")).filter(Boolean) : [];
        if (vImg && !vImgs.includes(vImg)) vImgs.unshift(vImg);
        return {
          ...v,
          image: vImg || (vImgs[0] || ""),
          images: vImgs
        };
      });
    }

    const product = new Product(payload);
    const savedProduct = await product.save();

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      product: {
        ...savedProduct.toObject(),
        id: savedProduct._id.toString(),
        _id: savedProduct._id.toString(),
        stockQuantity: savedProduct.stock,
        stock: savedProduct.stock,
        price: savedProduct.price,
        mrp: savedProduct.mrp,
        originalPrice: savedProduct.mrp
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const updateAdminProduct = async (req, res) => {
  try {
    const { id } = req.params;
    let product = null;

    if (mongoose.Types.ObjectId.isValid(id)) {
      product = await Product.findById(id);
    }
    if (!product) {
      product = await Product.findOne({ sku: id });
    }
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const updates = { ...req.body };
    delete updates.id;
    delete updates._id;
    delete updates.createdAt;
    delete updates.updatedAt;

    if (updates.sellerId) {
      if (!mongoose.Types.ObjectId.isValid(updates.sellerId)) {
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
    } else {
      delete updates.sellerId;
    }

    if (typeof updates.sizeVariants === "string") {
      try {
        updates.sizeVariants = JSON.parse(updates.sizeVariants);
      } catch (e) {
        updates.sizeVariants = [];
      }
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
    } else {
      if (updates.stockQuantity !== undefined && (updates.stock === undefined || Number(updates.stock) === 0)) {
        updates.stock = Number(updates.stockQuantity) || 0;
      }
      if (updates.originalPrice !== undefined && (!updates.mrp || Number(updates.mrp) === 0)) {
        updates.mrp = Number(updates.originalPrice) || updates.price;
      }
    }

    // Convert base64 images to lightweight physical files
    if (updates.image && typeof updates.image === "string") {
      updates.image = saveBase64ToFile(updates.image, "products", "prod");
    }
    if (Array.isArray(updates.images)) {
      updates.images = updates.images.map(img => typeof img === "string" ? saveBase64ToFile(img, "products", "prod") : img).filter(Boolean);
    }
    if ((!updates.image || updates.image === "") && Array.isArray(updates.images) && updates.images.length > 0) {
      updates.image = updates.images[0];
    }

    if (Array.isArray(updates.sizeVariants)) {
      updates.sizeVariants = updates.sizeVariants.map(v => {
        if (!v || typeof v !== "object") return v;
        const vImg = v.image ? saveBase64ToFile(v.image, "products", "prod") : "";
        let vImgs = Array.isArray(v.images) ? v.images.map(img => saveBase64ToFile(img, "products", "prod")).filter(Boolean) : [];
        if (vImg && !vImgs.includes(vImg)) vImgs.unshift(vImg);
        return {
          ...v,
          image: vImg || (vImgs[0] || ""),
          images: vImgs
        };
      });
    }

    Object.assign(product, updates);
    const savedProduct = await product.save();

    res.json({
      success: true,
      message: "Product updated successfully",
      product: {
        ...savedProduct.toObject(),
        id: savedProduct._id.toString(),
        _id: savedProduct._id.toString(),
        stockQuantity: savedProduct.stock,
        stock: savedProduct.stock,
        price: savedProduct.price,
        mrp: savedProduct.mrp,
        originalPrice: savedProduct.mrp
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ==========================================
// Admin Inventory & Stock RESTful API
// ==========================================
export const getAdminInventory = async (req, res) => {
  try {
    const { search, category, status, sellerId, sort = "-stock" } = req.query;

    const filter = {};
    if (category && category !== "all") filter.category = category;
    if (sellerId && sellerId !== "all" && mongoose.Types.ObjectId.isValid(sellerId)) {
      filter.sellerId = sellerId;
    }

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), "i");
      filter.$or = [
        { name: searchRegex },
        { sku: searchRegex },
        { schoolName: searchRegex }
      ];
    }

    const allProducts = await Product.find(filter)
      .populate("sellerId", "storeName businessName name email phone")
      .sort(sort);

    const LOW_STOCK_THRESHOLD = 10;

    const totalProducts = allProducts.length;
    const outOfStockCount = allProducts.filter((p) => (p.stock || 0) === 0).length;
    const lowStockCount = allProducts.filter((p) => (p.stock || 0) > 0 && (p.stock || 0) <= LOW_STOCK_THRESHOLD).length;
    const healthyStockCount = allProducts.filter((p) => (p.stock || 0) > LOW_STOCK_THRESHOLD).length;

    let filteredList = allProducts;
    if (status === "out" || status === "out_of_stock") {
      filteredList = allProducts.filter((p) => (p.stock || 0) === 0);
    } else if (status === "low" || status === "low_stock") {
      filteredList = allProducts.filter((p) => (p.stock || 0) > 0 && (p.stock || 0) <= LOW_STOCK_THRESHOLD);
    } else if (status === "healthy" || status === "adequate") {
      filteredList = allProducts.filter((p) => (p.stock || 0) > LOW_STOCK_THRESHOLD);
    }

    const items = filteredList.map((p) => {
      const stock = p.stock || 0;
      const seller = p.sellerId;
      const sellerName = seller?.storeName || seller?.businessName || seller?.name || "Direct Marketplace";
      const stockStatus = stock === 0 ? "Out of Stock" : stock <= LOW_STOCK_THRESHOLD ? "Low Stock" : "Adequate";
      const primaryImg = Array.isArray(p.images) && p.images.length > 0 ? p.images[0] : (p.image || "");

      return {
        id: p._id.toString(),
        _id: p._id.toString(),
        sku: p.sku || `SKU-${p._id.toString().slice(-6)}`,
        name: p.name,
        category: p.category,
        subCategory: p.subCategory || "",
        sellerId: seller?._id?.toString() || p.sellerId?.toString() || "",
        sellerName,
        price: p.price,
        originalPrice: p.mrp || p.price,
        mrp: p.mrp || p.price,
        stock,
        stockQuantity: stock,
        inStock: stock > 0,
        lowStockThreshold: LOW_STOCK_THRESHOLD,
        stockStatus,
        image: primaryImg,
        images: Array.isArray(p.images) && p.images.length > 0 ? p.images : (primaryImg ? [primaryImg] : []),
        sizeVariants: p.sizeVariants || [],
        sizes: p.sizes || []
      };
    });

    res.json({
      success: true,
      metrics: {
        totalProducts,
        lowStockCount,
        outOfStockCount,
        healthyStockCount,
        threshold: LOW_STOCK_THRESHOLD
      },
      count: items.length,
      inventory: items
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch inventory", error: error.message });
  }
};

export const updateAdminInventoryStock = async (req, res) => {
  try {
    const { id } = req.params;
    let { stock, stockQuantity, addQuantity, sizeVariants, variantSize } = req.body || {};

    if (typeof req.body === "number") {
      stock = req.body;
    } else if (stock === undefined && stockQuantity !== undefined) {
      stock = stockQuantity;
    }

    let product = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      product = await Product.findById(id);
    }
    if (!product) {
      product = await Product.findOne({ sku: id });
    }
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    if (variantSize && (stock !== undefined || addQuantity !== undefined)) {
      if (Array.isArray(product.sizeVariants)) {
        const vIdx = product.sizeVariants.findIndex(
          (v) => v.size.toLowerCase() === variantSize.toLowerCase()
        );
        if (vIdx >= 0) {
          const current = product.sizeVariants[vIdx].stock || 0;
          product.sizeVariants[vIdx].stock = stock !== undefined ? Math.max(0, Number(stock)) : Math.max(0, current + Number(addQuantity));
        }
      }
      product.stock = product.sizeVariants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
    } else if (Array.isArray(sizeVariants) && sizeVariants.length > 0) {
      product.sizeVariants = sizeVariants;
      product.stock = sizeVariants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
    } else if (stock !== undefined) {
      product.stock = Math.max(0, Number(stock));
      if (Array.isArray(product.sizeVariants) && product.sizeVariants.length > 0) {
        const perVariant = Math.floor(product.stock / product.sizeVariants.length);
        const remainder = product.stock % product.sizeVariants.length;
        product.sizeVariants.forEach((v, idx) => {
          v.stock = perVariant + (idx === 0 ? remainder : 0);
        });
      }
    } else if (addQuantity !== undefined) {
      const current = product.stock || 0;
      product.stock = Math.max(0, current + Number(addQuantity));
      if (Array.isArray(product.sizeVariants) && product.sizeVariants.length > 0) {
        const added = Number(addQuantity);
        if (added > 0) {
          const perVariant = Math.floor(added / product.sizeVariants.length);
          const remainder = added % product.sizeVariants.length;
          product.sizeVariants.forEach((v, idx) => {
            v.stock = (v.stock || 0) + perVariant + (idx === 0 ? remainder : 0);
          });
        }
      }
    } else {
      return res.status(400).json({ success: false, message: "Please provide stock or addQuantity to update inventory" });
    }

    if (product.stock === 0) {
      product.status = "out-of-stock";
    } else if (product.status === "out-of-stock") {
      product.status = "available";
    }

    const savedProduct = await product.save();

    res.json({
      success: true,
      message: "Inventory stock updated successfully",
      product: {
        ...savedProduct.toObject(),
        id: savedProduct._id.toString(),
        _id: savedProduct._id.toString(),
        stockQuantity: savedProduct.stock,
        stock: savedProduct.stock
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update inventory stock", error: error.message });
  }
};

export const quickRestockAdminInventory = async (req, res) => {
  try {
    const { productId, id, quantity = 50, variantSize } = req.body;
    const targetId = productId || id;

    if (!targetId) {
      return res.status(400).json({ success: false, message: "Valid productId is required" });
    }

    let product = null;
    if (mongoose.Types.ObjectId.isValid(targetId)) {
      product = await Product.findById(targetId);
    }
    if (!product) {
      product = await Product.findOne({ sku: targetId });
    }
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const addQty = Math.max(1, Number(quantity) || 50);

    if (variantSize && Array.isArray(product.sizeVariants) && product.sizeVariants.length > 0) {
      const v = product.sizeVariants.find((item) => item.size.toLowerCase() === variantSize.toLowerCase());
      if (v) {
        v.stock = (v.stock || 0) + addQty;
      }
      product.stock = product.sizeVariants.reduce((sum, item) => sum + (Number(item.stock) || 0), 0);
    } else {
      product.stock = (product.stock || 0) + addQty;
      if (Array.isArray(product.sizeVariants) && product.sizeVariants.length > 0) {
        const perVariant = Math.floor(addQty / product.sizeVariants.length);
        const remainder = addQty % product.sizeVariants.length;
        product.sizeVariants.forEach((v, idx) => {
          v.stock = (v.stock || 0) + perVariant + (idx === 0 ? remainder : 0);
        });
      }
    }

    if (product.status === "out-of-stock" && product.stock > 0) {
      product.status = "available";
    }

    const savedProduct = await product.save();

    res.json({
      success: true,
      message: `Successfully restocked ${addQty} units for ${savedProduct.name}`,
      product: {
        ...savedProduct.toObject(),
        id: savedProduct._id.toString(),
        _id: savedProduct._id.toString(),
        stockQuantity: savedProduct.stock,
        stock: savedProduct.stock
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to restock product", error: error.message });
  }
};



export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const adminId = req.user.id;

    const admin = await Admin.findById(adminId);
    if (!admin) {
      return res.status(404).json({ message: "Admin not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, admin.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    admin.password = hashedPassword;
    await admin.save();

    res.json({ message: "Password changed successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const getRecentActivities = async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).limit(5);
    const activities = users.map(user => ({
      user: user.name,
      action: "was added to the system",
      time: new Date(user.createdAt).toLocaleString()
    }));
    res.json(activities);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const getChartData = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ status: 'active' });
    const inactiveUsers = await User.countDocuments({ status: 'inactive' });
    const totalAdmins = await Admin.countDocuments();
    
    const maxValue = Math.max(totalUsers, activeUsers, inactiveUsers, totalAdmins, 1);
    
    const chartData = [
      { label: 'Total Users', value: totalUsers, percentage: (totalUsers / maxValue) * 100 },
      { label: 'Active Users', value: activeUsers, percentage: (activeUsers / maxValue) * 100 },
      { label: 'Inactive Users', value: inactiveUsers, percentage: (inactiveUsers / maxValue) * 100 },
      { label: 'Total Admins', value: totalAdmins, percentage: (totalAdmins / maxValue) * 100 },
      { label: 'New Users', value: Math.floor(totalUsers * 0.3), percentage: (Math.floor(totalUsers * 0.3) / maxValue) * 100 },
      { label: 'Monthly Growth', value: Math.floor(totalUsers * 0.2), percentage: (Math.floor(totalUsers * 0.2) / maxValue) * 100 },
      { label: 'Weekly Active', value: Math.floor(activeUsers * 0.8), percentage: (Math.floor(activeUsers * 0.8) / maxValue) * 100 }
    ];
    
    res.json(chartData);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const getPlatformSettings = async (req, res) => {
  try {
    let settings = await PlatformSetting.findOne({ key: "global_settings" });
    if (!settings) {
      settings = await PlatformSetting.create({ key: "global_settings" });
    }
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch settings", error: error.message });
  }
};

export const getPublicPlatformSettings = async (req, res) => {
  try {
    let settings = await PlatformSetting.findOne({ key: "global_settings" });
    if (!settings) {
      settings = await PlatformSetting.create({ key: "global_settings" });
    }
    const threshold = settings.minOrderFreeShipping !== undefined ? Number(settings.minOrderFreeShipping) : (settings.freeShippingThreshold !== undefined ? Number(settings.freeShippingThreshold) : 999);
    const commRate = settings.defaultCommissionRate !== undefined ? Number(settings.defaultCommissionRate) : 5;
    const universalShippingFee = (settings.shippingFee !== undefined && settings.shippingFee !== null) ? Number(settings.shippingFee) : 49;
    res.json({
      freeShippingThreshold: threshold,
      minOrderFreeShipping: threshold,
      shippingFee: universalShippingFee,
      defaultCommissionRate: commRate,
      commissionRate: commRate,
      supportEmail: settings.supportEmail || "support@bookvardi.in",
      supportPhone: settings.supportPhone || "+91 98765 43210"
    });
  } catch (error) {
    console.error("Error in getPublicPlatformSettings:", error);
    res.json({ freeShippingThreshold: 999, minOrderFreeShipping: 999, shippingFee: 49, defaultCommissionRate: 5, commissionRate: 5 });
  }
};

export const updatePlatformSettings = async (req, res) => {
  try {
    const updates = req.body;
    if (updates.minOrderFreeShipping !== undefined) {
      updates.freeShippingThreshold = Number(updates.minOrderFreeShipping);
    } else if (updates.freeShippingThreshold !== undefined) {
      updates.minOrderFreeShipping = Number(updates.freeShippingThreshold);
    }
    if (updates.shippingFee !== undefined && updates.shippingFee !== null) {
      updates.shippingFee = Number(updates.shippingFee);
    }
    let settings = await PlatformSetting.findOneAndUpdate(
      { key: "global_settings" },
      { $set: { ...updates, updatedAt: new Date() } },
      { new: true, upsert: true }
    );

    // Dynamic two-way sync: Update active Free Delivery Announcement item if threshold changed
    const effectiveThreshold = Number(settings.freeShippingThreshold ?? settings.minOrderFreeShipping);
    if (!isNaN(effectiveThreshold) && effectiveThreshold > 0) {
      try {
        const Announcement = (await import("../models/Announcement.js")).default;
        const freeDeliveryAnnouncements = await Announcement.find({
          $or: [
            { badge: { $regex: /free\s*delivery/i } },
            { text: { $regex: /free\s*(delivery|shipping)/i } }
          ]
        });

        for (const item of freeDeliveryAnnouncements) {
          const updatedText = item.text.replace(
            /((?:over|above|min(?:imum)?|orders?\s*(?:over|above)?)\s*(?:₹|rs\.?|inr)?\s*)\d+/i,
            `$1${effectiveThreshold}`
          );
          if (updatedText !== item.text) {
            item.text = updatedText;
            await item.save();
          }
        }
      } catch (announcementSyncErr) {
        console.warn("Announcement threshold sync warning:", announcementSyncErr.message);
      }
    }

    res.json({ message: "Platform settings updated successfully", settings });
  } catch (error) {
    res.status(500).json({ message: "Failed to update settings", error: error.message });
  }
};


export const globalSearch = async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.json([]);
    }

    const searchRegex = new RegExp(q, 'i');
    const results = [];

    const users = await User.find({
      $or: [
        { name: searchRegex },
        { email: searchRegex }
      ]
    }).limit(10);

    users.forEach(user => {
      results.push({
        type: 'user',
        name: user.name,
        details: user.email,
        id: user._id
      });
    });

    res.json(results);
  } catch (error) {
    res.status(500).json({ message: "Search failed", error: error.message });
  }
};
