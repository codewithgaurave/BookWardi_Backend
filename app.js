import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();
import connectDB from "./config/db.js";
import mongoose from "mongoose";

// Ensure all upload directories exist on server startup
["uploads", "uploads/avatars", "uploads/documents", "uploads/products"].forEach((dir) => {
  const fullPath = path.join(process.cwd(), dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});


// Models & initial setup
import Admin from "./Server/models/Admin.js";
import User from "./Server/models/User.js";
import Seller from "./Server/models/Seller.js";
import Kit from "./Server/models/Kit.js";
import bcrypt from "bcryptjs";

// Routes
import adminRoutes from "./Server/routes/adminRoutes.js";
import sellerRoutes from "./Server/routes/sellerRoutes.js";
import productRoutes from "./Server/routes/productRoutes.js";
import kitRoutes from "./Server/routes/kitRoutes.js";
import categoryRoutes from "./Server/routes/categoryRoutes.js";
import orderRoutes from "./Server/routes/orderRoutes.js";
import paymentRoutes from "./Server/routes/paymentRoutes.js";
import deliveryRoutes from "./Server/routes/deliveryRoutes.js";
import storeRoutes from "./Server/routes/storeRoutes.js";
import userRoutes from "./Server/routes/userRoutes.js";
import cartRoutes from "./Server/routes/cartRoutes.js";
import wishlistRoutes from "./Server/routes/wishlistRoutes.js";
import couponRoutes from "./Server/routes/couponRoutes.js";
import reviewRoutes from "./Server/routes/reviewRoutes.js";
import schoolRoutes from "./Server/routes/schoolRoutes.js";
import contactRoutes from "./Server/routes/contactRoutes.js";
import announcementRoutes from "./Server/routes/announcementRoutes.js";
import realtimeRoutes from "./Server/routes/realtimeRoutes.js";

import helmet from "helmet";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();

// 1. Connect to MongoDB and seed default accounts once connected
connectDB()
  .then(async () => {
    await initDefaultAdmin();
  })
  .catch(() => {});

// Middleware: Auto-reconnect MongoDB if connection drops or disconnects
app.use(async (req, res, next) => {
  if (mongoose.connection.readyState === 0) {
    console.warn("⚠️ MongoDB connection was disconnected. Auto-reconnecting...");
    try {
      await connectDB();
    } catch (e) {
      console.error("Failed to auto-reconnect MongoDB:", e.message);
    }
  }
  next();
});

// 2. Create Default Admin & ensure Phone 1231231232 has admin role
const initDefaultAdmin = async () => {
  try {
    let admin = await Admin.findOne({ email: "admin@admin.com" });
    if (!admin) {
      admin = new Admin({
        name: "Super Admin",
        email: "admin@admin.com",
        phone: "1231231232",
        password: "admin123",
        role: "super_admin",
        status: "active"
      });
      await admin.save();
      console.log("Default admin created in DB: admin@admin.com / admin123");
    } else {
      const isValid = await bcrypt.compare("admin123", admin.password).catch(() => false);
      if (!isValid && admin.password !== "admin123") {
        admin.password = "admin123";
        await admin.save();
        console.log("Default admin password re-synchronized in DB with bcrypt hash.");
      }
    }

    const phoneAdmin = await User.findOne({
      $or: [
        { phone: "1231231232" },
        { phone: "+911231231232" },
        { phone: "+91 1231231232" }
      ]
    });
    if (phoneAdmin && phoneAdmin.role !== "admin") {
      phoneAdmin.role = "admin";
      phoneAdmin.status = "active";
      await phoneAdmin.save();
      console.log("Updated user 1231231232 to admin role");
    }
  } catch (error) {
    console.error("Default admin creation error:", error.message);
  }
};



// 3. Security Middlewares (Helmet & Rate Limiting)
app.use(helmet({ crossOriginResourcePolicy: false })); // Secure HTTP Headers

export const allowedOrigins = ["* (All origins allowed)"];

// Allow all origins dynamically with credentials support
app.use(cors({
  origin: true,
  credentials: true
}));

// Global Rate Limiter: 1000 requests per 15 mins (bypassed in development/local)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 2000 : 100000,
  skip: (req) => {
    const ip = req.ip || req.connection?.remoteAddress || '';
    return ip.includes('127.0.0.1') || ip === '::1' || ip.includes('::ffff:127.0.0.1') || process.env.NODE_ENV !== "production";
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests from this IP, please try again after 15 minutes." }
});
app.use("/api", globalLimiter);

// Strict Auth / Sensitive Rate Limiter: 30 attempts per 15 mins for login / register / OTP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login/auth attempts, please try again later." }
});
app.use("/api/users/login", authLimiter);
app.use("/api/users/register", authLimiter);
app.use("/api/users/forgot-password", authLimiter);
app.use("/api/seller/login", authLimiter);
app.use("/api/admin/login", authLimiter);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Graceful handler for malformed JSON request bodies
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400) && 'body' in err) {
    return res.status(400).json({
      success: false,
      message: "Malformed JSON payload in request body. Please verify request JSON syntax.",
      error: "Bad Request"
    });
  }
  next(err);
});

// Console Request Logger Middleware (Disabled by default to keep console clean on API calls)
if (process.env.ENABLE_REQUEST_LOGGING === "true") {
  app.use((req, res, next) => {
    const hasAuth = req.headers.authorization || req.headers['x-user-phone'] || req.headers['x-seller-phone'] || req.headers['x-seller-id'] || req.headers['x-user-id'];
    const authHeader = hasAuth ? ' [Auth: Present]' : ' [Auth: None]';
    console.log(`📡 [BACKEND REQ] ${new Date().toLocaleTimeString('en-IN')} | ${req.method} ${req.originalUrl}${authHeader}`);
    if (req.body && Object.keys(req.body).length > 0) {
      const bodyCopy = { ...req.body };
      if (bodyCopy.password) bodyCopy.password = '***';
      console.log(`   └─ Body:`, JSON.stringify(bodyCopy).slice(0, 300));
    }
    next();
  });
}

// 4. Serve Static Uploads (Documents & Product Images)
app.use("/uploads", express.static(path.join(process.cwd(), "uploads"), {
  setHeaders: (res, filePath) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (filePath.toLowerCase().endsWith(".pdf")) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "inline");
    }
  }
}));

// Fallback for missing avatar image requests (prevents 404 errors when avatar file does not exist on disk)
app.use("/uploads/avatars", (req, res) => {
  res.redirect("https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400&auto=format&fit=crop&q=80");
});

// 5. API Routes
app.use("/api/admin", adminRoutes);
app.use("/api/seller", sellerRoutes);
app.use("/api/users", userRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/products", productRoutes);
app.use("/api/kits", kitRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/delivery", deliveryRoutes);
app.use("/api/stores", storeRoutes);
app.use("/api/schools", schoolRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/announcements", announcementRoutes);
app.use("/api/realtime", realtimeRoutes);

// 6. Health & Status Check
app.get("/api/health", (req, res) => {
  const mongoStateMap = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting"
  };
  const mongoStateCode = mongoose.connection.readyState;
  const mongoStatus = mongoStateMap[mongoStateCode] || "unknown";
  const isMongoConnected = mongoStateCode === 1;

  console.log(`🩺 [HEALTH CHECK] Server is running | MongoDB Status: ${mongoStatus.toUpperCase()} (Connected: ${isMongoConnected})`);

  res.json({
    status: "OK",
    server: "start",
    serverStarted: true,
    mongodb: mongoStatus,
    mongodbConnected: isMongoConnected,
    dbName: isMongoConnected ? (mongoose.connection.name || null) : null,
    host: isMongoConnected ? (mongoose.connection.host || null) : null,
    uptime: `${Math.floor(process.uptime())}s`,
    service: "SchoolKart Multi-Vendor Backend API",
    timestamp: new Date().toISOString()
  });
});

// 7. Global Error Handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400)) {
    return res.status(400).json({
      success: false,
      message: "Malformed request payload format",
      error: "Bad Request"
    });
  }
  console.error("Unhandled Error:", err);
  res.status(err.status || 500).json({
    message: err.message || "Internal Server Error",
    error: process.env.NODE_ENV === "development" ? err : {}
  });
});

export default app;
