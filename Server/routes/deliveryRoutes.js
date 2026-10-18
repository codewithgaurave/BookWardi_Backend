import express from "express";
import {
  getDeliveryPartnerOrder,
  resendCustomerDeliveryOtp,
  verifyDeliveryOtp,
  updateDriverLocation
} from "../controllers/deliveryController.js";
import {
  getDeliveryConfig,
  updateDeliveryConfig,
  checkServiceability,
  createShipment,
  trackAwb,
  cancelShipment
} from "../controllers/deliveryPartnerController.js";

const router = express.Router();

// Delivery Partner Integration & Courier Aggregator Endpoints
router.get("/config", getDeliveryConfig);
router.put("/config", updateDeliveryConfig);
router.post("/serviceability", checkServiceability);
router.post("/create-shipment", createShipment);
router.get("/track/:awb", trackAwb);
router.post("/cancel-shipment", cancelShipment);

// Delivery Partner Driver & OTP Endpoints
router.get("/partner/:token", getDeliveryPartnerOrder);
router.post("/partner/:token/resend-otp", resendCustomerDeliveryOtp);
router.post("/partner/:token/verify-otp", verifyDeliveryOtp);
router.post("/partner/:token/location", updateDriverLocation);

export default router;