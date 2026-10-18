import Order from "../models/Order.js";
import {
  getOrInitDeliveryConfig,
  checkServiceabilityService,
  generateShipmentAwbService,
  getLiveAwbTrackingService
} from "../services/deliveryPartnerService.js";

// GET /api/delivery/config - Fetch platform logistics config & partners
export const getDeliveryConfig = async (req, res) => {
  try {
    const config = await getOrInitDeliveryConfig();
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch delivery config", error: error.message });
  }
};

// PUT /api/delivery/config - Update platform/seller logistics config
export const updateDeliveryConfig = async (req, res) => {
  try {
    let config = await getOrInitDeliveryConfig();
    const { platformDefaultPartner, freeShippingThreshold, baseCodFee, partners } = req.body;

    if (platformDefaultPartner) config.platformDefaultPartner = platformDefaultPartner;
    if (freeShippingThreshold !== undefined) config.freeShippingThreshold = Number(freeShippingThreshold);
    if (baseCodFee !== undefined) config.baseCodFee = Number(baseCodFee);
    if (Array.isArray(partners)) config.partners = partners;

    await config.save();
    res.json({ success: true, message: "Logistics & Delivery Partner configuration updated successfully!", config });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update delivery config", error: error.message });
  }
};

// POST /api/delivery/serviceability - Check rate & courier serviceability by pincode
export const checkServiceability = async (req, res) => {
  try {
    const { pickupPincode, deliveryPincode, weightKg, isCod } = req.body;

    if (!deliveryPincode) {
      return res.status(400).json({ success: false, message: "Delivery destination pincode is required." });
    }

    const result = await checkServiceabilityService({
      pickupPincode: pickupPincode || "226001",
      deliveryPincode,
      weightKg: weightKg || 1,
      isCod: Boolean(isCod)
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to check serviceability", error: error.message });
  }
};

// POST /api/delivery/create-shipment - Generate AWB & Dispatch Order via Courier Partner
export const createShipment = async (req, res) => {
  try {
    const { orderId, courierCode, weightKg, dimensions } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, message: "Order ID is required to generate shipment AWB." });
    }

    let order = await Order.findById(orderId);
    if (!order) {
      order = await Order.findOne({ $or: [{ orderId }, { id: orderId }] });
    }

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    // Check if order is already completed or cancelled
    const isCompleted = ["delivered", "completed", "cancelled", "canceled"].includes(String(order.overallStatus || order.status || "").toLowerCase());
    if (isCompleted) {
      return res.status(400).json({
        success: false,
        message: `Order is already '${order.overallStatus || order.status}' and cannot be dispatched.`
      });
    }

    const result = await generateShipmentAwbService(order, courierCode || "SHIPROCKET", weightKg, dimensions);

    // Update order with AWB and shipment details
    order.deliveryMode = "third_party";
    order.deliveryType = "third_party";
    order.courierName = result.shipment.courierPartnerName;
    order.carrier = result.shipment.courierPartnerName;
    order.trackingNumber = result.shipment.awbNumber;
    order.trackingUrl = `https://track.shiprocket.in/tracking/${result.shipment.awbNumber}`;
    order.selfDeliveryDetails = undefined;
    order.overallStatus = "shipped";
    order.status = "shipped";
    order.set("shipmentDetails", result.shipment, { strict: false });

    // Push timeline entry
    order.timeline.push({
      status: "shipped",
      title: `Dispatched via ${result.shipment.courierPartnerName}`,
      description: `AWB ${result.shipment.awbNumber} generated. Pickup token: ${result.shipment.pickupToken}`,
      location: "Seller Warehouse",
      timestamp: new Date(),
      updatedBy: req.user?.storeName || req.user?.name || "Logistics Manager"
    });

    await order.save();

    res.json({
      success: true,
      message: result.message,
      awbNumber: result.shipment.awbNumber,
      order
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to create shipment AWB", error: error.message });
  }
};

// GET /api/delivery/track/:awb - Fetch live tracking checkpoints for an AWB
export const trackAwb = async (req, res) => {
  try {
    const { awb } = req.params;
    const trackingInfo = await getLiveAwbTrackingService(awb);
    res.json(trackingInfo);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to track AWB shipment", error: error.message });
  }
};

// POST /api/delivery/cancel-shipment - Cancel AWB shipment
export const cancelShipment = async (req, res) => {
  try {
    const { awbNumber, orderId } = req.body;

    if (orderId) {
      let order = await Order.findById(orderId);
      if (!order) {
        order = await Order.findOne({ $or: [{ orderId }, { id: orderId }] });
      }
      if (order) {
        order.overallStatus = "processing";
        order.status = "processing";
        order.timeline.push({
          status: "processing",
          title: "Courier Shipment Booking Cancelled",
          description: `AWB ${awbNumber || order.trackingNumber} cancelled. Waiting for re-dispatch.`,
          location: "Seller Warehouse",
          timestamp: new Date(),
          updatedBy: "Logistics Manager"
        });
        await order.save();
      }
    }

    res.json({
      success: true,
      message: `Shipment AWB ${awbNumber} cancelled successfully.`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to cancel shipment AWB", error: error.message });
  }
};
