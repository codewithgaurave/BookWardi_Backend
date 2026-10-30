import axios from "axios";

const SHIPROCKET_BASE_URL = "https://apiv2.shiprocket.in/v1/external";

// ─── Token Cache (24hr valid) ───────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = null;

const getAuthToken = async () => {
  const now = Date.now();

  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && tokenExpiresAt && now < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const email = process.env.SHIPROCKET_API_EMAIL;
  const password = process.env.SHIPROCKET_API_PASSWORD;

  if (!email || !password) {
    throw new Error("Shiprocket credentials missing in .env (SHIPROCKET_API_EMAIL / SHIPROCKET_API_PASSWORD)");
  }

  const res = await axios.post(`${SHIPROCKET_BASE_URL}/auth/login`, { email, password });

  if (!res.data?.token) {
    throw new Error("Shiprocket login failed — no token received");
  }

  cachedToken = res.data.token;
  tokenExpiresAt = now + 24 * 60 * 60 * 1000; // 24 hours

  console.log("✅ [SHIPROCKET] Auth token refreshed successfully");
  return cachedToken;
};

// ─── Axios instance with auto auth header ───────────────────────────────────
const shiprocketApi = async () => {
  const token = await getAuthToken();
  return axios.create({
    baseURL: SHIPROCKET_BASE_URL,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    timeout: 15000
  });
};

// ─── 1. Check Serviceability & Courier Rates ────────────────────────────────
export const checkShiprocketServiceability = async ({ pickupPincode, deliveryPincode, weightKg = 1, isCod = false, codAmount = 0 }) => {
  try {
    const api = await shiprocketApi();

    const params = {
      pickup_postcode: String(pickupPincode || process.env.SHIPROCKET_PICKUP_PINCODE || "226001"),
      delivery_postcode: String(deliveryPincode),
      weight: Number(weightKg) || 1,
      cod: isCod ? 1 : 0
    };

    if (isCod && codAmount > 0) params.declared_value = codAmount;

    const res = await api.get("/courier/serviceability", { params });

    const couriers = res.data?.data?.available_courier_companies || [];

    if (!couriers.length) {
      return { success: false, message: "No courier partners available for this route.", availablePartners: [] };
    }

    const partners = couriers.map((c) => ({
      courierId: c.courier_company_id,
      name: c.courier_name,
      code: c.courier_name?.toUpperCase().replace(/\s+/g, "_"),
      estimatedRate: Math.round(Number(c.rate || c.freight_charge || 0)),
      estimatedDays: c.estimated_delivery_days ? `${c.estimated_delivery_days} Days` : "3-5 Days",
      codAvailable: Boolean(c.cod),
      isDefault: Boolean(c.is_recommended),
      serviceable: true,
      minWeight: c.min_weight || 0.5,
      maxWeight: c.max_weight || 10
    }));

    // Sort by rate ascending
    partners.sort((a, b) => a.estimatedRate - b.estimatedRate);

    const recommended = partners.find((p) => p.isDefault) || partners[0];

    return {
      success: true,
      pickupPincode: params.pickup_postcode,
      deliveryPincode: String(deliveryPincode),
      weightKg: Number(weightKg),
      recommendedPartner: recommended,
      availablePartners: partners
    };
  } catch (err) {
    console.error("❌ [SHIPROCKET] Serviceability check failed:", err?.response?.data || err.message);
    throw new Error(err?.response?.data?.message || err.message || "Shiprocket serviceability check failed");
  }
};

// ─── 2. Create Shiprocket Order ──────────────────────────────────────────────
export const createShiprocketOrder = async (order, weightKg = 1, dimensions = {}) => {
  try {
    const api = await shiprocketApi();

    const channelId = process.env.SHIPROCKET_CHANNEL_ID;
    const pickupLocation = order._resolvedPickupLocation || process.env.SHIPROCKET_PICKUP_LOCATION || "warehouse";

    if (!channelId) throw new Error("SHIPROCKET_CHANNEL_ID missing in .env");

    const customer = order.customer || {};
    const address = order.shippingAddress || {};
    const items = order.items || [];

    // Map payment method
    const rawMethod = String(order.paymentMethod || "").toLowerCase();
    const isCod = rawMethod.includes("cod") || rawMethod.includes("cash");
    const paymentMethod = isCod ? "COD" : "Prepaid";

    // Build order items array
    const orderItems = items.map((item) => ({
      name: String(item.name || "Product").slice(0, 100),
      sku: String(item.productId || item.id || item._id || "SKU001"),
      units: Number(item.quantity || 1),
      selling_price: Number(item.finalPrice || item.price || 0),
      discount: Number(item.offerDiscount || 0),
      tax: Number(item.gstPercent || item.gst || 0),
      hsn: ""
    }));

    const payload = {
      order_id: String(order.orderId || order.id),
      order_date: new Date(order.createdAt || Date.now()).toISOString().slice(0, 19),
      pickup_location: pickupLocation,
      channel_id: Number(channelId),
      comment: `BookVardi Order #${order.orderId || order.id}`,

      // Billing — same as shipping (no billing changes as requested)
      billing_customer_name: String(customer.name || address.name || "Customer"),
      billing_last_name: "",
      billing_address: String(address.street || address.addressLine1 || address.address || ""),
      billing_address_2: String(address.addressLine2 || address.landmark || ""),
      billing_city: String(address.city || address.town || ""),
      billing_pincode: String(address.pincode || address.zip || ""),
      billing_state: String(address.state || ""),
      billing_country: "India",
      billing_email: String(customer.email || ""),
      billing_phone: String(customer.phone || address.phone || "").replace(/\D/g, "").slice(-10),
      billing_alternate_phone: "",

      // Shipping — same as billing
      shipping_is_billing: true,

      // Order items
      order_items: orderItems,

      // Payment
      payment_method: paymentMethod,
      shipping_charges: Number(order.shippingFee || order.shippingCost || 0),
      giftwrap_charges: 0,
      transaction_charges: 0,
      total_discount: Number(order.discount || order.discountAmount || 0),
      sub_total: Number(order.totalAmount || order.total || 0),
      length: Number(dimensions.length) || 20,
      breadth: Number(dimensions.width) || 15,
      height: Number(dimensions.height) || 10,
      weight: Number(weightKg) || 1
    };

    // Add COD amount if applicable
    if (isCod) {
      payload.cod_amount = Number(order.totalAmount || order.total || 0);
    }

    const res = await api.post("/orders/create/adhoc", payload);

    if (!res.data?.order_id && !res.data?.shipment_id) {
      throw new Error(res.data?.message || "Shiprocket order creation failed — no order_id returned");
    }

    console.log(`✅ [SHIPROCKET] Order created — SR Order ID: ${res.data.order_id}, Shipment ID: ${res.data.shipment_id}`);

    return {
      success: true,
      shiprocketOrderId: res.data.order_id,
      shipmentId: res.data.shipment_id,
      status: res.data.status,
      statusCode: res.data.status_code,
      channelOrderId: res.data.channel_order_id,
      raw: res.data
    };
  } catch (err) {
    console.error("❌ [SHIPROCKET] Order creation failed:", err?.response?.data || err.message);
    throw new Error(err?.response?.data?.message || err.message || "Shiprocket order creation failed");
  }
};

// ─── 3. Assign AWB to Shipment ───────────────────────────────────────────────
export const assignShiprocketAwb = async (shipmentId, courierId = null) => {
  try {
    const api = await shiprocketApi();

    const payload = { shipment_id: [Number(shipmentId)] };
    if (courierId) payload.courier_id = Number(courierId);

    const res = await api.post("/courier/assign/awb", payload);

    const awbData = res.data?.response?.data;

    if (!awbData?.awb_code) {
      throw new Error(res.data?.response?.data?.awb_assign_error || "AWB assignment failed — no AWB code returned");
    }

    console.log(`✅ [SHIPROCKET] AWB assigned: ${awbData.awb_code} via ${awbData.courier_name}`);

    return {
      success: true,
      awbCode: awbData.awb_code,
      courierName: awbData.courier_name,
      courierId: awbData.courier_company_id,
      shipmentId: awbData.shipment_id,
      assignedAt: new Date().toISOString()
    };
  } catch (err) {
    console.error("❌ [SHIPROCKET] AWB assignment failed:", err?.response?.data || err.message);
    throw new Error(err?.response?.data?.message || err.message || "Shiprocket AWB assignment failed");
  }
};

// ─── 4. Generate Pickup Request ──────────────────────────────────────────────
export const generateShiprocketPickup = async (shipmentId) => {
  try {
    const api = await shiprocketApi();

    const res = await api.post("/courier/generate/pickup", {
      shipment_id: [Number(shipmentId)]
    });

    const pickupData = res.data?.response?.pickup_scheduled_date || res.data?.pickup_scheduled_date;

    console.log(`✅ [SHIPROCKET] Pickup scheduled for shipment ${shipmentId}: ${pickupData}`);

    return {
      success: true,
      pickupScheduledDate: pickupData || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      message: res.data?.response?.message || "Pickup request generated successfully"
    };
  } catch (err) {
    console.error("❌ [SHIPROCKET] Pickup generation failed:", err?.response?.data || err.message);
    // Non-fatal — AWB is already assigned, pickup can be retried
    return {
      success: false,
      pickupScheduledDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      message: err?.response?.data?.message || "Pickup scheduling failed — please retry from dashboard"
    };
  }
};

// ─── 5. Track Shipment by AWB ────────────────────────────────────────────────
export const trackShiprocketAwb = async (awbCode) => {
  try {
    const api = await shiprocketApi();

    const res = await api.get(`/courier/track/awb/${awbCode}`);

    const trackData = res.data?.tracking_data;

    if (!trackData) {
      return { success: false, message: "No tracking data found for this AWB" };
    }

    const shipmentTrack = trackData.shipment_track?.[0] || {};
    const trackActivities = trackData.shipment_track_activities || [];

    // Map Shiprocket activities to our checkpoint format
    const checkpoints = trackActivities.map((act) => ({
      status: mapShiprocketStatus(act["sr-status"] || act.status || ""),
      title: act.activity || act["sr-status-label"] || "Update",
      description: act.activity || "",
      location: act.location || "",
      timestamp: act.date || new Date().toISOString()
    }));

    return {
      success: true,
      awbNumber: awbCode,
      courierName: shipmentTrack.courier_name || "",
      currentStatus: mapShiprocketStatus(shipmentTrack["current-status"] || shipmentTrack.status || ""),
      currentStatusLabel: shipmentTrack["current-status"] || "",
      estimatedDeliveryDate: shipmentTrack.etd || null,
      trackingUrl: `https://track.shiprocket.in/tracking/${awbCode}`,
      checkpoints: checkpoints.length > 0 ? checkpoints : [
        {
          status: "shipped",
          title: "Shipment Dispatched",
          description: `AWB ${awbCode} assigned and shipment dispatched`,
          location: "",
          timestamp: new Date().toISOString()
        }
      ]
    };
  } catch (err) {
    console.error("❌ [SHIPROCKET] Tracking failed:", err?.response?.data || err.message);
    throw new Error(err?.response?.data?.message || err.message || "Shiprocket tracking failed");
  }
};

// ─── 6. Cancel Shiprocket Order ──────────────────────────────────────────────
export const cancelShiprocketOrder = async (shiprocketOrderIds = []) => {
  try {
    const api = await shiprocketApi();

    const res = await api.post("/orders/cancel", {
      ids: shiprocketOrderIds.map(Number)
    });

    console.log(`✅ [SHIPROCKET] Orders cancelled:`, shiprocketOrderIds);

    return {
      success: true,
      message: res.data?.message || "Shiprocket order(s) cancelled successfully"
    };
  } catch (err) {
    console.error("❌ [SHIPROCKET] Cancel failed:", err?.response?.data || err.message);
    throw new Error(err?.response?.data?.message || err.message || "Shiprocket order cancellation failed");
  }
};

// ─── 7. Get Shipping Label URL ───────────────────────────────────────────────
export const getShiprocketLabel = async (shipmentId) => {
  try {
    const api = await shiprocketApi();

    const res = await api.post("/orders/print/label", {
      shipment_id: [Number(shipmentId)]
    });

    const labelUrl = res.data?.label_url || res.data?.response?.label_url || "";

    return {
      success: Boolean(labelUrl),
      labelUrl,
      message: labelUrl ? "Label generated" : "Label not yet ready — try after pickup is scheduled"
    };
  } catch (err) {
    console.error("❌ [SHIPROCKET] Label fetch failed:", err?.response?.data || err.message);
    return { success: false, labelUrl: "", message: "Label generation failed" };
  }
};

// ─── 8. Register Seller Pickup Address on Shiprocket ───────────────────────
export const registerSellerPickupAddress = async (seller) => {
  try {
    const api = await shiprocketApi();

    const name = String(seller.storeName || seller.name || "Seller Store").trim();
    const phone = String(seller.phone || "").replace(/\D/g, "").slice(-10);
    const address = String(seller.address || seller.addressDetails?.addressLine1 || "").trim();
    const city = String(seller.city || "").trim();
    const state = String(seller.state || "Uttar Pradesh").trim();
    const pincode = String(seller.pincode || "").trim();
    const email = String(seller.email || "").trim();

    if (!phone || !address || !pincode || !city) {
      throw new Error(`Seller missing required fields for Shiprocket pickup registration: phone=${phone}, address=${address}, pincode=${pincode}, city=${city}`);
    }

    // Shiprocket pickup location name must be unique — use storeName + pincode
    const locationName = `${name} ${pincode}`.slice(0, 50).trim();

    const payload = {
      pickup_location: locationName,
      name: name.slice(0, 50),
      email: email || `seller${phone}@bookvardi.com`,
      phone: phone,
      address: address.slice(0, 100),
      address_2: String(seller.addressDetails?.addressLine2 || seller.addressDetails?.landmark || "").slice(0, 100),
      city: city,
      state: state,
      country: "India",
      pin_code: pincode
    };

    const res = await api.post("/settings/company/addpickup", payload);

    if (res.data?.success || res.data?.data?.pickup_location) {
      const registeredName = res.data?.data?.pickup_location || locationName;
      console.log(`✅ [SHIPROCKET] Pickup address registered for seller ${name}: "${registeredName}"`);
      return { success: true, pickupLocationName: registeredName };
    }

    // If already exists, Shiprocket returns error — treat as success
    const errMsg = String(res.data?.message || "").toLowerCase();
    if (errMsg.includes("already") || errMsg.includes("exist")) {
      console.log(`✅ [SHIPROCKET] Pickup address already exists for seller ${name}: "${locationName}"`);
      return { success: true, pickupLocationName: locationName };
    }

    throw new Error(res.data?.message || "Pickup address registration failed");
  } catch (err) {
    // If already exists error in catch
    const errMsg = String(err?.response?.data?.message || err.message || "").toLowerCase();
    if (errMsg.includes("already") || errMsg.includes("exist")) {
      const locationName = `${String(seller.storeName || seller.name || "Seller").trim()} ${String(seller.pincode || "").trim()}`.slice(0, 50).trim();
      console.log(`✅ [SHIPROCKET] Pickup address already registered for seller: "${locationName}"`);
      return { success: true, pickupLocationName: locationName };
    }
    console.error("❌ [SHIPROCKET] Pickup address registration failed:", err?.response?.data || err.message);
    return { success: false, error: err?.response?.data?.message || err.message };
  }
};

// ─── Helper: Map Shiprocket status to our internal status ───────────────────
const mapShiprocketStatus = (srStatus = "") => {
  const s = String(srStatus).toLowerCase();
  if (s.includes("delivered")) return "delivered";
  if (s.includes("out for delivery") || s.includes("ofd")) return "out_for_delivery";
  if (s.includes("in transit") || s.includes("transit")) return "in_transit";
  if (s.includes("picked up") || s.includes("pickup")) return "picked_up";
  if (s.includes("cancelled") || s.includes("canceled")) return "cancelled";
  if (s.includes("rto")) return "rto";
  if (s.includes("lost")) return "lost";
  if (s.includes("undelivered") || s.includes("ndr")) return "undelivered";
  if (s.includes("booked") || s.includes("awb")) return "shipped";
  return "shipped";
};
