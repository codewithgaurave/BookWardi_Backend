import express from "express";
import {
  applyCoupon,
  getActiveCoupons,
  createCoupon,
  getAllCouponsAdmin,
  deleteCoupon,
  updateCoupon
} from "../controllers/couponController.js";
import { authenticateAdmin } from "../middlewares/auth.js";

const router = express.Router();

// Public / Customer routes
router.post("/apply", applyCoupon);
router.get("/active", getActiveCoupons);

// Admin / Seller routes
router.get("/", getAllCouponsAdmin);
router.post("/", createCoupon);
router.put("/:id", updateCoupon);
router.delete("/:id", deleteCoupon);
router.get("/admin", authenticateAdmin, getAllCouponsAdmin);
router.post("/admin", authenticateAdmin, createCoupon);
router.put("/admin/:id", authenticateAdmin, updateCoupon);
router.delete("/admin/:id", authenticateAdmin, deleteCoupon);

export default router;
