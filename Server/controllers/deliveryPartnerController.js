import Order from "../models/Order.js";
import Seller from "../models/Seller.js";
import {
  getOrInitDeliveryConfig,
  checkServiceabilityService,
  generateShipmentAwbService,
  getLiveAwbTrackingService,
  cancelShipmentService
} from "../services/deliveryPartnerService.js";
import { registerSellerPickupAddress, getShiprocketLabel } from "../services/shiprocketService.js";

// GET /api/delivery/config
export const getDeliveryConfig = async (req, res) => {
  try {
    const config = await getOrInitDeliveryConfig();
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch delivery config", error: error.message });
  }
};

// PUT /api/delivery/config
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

// POST /api/delivery/serviceability
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

// POST /api/delivery/create-shipment — Multi-seller aware AWB generation
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

    const isCompleted = ["delivered", "completed", "cancelled", "canceled"].includes(
      String(order.overallStatus || order.status || "").toLowerCase()
    );
    if (isCompleted) {
      return res.status(400).json({
        success: false,
        message: `Order is already '${order.overallStatus || order.status}' and cannot be dispatched.`
      });
    }

    // ── Multi-Seller Split: group items by sellerId ───────────────────────────
    const items = Array.isArray(order.items) ? order.items : [];
    const sellerMap = new Map();

    for (const item of items) {
      const sellerIdRaw = String(item.sellerId?._id || item.sellerId || "default");
      if (!sellerMap.has(sellerIdRaw)) sellerMap.set(sellerIdRaw, []);
      sellerMap.get(sellerIdRaw).push(item);
    }

    const isMultiSeller = sellerMap.size > 1;
    const shipmentResults = [];

    for (const [sellerIdStr, sellerItems] of sellerMap) {
      const subOrderData = {
        ...order.toObject(),
        items: sellerItems,
        orderId: isMultiSeller
          ? `${order.orderId || order.id}-${sellerIdStr.slice(-6)}`
          : (order.orderId || order.id),
        sellerId: sellerIdStr !== "default" ? sellerIdStr : order.sellerId
      };

      const result = await generateShipmentAwbService(
        subOrderData,
        courierCode || "SHIPROCKET",
        weightKg || 1,
        dimensions || {},
        req.body.courierId || null
      );

      shipmentResults.push({ sellerId: sellerIdStr, ...result });

      // Update item-level thirdPartyDetails for this seller's items
      for (const item of order.items) {
        const itemSellerId = String(item.sellerId?._id || item.sellerId || "default");
        if (itemSellerId === sellerIdStr) {
          item.deliveryType = "third_party";
          item.thirdPartyDetails = {
            courierName: result.shipment.courierPartnerName,
            trackingNumber: result.shipment.awbNumber,
            trackingUrl: result.shipment.trackingUrl,
            estimatedDeliveryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
          };
        }
      }
    }

    const primaryResult = shipmentResults[0];
    const allAwbs = shipmentResults.map(r => r.shipment?.awbNumber).filter(Boolean).join(", ");
    const allCouriers = [...new Set(shipmentResults.map(r => r.shipment?.courierPartnerName).filter(Boolean))].join(", ");

    order.deliveryMode = "third_party";
    order.deliveryType = "third_party";
    order.courierName = allCouriers || primaryResult.shipment.courierPartnerName;
    order.carrier = order.courierName;
    order.trackingNumber = isMultiSeller ? allAwbs : primaryResult.shipment.awbNumber;
    order.trackingUrl = primaryResult.shipment.trackingUrl;
    order.selfDeliveryDetails = undefined;
    order.overallStatus = "shipped";
    order.status = "shipped";

    order.set("shipmentDetails", {
      isMultiSeller,
      shipments: shipmentResults.map(r => r.shipment),
      shiprocketOrderId: primaryResult.shipment.shiprocketOrderId,
      shiprocketShipmentId: primaryResult.shipment.shiprocketShipmentId
    }, { strict: false });

    order.timeline.push({
      status: "shipped",
      title: `Dispatched via ${order.courierName}`,
      description: isMultiSeller
        ? `Multi-seller shipment: ${shipmentResults.length} AWBs generated (${allAwbs})`
        : `AWB ${primaryResult.shipment.awbNumber} assigned via Shiprocket. Pickup: ${primaryResult.shipment.pickupLocation}`,
      location: primaryResult.shipment.pickupLocation || process.env.SHIPROCKET_PICKUP_LOCATION || "Seller Warehouse",
      timestamp: new Date(),
      updatedBy: req.user?.storeName || req.user?.name || "Logistics Manager"
    });

    order.markModified("items");
    await order.save();

    res.json({
      success: true,
      message: isMultiSeller
        ? `Multi-seller shipment booked! ${shipmentResults.length} AWBs generated: ${allAwbs}`
        : primaryResult.message,
      isMultiSeller,
      awbNumber: isMultiSeller ? allAwbs : primaryResult.shipment.awbNumber,
      courierName: order.courierName,
      shipments: shipmentResults.map(r => ({
        sellerId: r.sellerId,
        awbNumber: r.shipment?.awbNumber,
        courierName: r.shipment?.courierPartnerName,
        shiprocketOrderId: r.shipment?.shiprocketOrderId,
        shiprocketShipmentId: r.shipment?.shiprocketShipmentId,
        shippingLabelUrl: r.shipment?.shippingLabelUrl || "",
        pickupLocation: r.shipment?.pickupLocation,
        pickupScheduledDate: r.shipment?.pickupScheduledDate
      })),
      order
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to create shipment AWB", error: error.message });
  }
};

// POST /api/delivery/register-pickup — Register/re-sync seller pickup address on Shiprocket
export const registerSellerPickup = async (req, res) => {
  try {
    const sellerId = req.user?.id || req.body.sellerId;
    if (!sellerId) return res.status(400).json({ success: false, message: "Seller ID required" });

    const seller = await Seller.findById(sellerId).select("-password");
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    const result = await registerSellerPickupAddress(seller);
    if (result.success) {
      await Seller.findByIdAndUpdate(sellerId, {
        shiprocketPickupLocation: result.pickupLocationName,
        shiprocketPickupRegisteredAt: new Date()
      });
    }

    res.json({
      success: result.success,
      pickupLocationName: result.pickupLocationName || null,
      message: result.success
        ? `Pickup address registered on Shiprocket as "${result.pickupLocationName}"`
        : result.error || "Registration failed"
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to register pickup address", error: error.message });
  }
};

// GET /api/delivery/track/:awb
export const trackAwb = async (req, res) => {
  try {
    const { awb } = req.params;
    const trackingInfo = await getLiveAwbTrackingService(awb);
    res.json(trackingInfo);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to track AWB shipment", error: error.message });
  }
};

// POST /api/delivery/cancel-shipment
export const cancelShipment = async (req, res) => {
  try {
    const { awbNumber, orderId } = req.body;

    let order = null;
    if (orderId) {
      order = await Order.findById(orderId).catch(() => null);
      if (!order) order = await Order.findOne({ $or: [{ orderId }, { id: orderId }] });
    }

    // Cancel all Shiprocket shipments (supports multi-seller)
    const shipmentDetails = order?.shipmentDetails;
    const srOrderIds = shipmentDetails?.isMultiSeller
      ? (shipmentDetails.shipments || []).map(s => s.shiprocketOrderId).filter(Boolean)
      : [shipmentDetails?.shiprocketOrderId || req.body.shiprocketOrderId].filter(Boolean);

    for (const srOrderId of srOrderIds) {
      try {
        await cancelShipmentService([srOrderId]);
        console.log(`✅ [SHIPROCKET] Cancelled SR order ${srOrderId}`);
      } catch (srErr) {
        console.warn("⚠️ [SHIPROCKET] Cancel on Shiprocket failed (continuing):", srErr.message);
      }
    }

    if (order) {
      order.overallStatus = "processing";
      order.status = "processing";
      order.trackingNumber = "";
      order.trackingUrl = "";
      order.courierName = "";
      order.timeline.push({
        status: "processing",
        title: "Courier Shipment Booking Cancelled",
        description: `AWB ${awbNumber || order.trackingNumber} cancelled on Shiprocket. Order reset for re-dispatch.`,
        location: "Seller Warehouse",
        timestamp: new Date(),
        updatedBy: req.user?.name || "Logistics Manager"
      });
      await order.save();
    }

    res.json({
      success: true,
      message: `Shipment AWB ${awbNumber} cancelled successfully on Shiprocket.`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to cancel shipment AWB", error: error.message });
  }
};

// GET /api/delivery-partners/label/:orderId
export const getShippingLabel = async (req, res) => {
  try {
    const { orderId } = req.params;
    let order = await Order.findById(orderId).catch(() => null);
    if (!order) {
      order = await Order.findOne({ $or: [{ orderId }, { id: orderId }] });
    }
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const shipmentDetails = order.shipmentDetails || {};
    let labelUrl = shipmentDetails.shippingLabelUrl || "";

    if (!labelUrl) {
      const shipmentId = shipmentDetails.shiprocketShipmentId || (shipmentDetails.shipments && shipmentDetails.shipments[0]?.shiprocketShipmentId);
      if (shipmentId) {
        const labelResult = await getShiprocketLabel(shipmentId);
        if (labelResult?.labelUrl) {
          labelUrl = labelResult.labelUrl;
          order.set("shipmentDetails.shippingLabelUrl", labelUrl, { strict: false });
          await order.save();
        }
      }
    }

    res.json({
      success: true,
      labelUrl,
      awbNumber: order.trackingNumber || "",
      courierName: order.courierName || ""
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to get shipping label", error: error.message });
  }
};
