import express from "express";
import {
  getDeliveryConfig,
  updateDeliveryConfig,
  checkServiceability,
  createShipment,
  registerSellerPickup,
  trackAwb,
  cancelShipment,
  getShippingLabel
} from "../controllers/deliveryPartnerController.js";
import { authenticateAdmin, authenticateSeller } from "../middlewares/auth.js";

const router = express.Router();

// Logistics Configuration (Admin only)
router.get("/config", getDeliveryConfig);
router.put("/config", authenticateAdmin, updateDeliveryConfig);

// Serviceability & Rate Check (public — used on checkout)
router.post("/serviceability", checkServiceability);

// Shipment AWB Generation (Admin only — triggers Shiprocket)
router.post("/create-shipment", authenticateAdmin, createShipment);

// Seller Pickup Address Registration on Shiprocket
router.post("/register-pickup", authenticateSeller, registerSellerPickup);

// Live AWB Tracking (public — used on order tracking page)
router.get("/track/:awb", trackAwb);

// Get Shipping Label URL
router.get("/label/:orderId", getShippingLabel);

// Cancel Shipment (Admin only)
router.post("/cancel-shipment", authenticateAdmin, cancelShipment);

export default router;
