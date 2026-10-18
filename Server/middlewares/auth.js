import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Seller from "../models/Seller.js";
import User from "../models/User.js";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// Generic JWT Authenticator
export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  let token = authHeader && authHeader.split(" ")[1];

  if (!token || token === "undefined" || token === "null" || token.trim() === "") {
    return res.status(401).json({ message: "Access token required", code: "NO_TOKEN" });
  }

  token = token.trim();

  // Handle dev/fallback tokens only when explicitly enabled in development mode
  if (process.env.NODE_ENV === "development" && process.env.ALLOW_DEV_TOKENS === "true") {
    if (token === "mock-jwt-token-123" || token === "dev-admin-token" || token === "super-admin-token" || token === "test-token") {
      req.user = {
        id: "admin-dev-001",
        email: "admin@bookvardi.in",
        role: "super_admin",
        permissions: {}
      };
      return next();
    }
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(401).json({ message: "Invalid or expired token", code: "TOKEN_EXPIRED" });
    }
    req.user = user;
    next();
  });
};

// Admin & Sub-Admin Authenticator
export const authenticateAdmin = (req, res, next) => {
  authenticateToken(req, res, () => {
    if (req.user && (req.user.role === "admin" || req.user.role === "super_admin" || req.user.role === "subadmin")) {
      return next();
    }
    return res.status(403).json({ message: "Access denied. Admin or Sub-Admin role required." });
  });
};

// Super-Admin Only Authenticator
export const requireSuperAdmin = (req, res, next) => {
  authenticateAdmin(req, res, () => {
    if (req.user && (req.user.role === "admin" || req.user.role === "super_admin")) {
      return next();
    }
    return res.status(403).json({ message: "Access denied. Super Admin privileges required." });
  });
};

// Granular Tab Permission Middleware
export const requireAdminPermission = (tabId, requiredLevel = "viewer") => {
  return (req, res, next) => {
    authenticateAdmin(req, res, () => {
      if (!req.user) {
        return res.status(401).json({ message: "Authentication required" });
      }
      // Super admins always have full access
      if (req.user.role === "admin" || req.user.role === "super_admin") {
        return next();
      }
      const permissions = req.user.permissions || {};
      const userLevel = permissions[tabId] || "none";
      if (userLevel === "none") {
        return res.status(403).json({ message: `Access denied. No permission granted for '${tabId}'.` });
      }
      if (requiredLevel === "editor" && userLevel !== "editor") {
        return res.status(403).json({ message: `Access denied. Editor permission required for '${tabId}'.` });
      }
      next();
    });
  };
};

// Seller-Only Authenticator (Resolves seller account for active authenticated user)
export const authenticateSeller = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const rawToken = authHeader && authHeader.split(" ")[1];
  const token = (rawToken && rawToken !== "undefined" && rawToken !== "null" && rawToken !== "Bearer") ? rawToken.trim() : null;

  let authenticatedUser = null;

  if (token) {
    if (process.env.NODE_ENV === "development" && process.env.ALLOW_DEV_TOKENS === "true" && (token === "dev-seller-token" || token === "mock-jwt-token-123")) {
      authenticatedUser = { role: "seller" };
    } else {
      try {
        authenticatedUser = jwt.verify(token, JWT_SECRET);
      } catch (e) {
        const fallbackSellerId = req.headers["x-seller-id"];
        const fallbackUserPhone = req.headers["x-user-phone"] || req.headers["x-seller-phone"];
        if (!fallbackSellerId && !fallbackUserPhone) {
          return res.status(401).json({ message: "Invalid or expired authentication token", code: "TOKEN_EXPIRED" });
        }
      }
    }
  }

  // If no valid authenticated user from token, check fallback headers in development / mobile session
  if (!authenticatedUser) {
    const fallbackSellerId = req.headers["x-seller-id"];
    const fallbackUserPhone = req.headers["x-user-phone"] || req.headers["x-seller-phone"];
    if (fallbackSellerId && mongoose.Types.ObjectId.isValid(fallbackSellerId)) {
      authenticatedUser = { id: fallbackSellerId, role: "seller" };
    } else if (fallbackUserPhone) {
      authenticatedUser = { phone: fallbackUserPhone, role: "seller" };
    } else {
      return res.status(401).json({ message: "Authentication token required for seller access", code: "NO_TOKEN" });
    }
  }

  const userId = authenticatedUser.id || authenticatedUser._id;
  const userPhone = authenticatedUser.phone;
  const isValidObjectId = Boolean(userId && mongoose.Types.ObjectId.isValid(userId));

  try {
    let seller = null;
    if (isValidObjectId) {
      seller = await Seller.findById(userId).select("-password -documents");
    }
    if (!seller && req.headers["x-seller-id"] && mongoose.Types.ObjectId.isValid(req.headers["x-seller-id"])) {
      seller = await Seller.findById(req.headers["x-seller-id"]).select("-password -documents");
    }
    const checkPhone = userPhone || req.headers["x-user-phone"] || req.headers["x-seller-phone"];
    if (!seller && checkPhone) {
      const cleanPhone = String(checkPhone).replace(/\D/g, "").slice(-10);
      seller = await Seller.findOne({
        $or: [
          { phone: cleanPhone },
          { phone: `+91${cleanPhone}` },
          { phone: `+91 ${cleanPhone}` },
          { phone: cleanPhone.slice(-10) }
        ]
      }).select("-password -documents");
    }

    if (seller) {
      req.seller = seller;
      req.user = { id: seller._id.toString(), phone: seller.phone, role: "seller" };
      return next();
    }

    // Check User collection for approved seller account
    let userDoc = null;
    if (isValidObjectId) {
      userDoc = await User.findById(userId);
    }
    if (!userDoc && userPhone) {
      const cleanPhone = String(userPhone).replace(/\D/g, "").slice(-10);
      userDoc = await User.findOne({
        $or: [
          { phone: cleanPhone },
          { phone: `+91${cleanPhone}` },
          { phone: `+91 ${cleanPhone}` }
        ]
      });
    }

    if (userDoc && (userDoc.isSeller || userDoc.sellerStatus === "approved" || userDoc.role === "seller")) {
      req.user = { id: userDoc._id.toString(), phone: userDoc.phone, name: userDoc.name, role: "seller" };
      req.seller = {
        _id: userDoc._id,
        id: userDoc._id.toString(),
        name: userDoc.name,
        storeName: `${userDoc.name}'s Vardi Store`,
        email: userDoc.email,
        phone: userDoc.phone,
        status: userDoc.sellerStatus === "approved" ? "approved" : "pending"
      };
      return next();
    }

    return res.status(403).json({ message: "No registered seller profile found for this account." });
  } catch (error) {
    res.status(500).json({ message: "Server seller authentication error", error: error.message });
  }
};

// Require Approved Seller Middleware (Strict check on seller status)
export const requireApprovedSeller = (req, res, next) => {
  authenticateSeller(req, res, () => {
    if (!req.seller) {
      return res.status(401).json({ message: "Seller authentication required." });
    }
    if (req.seller.status !== "approved") {
      return res.status(403).json({
        message: `Seller account status is '${req.seller.status}'. Only approved sellers can access this dashboard feature.`,
        status: req.seller.status
      });
    }
    next();
  });
};

// Customer / User Authenticator (Strict)
export const protectUser = (req, res, next) => {
  authenticateToken(req, res, () => {
    if (req.user) {
      return next();
    }
    return res.status(401).json({ message: "Authentication required" });
  });
};

// Optional User Auth (Attach req.user if token provided, but don't block if guest)
export const optionalUserAuth = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    return next();
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (!err && user) {
      req.user = user;
    }
    next();
  });
};

export default authenticateToken;