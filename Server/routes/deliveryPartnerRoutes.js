import express from "express";
import {
  getDeliveryConfig,
  updateDeliveryConfig,
  checkServiceability,
  createShipment,
  trackAwb,
  cancelShipment
} from "../controllers/deliveryPartnerController.js";

const router = express.Router();

// Logistics Configuration & Credentials
router.get("/config", getDeliveryConfig);
router.put("/config", updateDeliveryConfig);

// Serviceability & Instant Rate Calculation
router.post("/serviceability", checkServiceability);

// Shipment AWB Generation & Dispatch
router.post("/create-shipment", createShipment);

// Live AWB Shipment Tracking
router.get("/track/:awb", trackAwb);

// Cancel Shipment Booking
router.post("/cancel-shipment", cancelShipment);

export default router;
