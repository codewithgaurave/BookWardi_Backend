import DeliveryPartnerConfig from "../models/DeliveryPartnerConfig.js";
import Order, { generateProductOrderId } from "../models/Order.js";
import {
  checkShiprocketServiceability,
  createShiprocketOrder,
  assignShiprocketAwb,
  generateShiprocketPickup,
  trackShiprocketAwb,
  cancelShiprocketOrder,
  getShiprocketLabel
} from "./shiprocketService.js";

// ─── Helper: Get or initialize delivery config ───────────────────────────────
export const getOrInitDeliveryConfig = async () => {
  let config = await DeliveryPartnerConfig.findOne();
  if (!config) {
    config = new DeliveryPartnerConfig({
      platformDefaultPartner: "shiprocket",
      freeShippingThreshold: 999,
      baseCodFee: 40,
      partners: [
        {
          partnerId: "shiprocket",
          name: "Shiprocket Multi-Courier Aggregator",
          code: "SHIPROCKET",
          active: true,
          isDefault: true,
          avgDays: "2-4 Business Days",
          baseRate: 45,
          perKgRate: 20,
          sandboxMode: false
        },
        {
          partnerId: "delhivery",
          name: "Delhivery Direct Express",
          code: "DELHIVERY",
          active: true,
          isDefault: false,
          avgDays: "1-3 Days",
          baseRate: 50,
          perKgRate: 25,
          sandboxMode: false
        },
        {
          partnerId: "bluedart",
          name: "BlueDart Air Priority",
          code: "BLUEDART",
          active: true,
          isDefault: false,
          avgDays: "1-2 Days",
          baseRate: 75,
          perKgRate: 35,
          sandboxMode: false
        },
        {
          partnerId: "local_express",
          name: "BookVardi Local Hyperlocal Express",
          code: "LOCAL_EXPRESS",
          active: true,
          isDefault: false,
          avgDays: "Same Day / 24 hrs",
          baseRate: 30,
          perKgRate: 15,
          sandboxMode: false
        }
      ]
    });
    await config.save();
  }
  return config;
};

// ─── 1. Serviceability & Courier Rate Check ──────────────────────────────────
export const checkServiceabilityService = async ({ pickupPincode, deliveryPincode, weightKg = 1, isCod = false, codAmount = 0 }) => {
  const pickup = String(pickupPincode || process.env.SHIPROCKET_PICKUP_PINCODE || "226001");
  const delivery = String(deliveryPincode || "110001").trim();
  const weight = Math.max(0.5, Number(weightKg) || 1);

  // Try real Shiprocket serviceability first
  try {
    const result = await checkShiprocketServiceability({
      pickupPincode: pickup,
      deliveryPincode: delivery,
      weightKg: weight,
      isCod,
      codAmount
    });

    if (result.success && result.availablePartners?.length > 0) {
      console.log(`✅ [SHIPROCKET] Serviceability: ${result.availablePartners.length} couriers available for ${pickup} → ${delivery}`);
      return result;
    }
  } catch (err) {
    console.warn("⚠️ [SHIPROCKET] Serviceability API failed, using local fallback:", err.message);
  }

  // Fallback: local rate estimation if Shiprocket API fails
  const config = await getOrInitDeliveryConfig();
  const isMetro = ["11", "40", "56", "70", "60", "50"].some((p) => delivery.startsWith(p));
  const isLocalState = ["22", "20", "26"].some((p) => delivery.startsWith(p));

  const partners = config.partners.map((partner) => {
    let multiplier = isLocalState ? 1.0 : isMetro ? 1.25 : 1.5;
    if (partner.code === "BLUEDART") multiplier *= 1.3;
    if (partner.code === "LOCAL_EXPRESS") multiplier = isLocalState ? 0.8 : 2.0;

    const baseCost = partner.baseRate * multiplier;
    const additionalWeightCost = Math.max(0, weight - 1) * partner.perKgRate;
    const codCharge = isCod ? config.baseCodFee : 0;
    const estimatedRate = Math.round(baseCost + additionalWeightCost + codCharge);

    const estimatedDays =
      partner.code === "LOCAL_EXPRESS" ? (isLocalState ? "Same Day (Within 24 hrs)" : "2-3 Days") :
      partner.code === "BLUEDART" ? (isMetro ? "1-2 Business Days" : "2 Days") :
      partner.code === "DELHIVERY" ? "2-3 Business Days" :
      "2-4 Business Days";

    return {
      partnerId: partner.partnerId,
      name: partner.name,
      code: partner.code,
      active: partner.active,
      isDefault: partner.isDefault,
      serviceable: partner.active,
      estimatedRate,
      estimatedDays,
      codAvailable: true,
      pickupPincode: pickup,
      deliveryPincode: delivery
    };
  });

  return {
    success: true,
    pickupPincode: pickup,
    deliveryPincode: delivery,
    weightKg: weight,
    recommendedPartner: partners.find((p) => p.isDefault) || partners[0],
    availablePartners: partners.filter((p) => p.active)
  };
};

// ─── 2. Create Shipment — Real Shiprocket AWB Generation ─────────────────────
export const generateShipmentAwbService = async (orderData, courierCode = "SHIPROCKET", weightKg = 1, dimensions = {}, courierId = null) => {
  const orderId = orderData.orderId || orderData.id || generateProductOrderId();

  // ── Resolve seller's Shiprocket pickup location ───────────────────────────
  // Priority: seller's registered pickup location → default warehouse
  let sellerPickupLocation = process.env.SHIPROCKET_PICKUP_LOCATION || "warehouse";

  try {
    // Try to get seller's pickup location from DB
    const Seller = (await import("../models/Seller.js")).default;
    const sellerIdRaw = orderData.sellerId ||
      orderData.sellerDetails?.sellerId ||
      orderData.items?.[0]?.sellerId?._id ||
      orderData.items?.[0]?.sellerId ||
      orderData.items?.[0]?.sellerDetails?.sellerId;

    if (sellerIdRaw) {
      const seller = await Seller.findById(sellerIdRaw).select("shiprocketPickupLocation storeName pincode").lean();
      if (seller?.shiprocketPickupLocation) {
        sellerPickupLocation = seller.shiprocketPickupLocation;
        console.log(`✅ [SHIPROCKET] Using seller pickup location: "${sellerPickupLocation}" for order ${orderId}`);
      } else {
        console.log(`⚠️ [SHIPROCKET] Seller has no pickup location registered, using default: "${sellerPickupLocation}"`);
      }
    }
  } catch (err) {
    console.warn("⚠️ [SHIPROCKET] Could not resolve seller pickup location, using default:", err.message);
  }

  // Inject resolved pickup location into order data for createShiprocketOrder
  const orderWithPickup = { ...orderData, _resolvedPickupLocation: sellerPickupLocation };

  // ── Real Shiprocket Flow ──────────────────────────────────────────────────
  try {
    // Step 1: Create order on Shiprocket
    const srOrder = await createShiprocketOrder(orderWithPickup, weightKg, dimensions);

    if (!srOrder.success || !srOrder.shipmentId) {
      throw new Error("Shiprocket order creation did not return a shipment ID");
    }

    // Step 2: Assign AWB
    const awbResult = await assignShiprocketAwb(srOrder.shipmentId, courierId);

    if (!awbResult.success || !awbResult.awbCode) {
      throw new Error("AWB assignment failed after order creation");
    }

    // Step 3: Generate pickup request (non-fatal if fails)
    const pickupResult = await generateShiprocketPickup(srOrder.shipmentId);

    // Step 4: Try to get shipping label URL
    const labelResult = await getShiprocketLabel(srOrder.shipmentId);

    const shipmentData = {
      awbNumber: awbResult.awbCode,
      shiprocketOrderId: srOrder.shiprocketOrderId,
      shiprocketShipmentId: srOrder.shipmentId,
      courierPartnerId: awbResult.courierId || "shiprocket",
      courierPartnerName: awbResult.courierName || "Shiprocket",
      courierPartnerCode: awbResult.courierName?.toUpperCase().replace(/\s+/g, "_") || "SHIPROCKET",
      shippingLabelUrl: labelResult.labelUrl || "",
      manifestUrl: "",
      pickupToken: `PKP-${srOrder.shipmentId}`,
      pickupLocation: sellerPickupLocation,
      status: "booked",
      weightKg: Number(weightKg) || 1,
      dimensions: {
        length: Number(dimensions.length) || 20,
        width: Number(dimensions.width) || 15,
        height: Number(dimensions.height) || 10
      },
      pickupScheduledDate: pickupResult.pickupScheduledDate,
      estimatedDeliveryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      trackingUrl: `https://shiprocket.co/tracking/${awbResult.awbCode}`,
      courierLogs: [
        {
          title: "Shiprocket Order Created",
          description: `SR Order ID: ${srOrder.shiprocketOrderId} | Shipment ID: ${srOrder.shipmentId} | Pickup: ${sellerPickupLocation}`,
          location: sellerPickupLocation,
          timestamp: new Date().toISOString(),
          updatedBy: "Shiprocket API"
        },
        {
          title: `AWB ${awbResult.awbCode} Assigned`,
          description: `Courier: ${awbResult.courierName}`,
          location: sellerPickupLocation,
          timestamp: new Date().toISOString(),
          updatedBy: "Shiprocket API"
        },
        {
          title: "Pickup Request Generated",
          description: pickupResult.message,
          location: sellerPickupLocation,
          timestamp: new Date().toISOString(),
          updatedBy: "Shiprocket API"
        }
      ]
    };

    return {
      success: true,
      message: `Shipment booked via Shiprocket! AWB ${awbResult.awbCode} assigned via ${awbResult.courierName}. Pickup from: ${sellerPickupLocation}`,
      orderId,
      shipment: shipmentData
    };
  } catch (err) {
    console.error("❌ [SHIPROCKET] Full shipment flow failed:", err.message);
    throw new Error(`Shiprocket shipment creation failed: ${err.message}`);
  }
};

// ─── 3. Live AWB Tracking ────────────────────────────────────────────────────
export const getLiveAwbTrackingService = async (awbNumber) => {
  if (!awbNumber) {
    return { success: false, message: "AWB number is required for tracking." };
  }

  const cleanAwb = String(awbNumber).trim();
  const upperAwb = cleanAwb.toUpperCase();

  // First try to find order in DB
  let matchedOrder = null;
  try {
    matchedOrder = await Order.findOne({
      $or: [
        { trackingNumber: cleanAwb },
        { trackingNumber: upperAwb },
        { orderId: cleanAwb },
        { id: cleanAwb },
        { "selfDeliveryDetails.deliveryPartnerToken": cleanAwb },
        { "items.thirdPartyDetails.trackingNumber": cleanAwb },
        { "items.selfDeliveryDetails.deliveryPartnerToken": cleanAwb }
      ]
    }).populate("items.sellerId", "storeName name phone email address city");
  } catch (err) {}

  // Try real Shiprocket tracking
  try {
    const trackResult = await trackShiprocketAwb(cleanAwb);

    if (trackResult.success) {
      return {
        success: true,
        awbNumber: cleanAwb,
        orderId: matchedOrder?.orderId || matchedOrder?.id || null,
        deliveryMode: "third_party",
        courierPartnerName: trackResult.courierName || "Shiprocket",
        currentStatus: trackResult.currentStatus || "shipped",
        currentStatusLabel: trackResult.currentStatusLabel || "",
        estimatedDeliveryDate: trackResult.estimatedDeliveryDate || new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        trackingUrl: `https://shiprocket.co/tracking/${cleanAwb}`,
        sellerDetails: matchedOrder?.sellerDetails || null,
        checkpoints: trackResult.checkpoints
      };
    }
  } catch (err) {
    console.warn("⚠️ [SHIPROCKET] Live tracking failed, falling back to DB data:", err.message);
  }

  // Fallback: use DB order timeline if Shiprocket tracking fails
  if (matchedOrder) {
    const isSelf = matchedOrder.deliveryMode === "self_delivery" || Boolean(matchedOrder.selfDeliveryDetails?.deliveryPartnerToken);
    const courier = matchedOrder.courierName || "Courier Partner";

    let trackingUrl = matchedOrder.trackingUrl || `https://shiprocket.co/tracking/${cleanAwb}`;

    const checkpoints = (matchedOrder.timeline?.length > 0)
      ? matchedOrder.timeline.map((evt) => ({
          status: evt.status,
          title: evt.title,
          description: evt.description,
          location: evt.location || "Hub",
          timestamp: evt.timestamp
        }))
      : [
          { status: "placed", title: "Order Placed", description: "Order received and confirmed", location: "BookVardi Hub", timestamp: matchedOrder.createdAt },
          { status: "shipped", title: "Dispatched", description: "Package handed to courier", location: "Seller Warehouse", timestamp: new Date().toISOString() }
        ];

    return {
      success: true,
      awbNumber: cleanAwb,
      orderId: matchedOrder.orderId || matchedOrder.id,
      deliveryMode: isSelf ? "self_delivery" : "third_party",
      courierPartnerName: isSelf ? "BookVardi Self-Delivery" : courier,
      currentStatus: matchedOrder.overallStatus || matchedOrder.status || "shipped",
      estimatedDeliveryDate: matchedOrder.estimatedDeliveryDate || new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      trackingUrl,
      sellerDetails: matchedOrder.sellerDetails || null,
      selfDeliveryDetails: matchedOrder.selfDeliveryDetails || null,
      checkpoints
    };
  }

  return {
    success: false,
    message: `No tracking information found for AWB ${cleanAwb}. Please check the AWB number and try again.`
  };
};

// ─── 4. Cancel Shipment via Shiprocket ───────────────────────────────────────
export const cancelShipmentService = async (shiprocketOrderIds = []) => {
  if (!shiprocketOrderIds.length) return { success: false, message: "No Shiprocket order IDs provided" };
  return await cancelShiprocketOrder(shiprocketOrderIds);
};
