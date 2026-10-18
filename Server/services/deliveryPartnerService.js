import DeliveryPartnerConfig from "../models/DeliveryPartnerConfig.js";
import Order, { generateProductOrderId } from "../models/Order.js";

// Helper to get or initialize logistics configuration
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
          avgDays: "2-3 Days",
          baseRate: 45,
          perKgRate: 20,
          sandboxMode: true
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
          sandboxMode: true
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
          sandboxMode: true
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
          sandboxMode: true
        }
      ]
    });
    await config.save();
  }
  return config;
};

// 1. Serviceability & Courier Rate Calculation API
export const checkServiceabilityService = async ({ pickupPincode = "226001", deliveryPincode, weightKg = 1, isCod = false }) => {
  const config = await getOrInitDeliveryConfig();
  const dest = String(deliveryPincode || "110001").trim();
  const weight = Math.max(0.5, Number(weightKg) || 1);

  // Region tier logic for rate estimation
  const isMetro = dest.startsWith("11") || dest.startsWith("40") || dest.startsWith("56") || dest.startsWith("70") || dest.startsWith("60") || dest.startsWith("50");
  const isLocalState = dest.startsWith("22") || dest.startsWith("20") || dest.startsWith("26");

  const results = config.partners.map((partner) => {
    let multiplier = isLocalState ? 1.0 : isMetro ? 1.25 : 1.5;
    if (partner.code === "BLUEDART") multiplier *= 1.3;
    if (partner.code === "LOCAL_EXPRESS") multiplier = isLocalState ? 0.8 : 2.0;

    const baseCost = partner.baseRate * multiplier;
    const additionalWeightCost = Math.max(0, weight - 1) * partner.perKgRate;
    const codCharge = isCod ? config.baseCodFee : 0;
    const calculatedRate = Math.round(baseCost + additionalWeightCost + codCharge);

    const slaDays = partner.code === "LOCAL_EXPRESS"
      ? (isLocalState ? "Same Day (Within 24 hrs)" : "2-3 Days")
      : partner.code === "BLUEDART"
      ? (isMetro ? "1-2 Business Days" : "2 Days")
      : partner.code === "DELHIVERY"
      ? "2-3 Business Days"
      : "2-4 Business Days";

    return {
      partnerId: partner.partnerId,
      name: partner.name,
      code: partner.code,
      active: partner.active,
      isDefault: partner.isDefault,
      serviceable: partner.active,
      estimatedRate: calculatedRate,
      estimatedDays: slaDays,
      codAvailable: true,
      pickupPincode,
      deliveryPincode: dest
    };
  });

  return {
    success: true,
    pickupPincode,
    deliveryPincode: dest,
    weightKg: weight,
    recommendedPartner: results.find((r) => r.isDefault) || results[0],
    availablePartners: results.filter((r) => r.active)
  };
};

// 2. Automated AWB Generation & Shipment Dispatch Service
export const generateShipmentAwbService = async (orderData, courierCode = "SHIPROCKET", weightKg = 1, dimensions = {}) => {
  const config = await getOrInitDeliveryConfig();
  const selectedPartner = config.partners.find((p) => p.code === courierCode || p.partnerId === courierCode) || config.partners[0];

  const orderId = orderData.orderId || orderData.id || generateProductOrderId();
  const cleanCode = selectedPartner.code;
  const uniqueAwb = `${cleanCode.slice(0, 3)}-${Date.now().toString().slice(-6)}${Math.floor(10 + Math.random() * 90)}`;
  const pickupToken = `PKP-${Math.floor(100000 + Math.random() * 900000)}`;
  const shippingLabelUrl = `/invoices/shipping-label-${uniqueAwb}.pdf`;

  const weight = Number(weightKg) || 1;

  const shipmentData = {
    awbNumber: uniqueAwb,
    courierPartnerId: selectedPartner.partnerId,
    courierPartnerName: selectedPartner.name,
    courierPartnerCode: selectedPartner.code,
    shippingLabelUrl,
    manifestUrl: `/invoices/manifest-${uniqueAwb}.pdf`,
    pickupToken,
    status: "booked",
    weightKg: weight,
    dimensions: {
      length: Number(dimensions.length) || 20,
      width: Number(dimensions.width) || 15,
      height: Number(dimensions.height) || 10
    },
    pickupScheduledDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    estimatedDeliveryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    courierLogs: [
      {
        title: "Shipment Created & AWB Generated",
        description: `AWB ${uniqueAwb} assigned via ${selectedPartner.name}`,
        location: "Seller Warehouse",
        timestamp: new Date().toISOString(),
        updatedBy: "System Logistics"
      },
      {
        title: "Courier Pickup Manifest Scheduled",
        description: `Pickup Token ${pickupToken} generated for courier agent dispatch`,
        location: "Seller Warehouse",
        timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        updatedBy: selectedPartner.name
      }
    ]
  };

  return {
    success: true,
    message: `Shipment booked successfully! AWB ${uniqueAwb} assigned via ${selectedPartner.name}`,
    orderId,
    shipment: shipmentData
  };
};

// 3. Live AWB Tracking Checkpoints Engine
export const getLiveAwbTrackingService = async (awbNumber) => {
  if (!awbNumber) {
    return { success: false, message: "AWB number is required for tracking." };
  }

  const cleanAwb = String(awbNumber).trim();
  const upperAwb = cleanAwb.toUpperCase();

  // Try to find matching Order in MongoDB
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

  if (matchedOrder) {
    const isSelf = matchedOrder.deliveryMode === "self_delivery" || Boolean(matchedOrder.selfDeliveryDetails?.deliveryPartnerToken);
    const courier = matchedOrder.courierName || "Courier Partner";
    let realTrackingUrl = matchedOrder.trackingUrl || "";

    if (!realTrackingUrl) {
      if (isSelf) {
        realTrackingUrl = matchedOrder.selfDeliveryDetails?.trackingUrl || `/#delivery-partner?token=${encodeURIComponent(matchedOrder.selfDeliveryDetails?.deliveryPartnerToken || cleanAwb)}`;
      } else {
        const cLower = courier.toLowerCase();
        if (cLower.includes("delhivery")) realTrackingUrl = `https://www.delhivery.com/track/package/${cleanAwb}`;
        else if (cLower.includes("bluedart") || cLower.includes("blue dart")) realTrackingUrl = `https://www.bluedart.com/tracking?awb=${cleanAwb}`;
        else if (cLower.includes("dtdc")) realTrackingUrl = `https://www.dtdc.in/tracking/shipment-tracking.asp?awb=${cleanAwb}`;
        else if (cLower.includes("ekart")) realTrackingUrl = `https://ekartlogistics.com/shipmenttrack/${cleanAwb}`;
        else if (cLower.includes("indiapost") || cLower.includes("speedpost")) realTrackingUrl = `https://www.indiapost.gov.in/_layouts/15/dpt.cept.tracking/trackconsignment.aspx`;
        else realTrackingUrl = `https://track.shiprocket.in/tracking/${cleanAwb}`;
      }
    }

    const checkpoints = (matchedOrder.timeline && matchedOrder.timeline.length > 0)
      ? matchedOrder.timeline.map((evt) => ({
          status: evt.status,
          title: evt.title,
          description: evt.description,
          location: evt.location || (isSelf ? (matchedOrder.sellerDetails?.storeName || "Store Dispatch") : "Regional Hub"),
          timestamp: evt.timestamp
        }))
      : [
          { status: "placed", title: "Order Placed", description: "Order received and confirmed", location: "Store Hub", timestamp: matchedOrder.createdAt || new Date().toISOString() },
          { status: "processing", title: "Processing & Packed", description: "Satchel sealed ready for dispatch", location: matchedOrder.sellerDetails?.storeName || "Merchant Store", timestamp: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() }
        ];

    return {
      success: true,
      awbNumber: cleanAwb,
      orderId: matchedOrder.orderId || matchedOrder.id,
      deliveryMode: isSelf ? "self_delivery" : "third_party",
      courierPartnerName: isSelf ? (matchedOrder.sellerDetails?.storeName ? `${matchedOrder.sellerDetails.storeName} Self-Delivery` : "Direct Store Self-Delivery") : courier,
      currentStatus: matchedOrder.overallStatus || matchedOrder.status || "shipped",
      estimatedDeliveryDate: matchedOrder.estimatedDeliveryDate || new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      trackingUrl: realTrackingUrl,
      sellerDetails: matchedOrder.sellerDetails || null,
      selfDeliveryDetails: matchedOrder.selfDeliveryDetails || null,
      checkpoints
    };
  }

  // Fallback for simulation / mock AWB
  const courierPrefix = upperAwb.split("-")[0] || "SHIP";
  const partnerNameMap = {
    DELH: "Delhivery Direct Express",
    BLUE: "BlueDart Air Priority",
    DTDC: "DTDC Express Courier",
    EKAR: "Ekart Logistics",
    POST: "India Post SpeedPost",
    LOCA: "BookVardi Local Express"
  };

  const partnerName = partnerNameMap[courierPrefix] || "Express Courier Network";
  let fallbackUrl = `https://track.shiprocket.in/tracking/${cleanAwb}`;
  if (courierPrefix === "DELH") fallbackUrl = `https://www.delhivery.com/track/package/${cleanAwb}`;
  else if (courierPrefix === "BLUE") fallbackUrl = `https://www.bluedart.com/tracking?awb=${cleanAwb}`;
  else if (courierPrefix === "DTDC") fallbackUrl = `https://www.dtdc.in/tracking/shipment-tracking.asp?awb=${cleanAwb}`;
  else if (courierPrefix === "EKAR") fallbackUrl = `https://ekartlogistics.com/shipmenttrack/${cleanAwb}`;

  const checkpoints = [
    {
      status: "placed",
      title: "Order Placed & Confirmed",
      description: "Customer order confirmed by marketplace",
      location: "BookVardi Hub",
      timestamp: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
    },
    {
      status: "packed",
      title: "Items Packed & Manifested",
      description: "Packed into protective security satchel",
      location: "Seller Fulfillment Warehouse",
      timestamp: new Date(Date.now() - 28 * 60 * 60 * 1000).toISOString()
    },
    {
      status: "awb_generated",
      title: `AWB ${cleanAwb} Assigned`,
      description: `Dispatched to ${partnerName}`,
      location: "Origin Logistics Hub",
      timestamp: new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString()
    },
    {
      status: "in_transit",
      title: "In Transit at Sorting Facility",
      description: "Package sorted & routed to destination regional gateway",
      location: "Central Transshipment Hub",
      timestamp: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString()
    },
    {
      status: "out_for_delivery",
      title: "Out for Delivery",
      description: "Delivery executive on the way to address",
      location: "Destination Delivery Hub",
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    }
  ];

  return {
    success: true,
    awbNumber: cleanAwb,
    deliveryMode: "third_party",
    courierPartnerName: partnerName,
    currentStatus: "out_for_delivery",
    estimatedDeliveryDate: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    trackingUrl: fallbackUrl,
    checkpoints
  };
};
