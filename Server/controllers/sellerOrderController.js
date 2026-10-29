import mongoose from "mongoose";
import Order, { generateProductOrderId } from "../models/Order.js";
import Product from "../models/Product.js";
import Seller from "../models/Seller.js";
import User from "../models/User.js";
import { enrichOrdersWithSellerAndConsumer, findOrderById, calculateOverallOrderStatus, STAGE_RANK, invalidateOrdersCache } from "./orderController.js";
import { sendDeliveryPartnerWhatsAppDispatch } from "../services/whatsappService.js";
import { broadcastRealtimeEvent } from "../services/realtimeService.js";
import { calculateSellerSettlement } from "../services/settlementService.js";
import { sendOrderStatusSms } from "../services/smsService.js";
import { getSellerInvoicePrefix, formatSellerInvoiceNumber } from "../utils/invoiceHelper.js";

// Global in-memory cache for ultra-fast seller orders
const sellerOrdersCache = new Map(); // sellerKey -> { data, timestamp }
const sellerScopeCache = new Map(); // sellerKey -> { scope, timestamp }
const SELLER_CACHE_TTL = 3 * 1000;

export const invalidateSellerOrdersCache = () => {
  sellerOrdersCache.clear();
};
global.__invalidateSellerOrdersCache = invalidateSellerOrdersCache;

// Canonical Order Status Normalizer
export const normalizeOrderStatus = (raw, contextOrder = null) => {
  if (!raw) return "Pending";
  const s = String(raw).toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (s === "delivered" || s === "completed") return "Delivered";
  if (s === "out_for_delivery") return "Out for Delivery";
  if (s === "shipped" || s === "in_transit") return "Shipped";
  if (s === "packed") return "Packed";
  if (s === "confirmed") return "Confirmed";
  if (s === "processing") return "Processing";
  if (s === "cancelled" || s === "canceled") return "Cancelled";
  if (s === "return_requested") return "Return Requested";
  if (s === "return_approved") return "Return Approved";
  if (s === "return_rejected") return "Return Rejected";
  if (s === "exchange_requested") return "Exchange Requested";
  if (s === "exchange_approved") return "Exchange Approved";
  if (s === "exchange_rejected") return "Exchange Rejected";
  if (s === "pickup_scheduled") return "Pickup Scheduled";
  if (s === "product_return_received" || s === "product_received") return "Product Received";
  if (s === "refund_requested") return "Refund Requested";
  if (s === "refund_approved") return "Refund Approved";
  if (s === "refund_initiated") return "Refund Initiated";
  if (s === "refund_completed" || s === "refunded") return "Refund Completed";
  if (s === "exchange_dispatched") return "Exchange Dispatched";
  if (s === "exchanged") return "Exchanged";
  if (s === "requested") {
    const isEx = contextOrder?.returnRequest?.type === 'exchange';
    return isEx ? "Exchange Requested" : "Return Requested";
  }
  if (s === "approved") {
    const isEx = contextOrder?.returnRequest?.type === 'exchange';
    return isEx ? "Exchange Approved" : "Return Approved";
  }
  if (s === "rejected") {
    const isEx = contextOrder?.returnRequest?.type === 'exchange';
    return isEx ? "Exchange Rejected" : "Return Rejected";
  }
  if (s === "pending" || s === "placed") return "Pending";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

// Use the configured frontend app base URL so delivery links work on local and deployed hosts.
const frontendBaseUrl = process.env.CLIENT_URL || process.env.FRONTEND_BASE_URL || "http://localhost:5173";

// Helper to extract authenticated seller ID
const resolveSellerId = (req) => {
  const id = req.user?.id || req.seller?._id || req.seller?.id || req.user?._id || req.user?.phone || req.headers?.["x-seller-id"] || req.query?.sellerId || null;
  if (!id || id === "undefined" || id === "null" || id === "[object Object]") return null;
  return id;
};

// Helper to expand seller scope across Seller/User collections, products, and regex names
const getExpandedSellerScope = async (req) => {
  try {
    const primaryId = resolveSellerId(req);
    const now = Date.now();
    if (primaryId && sellerScopeCache.has(primaryId)) {
      const cached = sellerScopeCache.get(primaryId);
      if (now - cached.timestamp < 60 * 1000) {
        return cached.scope;
      }
    }
    const rawIds = [
      primaryId,
      req.user?.id,
      req.seller?._id,
      req.seller?.id,
      req.user?._id,
      req.user?.phone,
      req.seller?.phone,
      req.headers?.["x-seller-id"],
      req.headers?.["x-user-phone"],
      req.query?.sellerId
    ].filter(id => id && id !== "undefined" && id !== "null" && id !== "[object Object]");

    const sellerSet = new Set();
    rawIds.forEach((id) => {
      sellerSet.add(String(id));
      if (mongoose.Types.ObjectId.isValid(id)) {
        sellerSet.add(new mongoose.Types.ObjectId(id));
      }
    });

    const validObjectIds = rawIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const phoneList = rawIds.map((id) => String(id).replace(/\D/g, "")).filter((p) => p.length >= 8);
    const phoneVariants = phoneList.flatMap((p) => {
      const digits10 = p.slice(-10);
      return [p, digits10, `+91${digits10}`, `+91 ${digits10}`];
    });

    const orConditions = [
      ...(validObjectIds.length > 0 ? [{ _id: { $in: validObjectIds } }] : []),
      ...(phoneVariants.length > 0 ? [{ phone: { $in: phoneVariants } }] : [])
    ];

    let primaryScopeStoreName = req.seller?.storeName || req.user?.storeName || "";

    if (orConditions.length > 0) {
      const [sellerDocs, userDocs] = await Promise.all([
        Seller.find({ $or: orConditions }).select("_id phone email storeName legalName").lean(),
        User.find({ $or: orConditions }).select("_id phone email name").lean()
      ]);

      sellerDocs.forEach((doc) => {
        if (doc._id) {
          sellerSet.add(doc._id);
          sellerSet.add(String(doc._id));
        }
        if (doc.storeName) {
          sellerSet.add(doc.storeName);
          if (!primaryScopeStoreName) primaryScopeStoreName = doc.storeName;
        }
        if (doc.legalName) sellerSet.add(doc.legalName);
        if (doc.phone) {
          sellerSet.add(doc.phone);
          const cleanP = String(doc.phone).replace(/\D/g, "");
          if (cleanP) {
            sellerSet.add(cleanP);
            sellerSet.add(cleanP.slice(-10));
            sellerSet.add(`+91${cleanP.slice(-10)}`);
            sellerSet.add(`+91 ${cleanP.slice(-10)}`);
          }
        }
        if (doc.email) sellerSet.add(doc.email);
      });

      userDocs.forEach((doc) => {
        if (doc._id) {
          sellerSet.add(doc._id);
          sellerSet.add(String(doc._id));
        }
        if (doc.name) {
          sellerSet.add(doc.name);
          if (!primaryScopeStoreName) primaryScopeStoreName = `${doc.name}'s Store`;
        }
        if (doc.phone) {
          sellerSet.add(doc.phone);
          const cleanP = String(doc.phone).replace(/\D/g, "");
          if (cleanP) {
            sellerSet.add(cleanP);
            sellerSet.add(cleanP.slice(-10));
            sellerSet.add(`+91${cleanP.slice(-10)}`);
            sellerSet.add(`+91 ${cleanP.slice(-10)}`);
          }
        }
        if (doc.email) sellerSet.add(doc.email);
      });
    }

    const expandedSellerIds = Array.from(sellerSet);
    const strExpandedSellerIds = expandedSellerIds.map(String);
    const validScopeObjectIds = expandedSellerIds
      .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (expandedSellerIds.length === 0) {
      return { expandedSellerIds: [], strExpandedSellerIds: [], allProductKeys: [], productNameRegexes: [], filter: { _id: null } };
    }

    const productOrConditions = [];
    if (validScopeObjectIds.length > 0) {
      productOrConditions.push(
        { sellerId: { $in: validScopeObjectIds } },
        { seller: { $in: validScopeObjectIds } },
        { userId: { $in: validScopeObjectIds } },
        { user: { $in: validScopeObjectIds } },
        { createdBy: { $in: validScopeObjectIds } }
      );
    }
    if (strExpandedSellerIds.length > 0) {
      productOrConditions.push(
        { sellerStoreName: { $in: strExpandedSellerIds } },
        { storeName: { $in: strExpandedSellerIds } },
        { sellerName: { $in: strExpandedSellerIds } }
      );
    }

    const sellerProducts = productOrConditions.length > 0
      ? await Product.find({ $or: productOrConditions }).select("_id id name title").lean()
      : [];

    const productIds = sellerProducts.map((p) => p._id);
    const strProductIds = productIds.map((id) => String(id));
    const customProductIds = sellerProducts.map((p) => p.id).filter(Boolean);
    const numericProductIds = customProductIds.map(Number).filter((n) => !isNaN(n));
    const productNames = sellerProducts.map((p) => (p.name || p.title || "").trim()).filter(Boolean);

    const productNameRegexes = productNames
      .map((name) => (name || "").replace(/\s*\([^)]*\)/g, "").trim())
      .filter((cleanName) => cleanName.length > 0)
      .map((cleanName) => new RegExp(cleanName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

    const allProductKeys = [...new Set([...productIds, ...strProductIds, ...customProductIds, ...numericProductIds])];

    const orderOrConditions = [];
    const combinedSellerKeys = [...new Set([...validScopeObjectIds, ...strExpandedSellerIds])];
    if (combinedSellerKeys.length > 0) {
      orderOrConditions.push(
        { sellerId: { $in: combinedSellerKeys } },
        { seller: { $in: combinedSellerKeys } },
        { "items.sellerId": { $in: combinedSellerKeys } },
        { "items.seller": { $in: combinedSellerKeys } }
      );
    }
    if (strExpandedSellerIds.length > 0) {
      orderOrConditions.push(
        { "items.sellerPhone": { $in: strExpandedSellerIds } },
        { "items.sellerEmail": { $in: strExpandedSellerIds } },
        { "items.storeName": { $in: strExpandedSellerIds } },
        { storeName: { $in: strExpandedSellerIds } },
        { sellerStoreName: { $in: strExpandedSellerIds } }
      );
    }
    if (allProductKeys.length > 0) {
      orderOrConditions.push(
        { "items.productId": { $in: allProductKeys } },
        { "items.id": { $in: allProductKeys } },
        { "items._id": { $in: allProductKeys } }
      );
    }

    const filter = orderOrConditions.length > 0 ? { $or: orderOrConditions } : { _id: null };

    const scopeResult = { expandedSellerIds, strExpandedSellerIds, allProductKeys, productNameRegexes, filter, storeName: primaryScopeStoreName };
    if (primaryId) {
      sellerScopeCache.set(primaryId, { scope: scopeResult, timestamp: now });
    }
    return scopeResult;
  } catch (err) {
    console.error("Error in getExpandedSellerScope:", err);
    return { expandedSellerIds: [], strExpandedSellerIds: [], allProductKeys: [], productNameRegexes: [], filter: { _id: null }, storeName: "" };
  }
};

// Helper to check if a specific order item belongs to the given seller scope
export const isItemBelongingToSellerScope = (item, scope) => {
  if (!item) return false;
  const strExpandedSellerIds = scope?.strExpandedSellerIds || [];
  const strAllProductKeys = scope?.allProductKeys ? scope.allProductKeys.map(String) : [];
  const productNameRegexes = scope?.productNameRegexes || [];
  if (!strExpandedSellerIds || !strExpandedSellerIds.length) return false;

  const itemSellerIdStr = item.sellerId ? String(item.sellerId._id || item.sellerId) : "";
  const itemSellerStr = item.seller ? String(item.seller._id || item.seller) : "";
  const itemStoreNameStr = item.storeName ? String(item.storeName) : "";

  const cleanItemSellerId = itemSellerIdStr.toLowerCase();
  const cleanItemSeller = itemSellerStr.toLowerCase();
  const cleanItemStoreName = itemStoreNameStr.toLowerCase();

  const matchSeller = strExpandedSellerIds.some((sId) => {
    if (!sId) return false;
    const cleanSId = String(sId).toLowerCase();
    return (
      (cleanItemSellerId && (cleanItemSellerId === cleanSId || (cleanSId.length >= 8 && cleanItemSellerId.endsWith(cleanSId.slice(-10))))) ||
      (cleanItemSeller && (cleanItemSeller === cleanSId || (cleanSId.length >= 8 && cleanItemSeller.endsWith(cleanSId.slice(-10))))) ||
      (cleanItemStoreName && cleanItemStoreName === cleanSId)
    );
  });

  const matchProduct = (item.productId || item.id || item._id) && strAllProductKeys.includes(String(item.productId?._id || item.productId || item.id || item._id));
  const matchName = item.name && productNameRegexes.some((regex) => regex.test(item.name));
  return Boolean(matchSeller || matchProduct || matchName);
};

// Helper to strictly strip delivery OTP from seller payloads
export const sanitizeSelfDeliveryForSeller = (details) => {
  if (!details) return null;
  const obj = typeof details.toObject === 'function' ? details.toObject() : { ...details };
  delete obj.deliveryOtp;
  delete obj.otp;
  delete obj.otpLastSentAt;
  return obj;
};

// Helper to format a single Order document for seller view
export const formatSellerSingleOrder = (o, scope = null) => {
  if (!o) return null;
  const customerObj = o.customer || {};
  const itemsList = Array.isArray(o.items) ? o.items : [];
  const strExpandedSellerIds = scope?.strExpandedSellerIds;

  const isOrderBelongingToSeller = Boolean(strExpandedSellerIds && strExpandedSellerIds.some((sId) => {
    if (!sId) return false;
    const cleanSId = String(sId).toLowerCase();
    const ordSellerId = o.sellerId ? String(o.sellerId._id || o.sellerId).toLowerCase() : "";
    const ordStore = (o.storeName || o.sellerStoreName || "").toLowerCase();
    return (
      (ordSellerId && (ordSellerId === cleanSId || (cleanSId.length >= 8 && ordSellerId.endsWith(cleanSId.slice(-10))))) ||
      (ordStore && (ordStore === cleanSId || cleanSId === ordStore))
    );
  }));

  let relevantItems = itemsList.filter((item) => {
    if (!strExpandedSellerIds || !strExpandedSellerIds.length) return true;
    return isItemBelongingToSellerScope(item, scope);
  });

  if (relevantItems.length === 0 && isOrderBelongingToSeller) {
    relevantItems = itemsList;
  }

  if (relevantItems.length === 0 && strExpandedSellerIds && strExpandedSellerIds.length > 0) {
    return null;
  }

  const orderItems = relevantItems.length > 0 ? relevantItems : itemsList;
  const isMultiSeller = itemsList.length > orderItems.length;

  const computedItemsSubtotal = orderItems.reduce(
    (sum, item) => sum + ((Number(item.price) || Number(item.finalPrice) || 0) * Number(item.quantity || 1)),
    0
  );

  const sellerItemsDiscount = orderItems.reduce(
    (sum, item) => sum + (Number(item.offerDiscount || item.discount) || 0),
    0
  );

  const storedOrderTotal = Number(o.totalAmount || o.total || 0);
  const storedSubtotal = Number(o.subtotal || 0);
  const shippingFee = Number(o.shippingFee ?? o.shippingCost ?? 0);
  const discountAmount = Number(o.discountAmount ?? o.discount ?? 0);
  const codFee = Number(o.codFee ?? o.codCharges ?? 0);

  // Compute proportional share for multi-seller orders so Seller Panel matches invoice exactly
  const allItemsSum = itemsList.reduce(
    (sum, item) => sum + ((Number(item.price) || Number(item.finalPrice) || 0) * Number(item.quantity || 1)),
    0
  ) || 1;
  const sellerShare = isMultiSeller ? (computedItemsSubtotal / allItemsSum) : 1;

  const resolvedShipping = isMultiSeller
    ? (shippingFee > 0 ? Math.round(shippingFee * sellerShare * 100) / 100 : 0)
    : shippingFee;

  const allOrderItemsDiscount = itemsList.reduce(
    (sum, item) => sum + (Number(item.offerDiscount || item.discount) || 0),
    0
  );

  const resolvedDiscount = allOrderItemsDiscount > 0
    ? sellerItemsDiscount
    : (isMultiSeller
        ? (discountAmount > 0 ? Math.round(discountAmount * sellerShare * 100) / 100 : 0)
        : discountAmount);

  const resolvedOrderTotal = Math.max(0, Math.round((computedItemsSubtotal + resolvedShipping - resolvedDiscount) * 100) / 100);

  const resolvedSubtotal = computedItemsSubtotal;

  // Compute status strictly from THIS seller's items to prevent other sellers' changes from corrupting this dashboard
  const sellerComputedStatus = relevantItems.length > 0 ? calculateOverallOrderStatus(relevantItems, o) : null;
  const sellerItemStatus = relevantItems.find(i => i.status && normalizeOrderStatus(i.status, o) !== "Pending")?.status;
  const hasActiveReturnRequest = o.returnRequest &&
    typeof o.returnRequest === "object" &&
    Boolean(o.returnRequest.type && !['none', 'n/a', '', 'null'].includes(String(o.returnRequest.type).toLowerCase().trim())) &&
    Boolean(o.returnRequest.status && !['none', 'n/a', 'no_request', 'normal', 'null', ''].includes(String(o.returnRequest.status).toLowerCase().trim()));

  const reqType = String(o.returnRequest?.type || '').toLowerCase();
  const rawStatus = hasActiveReturnRequest
    ? (
        o.returnRequest.status === 'requested'
          ? (reqType === 'exchange' ? 'exchange_requested' : 'return_requested')
          : o.returnRequest.status === 'approved'
          ? (reqType === 'exchange' ? 'exchange_approved' : 'return_approved')
          : o.returnRequest.status === 'rejected'
          ? (reqType === 'exchange' ? 'exchange_rejected' : 'return_rejected')
          : o.returnRequest.status
      )
    : (sellerComputedStatus || sellerItemStatus || o.overallStatus || o.status || "Pending");

  const formattedStatus = normalizeOrderStatus(rawStatus, o);

  let rawOrderId = o.orderId || o.id;
  if (!rawOrderId || /^[0-9a-fA-F]{24}$/.test(rawOrderId)) {
    rawOrderId = generateProductOrderId();
    Order.updateOne({ _id: o._id }, { $set: { orderId: rawOrderId, id: rawOrderId } }).exec().catch(() => {});
  }

  let shippingAddressObj = {};
  if (o.shippingAddress && typeof o.shippingAddress === "object") {
    shippingAddressObj = o.shippingAddress;
  } else if (typeof o.shippingAddress === "string" && o.shippingAddress.trim()) {
    try {
      shippingAddressObj = JSON.parse(o.shippingAddress);
    } catch (e) {
      shippingAddressObj = { street: o.shippingAddress };
    }
  } else if (o.address) {
    shippingAddressObj = typeof o.address === "object" ? o.address : { street: o.address };
  }

  const ordTotalVal = Number(resolvedOrderTotal || o.totalAmount || o.total || 0);
  const sellerStateVal = scope?.state || scope?.storeDetails?.state || o.sellerDetails?.state || orderItems[0]?.sellerDetails?.state || "Uttar Pradesh";
  const customerStateVal = shippingAddressObj?.state || o.shippingAddress?.state || customerObj?.state || "Uttar Pradesh";
  const isCancelledOrder = rawStatus.includes("cancel") || 
                           rawStatus.includes("refund") || 
                           String(o.refundStatus || "").toLowerCase().includes("completed") || 
                           String(o.refundStatus || "").toLowerCase().includes("refunded") || 
                           Boolean(o.cancelledAt) || 
                           o.settlementStatus === "refunded" || 
                           o.settlementStatus === "cancelled";

  const settlementGross = Math.max(0, Math.round((computedItemsSubtotal - resolvedDiscount) * 100) / 100);

  const customerShippingFee = Number(o.shippingFee ?? o.shippingCost ?? o.shippingAmount ?? 0);
  const resolvedBorneBy = o.deliveryChargeBorneBy || (ordTotalVal >= Number(o.freeDeliveryThreshold ?? 401) ? 'admin' : (customerShippingFee > 0 ? 'customer' : 'seller'));

  const sellerGstVal = scope?.gstNumber || o.sellerDetails?.gstNumber || orderItems[0]?.sellerDetails?.gstNumber || "";
  const orderSettlement = calculateSellerSettlement(settlementGross, {
    baseAmount: settlementGross,
    commissionRate: Number(o.commissionRate ?? 10),
    sellerGstNumber: sellerGstVal,
    sellerStoreName: o.sellerStoreName || o.storeName || scope?.storeName || "",
    sellerPhone: scope?.phone || o.sellerPhone || "",
    paymentMethod: o.paymentMethod || "UPI",
    deliveryMode: o.deliveryMode || (o.selfDeliveryDetails?.deliveryPersonName ? "self_delivery" : "third_party"),
    courierName: o.courierName,
    orderTotal: ordTotalVal,
    sellerState: sellerStateVal,
    customerState: customerStateVal,
    deliveryCharge: customerShippingFee || o.deliveryCharge || 49,
    shippingFee: customerShippingFee,
    shippingCost: customerShippingFee,
    codFee: isMultiSeller ? 0 : codFee,
    appliedCodFee: isMultiSeller ? 0 : codFee,
    freeDeliveryThreshold: Number(o.freeDeliveryThreshold ?? 401),
    deliveryChargeBorneBy: resolvedBorneBy,
    isCancelled: isCancelledOrder,
    isRefunded: isCancelledOrder
  });

  return {
    id: rawOrderId,
    _id: o._id,
    orderId: rawOrderId,
    invoiceNumber: o.invoiceNumber || formatSellerInvoiceNumber(getSellerInvoicePrefix(scope?.storeName || o.sellerStoreName), 1),
    sellerInvoiceNo: o.sellerInvoiceNo || o.invoiceNumber || formatSellerInvoiceNumber(getSellerInvoicePrefix(scope?.storeName || o.sellerStoreName), 1),
    sellerSequence: o.sellerSequence || 1,
    customerName: customerObj.name || o.userName || o.customerName || "Customer",
    customerEmail: customerObj.email || o.userEmail || o.customerEmail || "",
    customerPhone: customerObj.phone || o.userPhone || o.customerPhone || "",
    school: o.schoolName || o.school || customerObj.school || "General Public",
    date: o.date
      ? o.date
      : o.createdAt
      ? new Date(o.createdAt).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "Asia/Kolkata"
        })
      : "Recently",
    createdAt: o.createdAt || new Date(),
    total: resolvedOrderTotal,
    totalAmount: resolvedOrderTotal,
    subtotal: resolvedSubtotal,
    sellerSubtotal: computedItemsSubtotal,
    shippingFee: resolvedShipping,
    shippingCost: resolvedShipping,
    discountAmount: resolvedDiscount,
    discount: resolvedDiscount,
    couponCode: (resolvedDiscount > 0 ? (o.couponCode || o.appliedCoupon || "") : ""),
    appliedCoupon: (resolvedDiscount > 0 ? (o.couponCode || o.appliedCoupon || "") : ""),
    codFee: isMultiSeller ? 0 : codFee,
    itemsCount: orderItems.length,
    status: formattedStatus,
    overallStatus: formattedStatus,
    rawStatus: rawStatus,
    paymentMethod: o.paymentMethod || "UPI",
    paymentStatus: (
      String(o.paymentStatus || "").toLowerCase() === "paid" ||
      formattedStatus.toLowerCase().includes("delivered") ||
      String(o.overallStatus || o.status || "").toLowerCase().includes("delivered")
    ) ? "Paid" : (o.paymentStatus || (String(o.paymentMethod || "").toUpperCase().includes("COD") ? "Pending" : "Paid")),
    cancellationReason: o.cancellationReason || "",
    cancelledBy: o.cancelledBy || (o.cancellationReason ? "Customer" : ""),
    cancelledAt: o.cancelledAt || null,
    refundStatus: o.refundStatus || "",
    returnRequest: o.returnRequest || null,
    refundDetails: o.refundDetails || o.returnRequest?.refundDetails || null,
    timeline: o.timeline || [],
    shippingAddress: (o.shippingAddress && typeof o.shippingAddress === "object")
      ? o.shippingAddress
      : (typeof o.shippingAddress === "string" && o.shippingAddress
          ? o.shippingAddress
          : (o.address ? { street: o.address } : "Customer Address")),
    deliveryMode: (o.deliveryMode === "self_delivery" || (!o.deliveryMode && o.selfDeliveryDetails?.deliveryPartnerToken)) ? "self_delivery" : (o.deliveryMode === "third_party" ? "third_party" : (o.courierName ? "third_party" : (orderItems[0]?.deliveryType === "self" || orderItems[0]?.deliveryType === "self_delivery" ? "self_delivery" : "pending_choice"))),
    deliveryType: (o.deliveryMode === "self_delivery" || (!o.deliveryMode && o.selfDeliveryDetails?.deliveryPartnerToken)) ? "self_delivery" : (o.deliveryMode === "third_party" ? "third_party" : (o.courierName ? "third_party" : (orderItems[0]?.deliveryType === "self" || orderItems[0]?.deliveryType === "self_delivery" ? "self_delivery" : "pending_choice"))),
    trackingNumber: (o.deliveryMode === "self_delivery" || (!o.deliveryMode && o.selfDeliveryDetails?.deliveryPartnerToken)) ? (o.selfDeliveryDetails?.deliveryPartnerToken || o.trackingNumber || "") : (o.trackingNumber || orderItems[0]?.thirdPartyDetails?.trackingNumber || ""),
    courierName: (o.deliveryMode === "self_delivery" || (!o.deliveryMode && o.selfDeliveryDetails?.deliveryPartnerToken)) ? "" : (o.courierName || orderItems[0]?.thirdPartyDetails?.courierName || ""),
    trackingUrl: (o.deliveryMode === "self_delivery" || (!o.deliveryMode && o.selfDeliveryDetails?.deliveryPartnerToken)) ? (o.selfDeliveryDetails?.trackingUrl || o.trackingUrl || "") : (o.trackingUrl || orderItems[0]?.thirdPartyDetails?.trackingUrl || ""),
    sellerDetails: o.sellerDetails || orderItems[0]?.sellerDetails || null,
    sellerStoreName: o.sellerStoreName || o.storeName || orderItems[0]?.sellerStoreName || orderItems[0]?.storeName || o.sellerDetails?.storeName || scope?.storeName || "",
    storeName: o.storeName || o.sellerStoreName || orderItems[0]?.storeName || orderItems[0]?.sellerStoreName || o.sellerDetails?.storeName || scope?.storeName || "",
    sellerName: o.sellerName || orderItems[0]?.sellerName || o.sellerDetails?.sellerName || scope?.storeName || "",
    selfDeliveryDetails: sanitizeSelfDeliveryForSeller(o.selfDeliveryDetails || orderItems[0]?.selfDeliveryDetails),
    commissionRate: orderSettlement.commissionRate,
    commissionAmount: orderSettlement.commissionAmount,
    gstOnCommissionRate: orderSettlement.gstOnCommissionRate,
    gstOnCommissionAmount: orderSettlement.gstOnCommissionAmount,
    tdsRate: orderSettlement.tdsRate,
    tdsAmount: orderSettlement.tdsAmount,
    gstTcsRate: orderSettlement.gstTcsRate,
    gstTcsAmount: orderSettlement.gstTcsAmount,
    deliveryChargeAmount: orderSettlement.deliveryChargeAmount,
    gstOnDeliveryAmount: orderSettlement.gstOnDeliveryAmount,
    totalDeliveryDeduction: orderSettlement.totalDeliveryDeduction,
    deliveryChargeBorneBy: orderSettlement.deliveryChargeBorneBy,
    settlementRule: orderSettlement.ruleCode,
    totalDeductions: orderSettlement.totalDeductions,
    netSettlementAmount: orderSettlement.netSettlement,
    settlement: orderSettlement,
    items: orderItems.map((item) => {
      const itemGross = Number(item.total || Math.max(0, (Number(item.price || 0) * Number(item.quantity || 1)) - Number(item.offerDiscount || item.discount || 0)));
      const itGstRate = Number(item.gstRate ?? item.gstPercent ?? item.gstPercentage ?? item.gst ?? (item.category?.toLowerCase()?.includes('book') ? 0 : 5));
      const isItemCancelled = isCancelledOrder || 
                              String(item.status || "").toLowerCase().includes("cancel") || 
                              String(item.status || "").toLowerCase().includes("refund") || 
                              item.settlementStatus === "refunded" || 
                              item.settlementStatus === "cancelled";
      const itemStl = calculateSellerSettlement(itemGross, {
        commissionRate: Number(item.commissionRate ?? o.commissionRate ?? 10),
        sellerGstNumber: sellerGstVal,
        sellerStoreName: item.sellerStoreName || item.storeName || o.sellerStoreName || o.storeName || scope?.storeName || "",
        sellerPhone: scope?.phone || o.sellerPhone || "",
        paymentMethod: o.paymentMethod || "UPI",
        deliveryMode: item.deliveryType || o.deliveryMode || (o.selfDeliveryDetails?.deliveryPersonName ? "self_delivery" : "third_party"),
        courierName: o.courierName || item.thirdPartyDetails?.courierName,
        orderTotal: ordTotalVal || itemGross,
        sellerState: sellerStateVal,
        customerState: customerStateVal,
        gstRate: itGstRate,
        category: item.category || "",
        name: item.name || "",
        deliveryCharge: customerShippingFee || o.deliveryCharge || 49,
        shippingFee: customerShippingFee,
        shippingCost: customerShippingFee,
        codFee: isMultiSeller ? 0 : codFee,
        appliedCodFee: isMultiSeller ? 0 : codFee,
        freeDeliveryThreshold: Number(o.freeDeliveryThreshold ?? 401),
        deliveryChargeBorneBy: resolvedBorneBy,
        isCancelled: isItemCancelled,
        isRefunded: isItemCancelled
      });
      return {
        id: item._id || item.id,
        _id: item._id || item.id,
        productId: item.productId || item.id || item._id,
        name: item.name || "Product Item",
        price: Number(item.price || item.finalPrice || 0),
        offerDiscount: Number(item.offerDiscount || item.discount || 0),
        discount: Number(item.offerDiscount || item.discount || 0),
        finalPrice: Number(item.finalPrice || (Number(item.price || 0) - Number(item.offerDiscount || item.discount || 0))),
        couponCode: item.couponCode || (Number(item.offerDiscount || item.discount || 0) > 0 ? (o.couponCode || o.appliedCoupon || "") : ""),
        quantity: Number(item.quantity || 1),
        codChargeAmount: itemStl.codChargeAmount,
        codChargeRetainedBy: itemStl.codChargeRetainedBy,
        codChargeDeduction: itemStl.codChargeDeduction,
        isCodExempted: itemStl.isCodExempted,
        total: itemGross,
        size: item.size || "",
        color: item.color || "",
        image: item.image || "",
        gst: item.gst !== undefined ? item.gst : (item.gstRate ?? item.gstPercent ?? 5),
        gstPercent: item.gstPercent !== undefined ? item.gstPercent : (item.gstRate ?? item.gst ?? 5),
        gstPercentage: item.gstPercentage !== undefined ? item.gstPercentage : (item.gstRate ?? item.gst ?? 5),
        gstRate: item.gstRate !== undefined ? item.gstRate : (item.gstPercent ?? item.gst ?? 5),
        isGstInclusive: item.isGstInclusive !== false,
        category: item.category || "Stationery",
        status: normalizeOrderStatus(item.status || formattedStatus),
        deliveryType: item.deliveryType || o.deliveryMode || "",
        selfDeliveryDetails: sanitizeSelfDeliveryForSeller(item.selfDeliveryDetails || o.selfDeliveryDetails),
        thirdPartyDetails: item.thirdPartyDetails || { courierName: o.courierName, trackingNumber: o.trackingNumber, trackingUrl: o.trackingUrl },
        sellerId: item.sellerId || o.sellerId || null,
        sellerStoreName: item.sellerStoreName || item.storeName || item.sellerDetails?.storeName || o.sellerStoreName || o.storeName || scope?.storeName || "",
        storeName: item.storeName || item.sellerStoreName || item.sellerDetails?.storeName || o.storeName || o.sellerStoreName || scope?.storeName || "",
        sellerName: item.sellerName || item.sellerDetails?.sellerName || o.sellerName || scope?.storeName || "",
        sellerDetails: item.sellerDetails || o.sellerDetails || null,
        commissionRate: itemStl.commissionRate,
        commissionAmount: itemStl.commissionAmount,
        gstOnCommissionRate: itemStl.gstOnCommissionRate,
        gstOnCommissionAmount: itemStl.gstOnCommissionAmount,
        tdsRate: itemStl.tdsRate,
        tdsAmount: itemStl.tdsAmount,
        isIntraState: itemStl.isIntraState,
        gstTcsRate: itemStl.gstTcsRate,
        gstTcsAmount: itemStl.gstTcsAmount,
        cgstTcsRate: itemStl.cgstTcsRate,
        cgstTcsAmount: itemStl.cgstTcsAmount,
        sgstTcsRate: itemStl.sgstTcsRate,
        sgstTcsAmount: itemStl.sgstTcsAmount,
        igstTcsRate: itemStl.igstTcsRate,
        igstTcsAmount: itemStl.igstTcsAmount,
        deliveryChargeAmount: itemStl.deliveryChargeAmount,
        gstOnDeliveryAmount: itemStl.gstOnDeliveryAmount,
        totalDeliveryDeduction: itemStl.totalDeliveryDeduction,
        deliveryChargeBorneBy: itemStl.deliveryChargeBorneBy,
        settlementRule: itemStl.ruleCode,
        totalDeductions: itemStl.totalDeductions,
        netSettlementAmount: itemStl.netSettlement,
        settlement: itemStl
      };
    })
  };
};

// 1. Get All Orders for the Logged-in Seller with Fast In-Memory Cache
export const getSellerOrders = async (req, res) => {
  try {
    const sellerId = resolveSellerId(req);
    const now = Date.now();
    if (sellerId && sellerOrdersCache.has(sellerId)) {
      const entry = sellerOrdersCache.get(sellerId);
      if (now - entry.timestamp < SELLER_CACHE_TTL) {
        return res.json(entry.data);
      }
    }

    const scope = await getExpandedSellerScope(req);
    const orders = await Order.find(scope.filter).sort({ createdAt: -1 }).lean();

    // Assign sequential invoice numbers for orders lacking one (e.g. NSD01, NSD02...)
    const sellerStoreForInvoice = scope?.storeName || scope?.name || "Store";
    const prefix = getSellerInvoicePrefix(sellerStoreForInvoice);
    const totalCount = orders.length;

    orders.forEach((o, idxFromNewest) => {
      // In reverse-chronological order (newest first), chronological rank = totalCount - idxFromNewest
      const chronoSeq = totalCount - idxFromNewest;
      if (!o.invoiceNumber || o.invoiceNumber.startsWith("INV-")) {
        const computedInvoiceNo = formatSellerInvoiceNumber(prefix, chronoSeq);
        o.invoiceNumber = computedInvoiceNo;
        o.sellerInvoiceNo = computedInvoiceNo;
        o.sellerSequence = chronoSeq;

        // Persist to DB in background so subsequent queries find it
        Order.updateOne(
          { _id: o._id },
          { $set: { invoiceNumber: computedInvoiceNo, sellerInvoiceNo: computedInvoiceNo, sellerSequence: chronoSeq } }
        ).exec().catch(() => {});
      }
    });

    const formattedOrders = orders.map((o) => formatSellerSingleOrder(o, scope)).filter(Boolean);

    if (sellerId) {
      sellerOrdersCache.set(sellerId, { data: formattedOrders, timestamp: now });
    }
    res.json(formattedOrders);
  } catch (error) {
    console.error("Error fetching seller orders:", error);
    res.status(200).json([]);
  }
};

// 2. Get Dynamic Customer & Parent Records for Logged-in Seller
export const getSellerCustomers = async (req, res) => {
  try {
    const { expandedSellerIds, allProductKeys, productNameRegexes, filter } = await getExpandedSellerScope(req);
    const orders = await Order.find(filter).sort({ createdAt: -1 }).lean();

    const customerMap = new Map();

    orders.forEach((order) => {
      const c = order.customer || {};
      const name = c.name || order.userName || order.customerName || "Valued Parent / Customer";
      const email = c.email || order.userEmail || order.customerEmail || "";
      const phone = c.phone || order.userPhone || order.customerPhone || "";
      const key = (phone || email || name).toLowerCase().trim();
      if (!key) return;

      const itemsList = Array.isArray(order.items) ? order.items : [];
      const strExpandedSellerIds = expandedSellerIds.map(String);
      const strAllProductKeys = allProductKeys.map(String);

      const sellerItems = itemsList.filter((item) => {
        if (!expandedSellerIds.length) return true;
        const matchSeller = item.sellerId && strExpandedSellerIds.includes(String(item.sellerId));
        const matchProduct = (item.productId || item.id) && strAllProductKeys.includes(String(item.productId || item.id));
        const matchName = item.name && productNameRegexes.some((regex) => regex.test(item.name));
        return matchSeller || matchProduct || matchName;
      });

      const relevantItems = sellerItems.length > 0 ? sellerItems : itemsList;
      const sellerSubtotal = relevantItems.reduce(
        (acc, item) => acc + (Number(item.total) || (Number(item.price || item.finalPrice || 0) * Number(item.quantity || 1))),
        0
      );

      const orderTotal = sellerSubtotal > 0 ? sellerSubtotal : Number(order.totalAmount || order.total || order.subtotal || 0);

      if (!customerMap.has(key)) {
        customerMap.set(key, {
          id: `CUST-${Math.floor(10000 + Math.random() * 90000)}`,
          name: name,
          email: email,
          phone: phone,
          schoolAffiliation: order.schoolName || order.school || c.school || "General Public",
          studentName: c.studentName || order.studentName || "",
          totalOrders: 1,
          totalSpend: orderTotal,
          status: orderTotal >= 5000 ? "VIP" : "Active",
          lastOrderDate: order.date
            ? order.date
            : order.createdAt
            ? new Date(order.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
            : "Recently"
        });
      } else {
        const existing = customerMap.get(key);
        existing.totalOrders += 1;
        existing.totalSpend += orderTotal;
        if (existing.totalSpend >= 5000) existing.status = "VIP";
      }
    });

    res.json(Array.from(customerMap.values()));
  } catch (error) {
    console.error("Error fetching seller customers:", error);
    res.status(200).json([]);
  }
};

const resolveCarrierTrackingUrl = (courier, tracking) => {
  if (!tracking) return "";
  const c = String(courier || "").toLowerCase().trim();
  const cleanAwb = String(tracking).trim();
  if (c.includes("delhivery")) {
    return `https://www.delhivery.com/track/package/${cleanAwb}`;
  }
  if (c.includes("bluedart") || c.includes("blue dart")) {
    return `https://www.bluedart.com/tracking?awb=${cleanAwb}`;
  }
  if (c.includes("dtdc")) {
    return `https://www.dtdc.in/tracking/shipment-tracking.asp?awb=${cleanAwb}`;
  }
  if (c.includes("ekart")) {
    return `https://ekartlogistics.com/shipmenttrack/${cleanAwb}`;
  }
  if (c.includes("indiapost") || c.includes("speedpost") || c.includes("india post")) {
    return `https://www.indiapost.gov.in/_layouts/15/dpt.cept.tracking/trackconsignment.aspx`;
  }
  return `https://track.shiprocket.in/tracking/${cleanAwb}`;
};

const resolveSellerProfileDetails = async (req, fallbackOrder) => {
  const sellerId = resolveSellerId(req);
  let sellerProfile = null;
  if (sellerId) {
    if (mongoose.Types.ObjectId.isValid(sellerId)) {
      sellerProfile = await Seller.findById(sellerId).select("name storeName phone email address city");
      if (!sellerProfile) {
        sellerProfile = await User.findById(sellerId).select("name storeName phone email address city");
      }
    } else {
      sellerProfile = await Seller.findOne({ $or: [{ phone: sellerId }, { email: sellerId }] }).select("name storeName phone email address city");
      if (!sellerProfile) {
        sellerProfile = await User.findOne({ $or: [{ phone: sellerId }, { email: sellerId }] }).select("name storeName phone email address city");
      }
    }
  }

  const existingSeller = fallbackOrder?.sellerDetails || {};
  return {
    sellerId: sellerId || existingSeller.sellerId || req.user?.id || null,
    storeName: req.body.sellerDetails?.storeName || req.user?.storeName || sellerProfile?.storeName || sellerProfile?.name || existingSeller.storeName || "Partner Merchant",
    sellerName: req.body.sellerDetails?.sellerName || req.user?.name || sellerProfile?.name || sellerProfile?.storeName || existingSeller.sellerName || "Partner Merchant",
    phone: req.body.sellerDetails?.phone || req.user?.phone || sellerProfile?.phone || existingSeller.phone || "",
    email: req.body.sellerDetails?.email || req.user?.email || sellerProfile?.email || existingSeller.email || "",
    address: req.body.sellerDetails?.address || sellerProfile?.address || existingSeller.address || "",
    city: req.body.sellerDetails?.city || sellerProfile?.city || existingSeller.city || ""
  };
};

// 3. Update Order Item Status & Delivery Method by Seller
export const updateSellerOrderItemStatus = async (req, res) => {
  try {
    const { orderId, itemId } = req.params;
    const {
      status,
      deliveryType,
      deliveryMode,
      selfDeliveryDetails,
      thirdPartyDetails,
      sellerDetails
    } = req.body;

    const order = await findOrderById(orderId);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    let item = null;
    if (order.items && Array.isArray(order.items)) {
      item = order.items.find(i => String(i._id) === String(itemId) || String(i.id) === String(itemId));
    }

    if (!item) {
      return res.status(404).json({ message: "Order item not found" });
    }

    // STRICT MULTI-SELLER AUTHORIZATION: Ensure seller owns this specific item
    const scope = await getExpandedSellerScope(req);
    const isOwner = isItemBelongingToSellerScope(item, scope);
    if (!isOwner && req.user?.role !== "admin" && req.user?.role !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Unauthorized: You can only update fulfillment status for your own products."
      });
    }

    // Check if item is already delivered/completed
    const isItemFinal = ["delivered", "completed", "cancelled", "canceled"].includes(String(item.status || "").toLowerCase());
    if (isItemFinal && !status) {
      return res.status(400).json({
        success: false,
        message: `Product item is already '${item.status}' and cannot be modified.`
      });
    }

    let rawMode = deliveryMode || deliveryType || item.deliveryType || "pending_choice";
    if (rawMode === "self") rawMode = "self_delivery";
    if (rawMode === "courier") rawMode = "third_party";
    const validModes = ["third_party", "self_delivery", "pending_choice", "standard", "express", ""];
    const resolvedMode = validModes.includes(rawMode) ? rawMode : "pending_choice";

    const formattedStatus = status
      ? normalizeOrderStatus(status)
      : normalizeOrderStatus(item.status || order.status || "Pending");

    if (status) {
      item.status = formattedStatus;
      const computedOverall = calculateOverallOrderStatus(order.items);
      order.status = computedOverall;
      order.overallStatus = computedOverall;
    }
    if (deliveryType || deliveryMode) {
      item.deliveryType = resolvedMode;
      order.deliveryMode = resolvedMode;
    }

    const sellerInfo = await resolveSellerProfileDetails(req, order);
    item.sellerDetails = sellerInfo;
    item.storeName = sellerInfo.storeName;
    item.sellerName = sellerInfo.sellerName;
    item.sellerPhone = sellerInfo.phone;
    order.sellerDetails = sellerInfo;

    if (resolvedMode === "self_delivery" && selfDeliveryDetails) {
      const clientAppUrl = (process.env.CLIENT_URL || process.env.FRONTEND_BASE_URL || "http://localhost:5173").replace(/\/+$/, '');
      const tokenVal = String(
        selfDeliveryDetails.deliveryPartnerToken ||
        item.selfDeliveryDetails?.deliveryPartnerToken ||
        order.selfDeliveryDetails?.deliveryPartnerToken ||
        `DLV-${Math.floor(100000 + Math.random() * 900000)}`
      ).trim();
      const trackingLink = `${clientAppUrl}/#delivery-partner?token=${encodeURIComponent(tokenVal)}`;
      const existingOtpCandidate = String(selfDeliveryDetails.deliveryOtp || order.deliveryOtp || item.selfDeliveryDetails?.deliveryOtp || order.selfDeliveryDetails?.deliveryOtp || "").trim();
      const otpVal = /^\d{4}$/.test(existingOtpCandidate) ? existingOtpCandidate : Math.floor(1000 + Math.random() * 9000).toString();
      const otpLastSentAt = selfDeliveryDetails.otpLastSentAt || order.selfDeliveryDetails?.otpLastSentAt || new Date();
      const otpExpiresAt = selfDeliveryDetails.otpExpiresAt || order.selfDeliveryDetails?.otpExpiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000);

      item.selfDeliveryDetails = {
        ...item.selfDeliveryDetails,
        ...selfDeliveryDetails,
        deliveryPartnerToken: tokenVal,
        trackingUrl: trackingLink,
        deliveryOtp: otpVal,
        otpLastSentAt,
        otpExpiresAt
      };
      item.deliveryOtp = otpVal;
      order.deliveryOtp = otpVal;
      order.selfDeliveryDetails = item.selfDeliveryDetails;
      order.trackingUrl = trackingLink;
      order.trackingNumber = tokenVal;
      order.courierName = "";
      order.carrier = "";
    } else if (resolvedMode === "third_party") {
      item.deliveryType = "third_party";
      item.deliveryOtp = "";
      item.selfDeliveryDetails = undefined;
      if (thirdPartyDetails) {
        const carrierUrl = thirdPartyDetails.trackingUrl || resolveCarrierTrackingUrl(thirdPartyDetails.courierName, thirdPartyDetails.trackingNumber);
        item.thirdPartyDetails = {
          ...item.thirdPartyDetails,
          ...thirdPartyDetails,
          trackingUrl: carrierUrl
        };
        if (thirdPartyDetails.courierName) order.courierName = thirdPartyDetails.courierName;
        if (thirdPartyDetails.trackingNumber) order.trackingNumber = thirdPartyDetails.trackingNumber;
        if (carrierUrl) order.trackingUrl = carrierUrl;
      }
    } else {
      item.deliveryType = "pending_choice";
      item.deliveryOtp = "";
      item.selfDeliveryDetails = undefined;
    }

    // Dynamic Settlement Recalculation on Fulfillment Update
    const itemGross = Number(item.total || Math.max(0, (Number(item.price || 0) * Number(item.quantity || 1)) - Number(item.offerDiscount || item.discount || 0)));
    const itGstRate = Number(item.gstRate ?? item.gstPercent ?? item.gstPercentage ?? item.gst ?? (item.category?.toLowerCase()?.includes('book') ? 0 : 5));
    const customerShippingFee = Number(order.shippingFee ?? order.shippingCost ?? order.shippingAmount ?? 0);
    const ordTotalVal = Number(order.totalAmount || order.total || itemGross);
    const freeDeliveryThreshold = Number(order.freeDeliveryThreshold ?? 401);
    const resolvedBorneBy = (ordTotalVal >= freeDeliveryThreshold) ? 'admin' : (customerShippingFee > 0 ? 'customer' : (order.deliveryChargeBorneBy || 'seller'));

    const itemStl = calculateSellerSettlement(itemGross, {
      commissionRate: Number(item.commissionRate ?? order.commissionRate ?? sellerInfo.commissionRate ?? 10),
      sellerGstNumber: sellerInfo.gstNumber || "",
      paymentMethod: order.paymentMethod || "UPI",
      deliveryMode: resolvedMode,
      courierName: order.courierName || item.thirdPartyDetails?.courierName,
      orderTotal: ordTotalVal,
      sellerState: sellerInfo.state || "Uttar Pradesh",
      customerState: order.shippingAddress?.state || "Uttar Pradesh",
      gstRate: itGstRate,
      category: item.category || "",
      name: item.name || "",
      deliveryCharge: customerShippingFee || order.deliveryCharge || 49,
      shippingFee: customerShippingFee,
      shippingCost: customerShippingFee,
      codFee: Number(order.codFee ?? order.appliedCodFee ?? order.codCharges ?? 0),
      appliedCodFee: Number(order.appliedCodFee ?? order.codFee ?? 0),
      freeDeliveryThreshold,
      deliveryChargeBorneBy: resolvedBorneBy,
      isCancelled: ['cancelled', 'canceled', 'refunded'].includes(String(formattedStatus).toLowerCase())
    });

    item.commissionRate = itemStl.commissionRate;
    item.commissionAmount = itemStl.commissionAmount;
    item.gstOnCommissionRate = itemStl.gstOnCommissionRate;
    item.gstOnCommissionAmount = itemStl.gstOnCommissionAmount;
    item.tdsRate = itemStl.tdsRate;
    item.tdsAmount = itemStl.tdsAmount;
    item.isIntraState = itemStl.isIntraState;
    item.gstTcsRate = itemStl.gstTcsRate;
    item.gstTcsAmount = itemStl.gstTcsAmount;
    item.cgstTcsRate = itemStl.cgstTcsRate;
    item.cgstTcsAmount = itemStl.cgstTcsAmount;
    item.sgstTcsRate = itemStl.sgstTcsRate;
    item.sgstTcsAmount = itemStl.sgstTcsAmount;
    item.igstTcsRate = itemStl.igstTcsRate;
    item.igstTcsAmount = itemStl.igstTcsAmount;
    item.deliveryChargeAmount = itemStl.deliveryChargeAmount;
    item.gstOnDeliveryAmount = itemStl.gstOnDeliveryAmount;
    item.totalDeliveryDeduction = itemStl.totalDeliveryDeduction;
    item.deliveryChargeBorneBy = itemStl.deliveryChargeBorneBy;
    item.settlementRule = itemStl.ruleCode;
    item.totalDeductions = itemStl.totalDeductions;
    item.netSettlementAmount = itemStl.netSettlement;
    order.deliveryChargeBorneBy = resolvedBorneBy;

    order.timeline = order.timeline || [];
    order.timeline.push({
      status: formattedStatus.toLowerCase(),
      title: `Item '${item.name}' ${formattedStatus}`,
      description: `Item status updated to ${formattedStatus} by seller (${sellerInfo.storeName}).`,
      timestamp: new Date(),
      updatedBy: sellerInfo.storeName || "Seller"
    });

    order.markModified('items');
    await order.save();

    invalidateSellerOrdersCache();
    invalidateOrdersCache();
    try {
      broadcastRealtimeEvent({
        type: "ORDER_UPDATED",
        orderId: order.orderId,
        masterOrderId: order.masterOrderId,
        sellerId: sellerInfo._id || sellerInfo.id,
        status: order.overallStatus || order.status
      });
    } catch (rtErr) {}

    // Dispatch status SMS to customer if item/order is confirmed, shipped, etc.
    try {
      const targetStatus = formattedStatus || order.overallStatus;
      sendOrderStatusSms(order, targetStatus, {
        trackingUrl: order.trackingUrl || sanitizedItem?.selfDeliveryDetails?.trackingUrl || sanitizedItem?.thirdPartyDetails?.trackingUrl
      }).catch(err => console.warn("⚠️ [FAST2SMS] Seller item status update SMS error:", err.message));
    } catch (smsErr) {}

    const sanitizedItem = { ...(item.toObject ? item.toObject() : item) };
    if (sanitizedItem.selfDeliveryDetails) {
      sanitizedItem.selfDeliveryDetails = sanitizeSelfDeliveryForSeller(sanitizedItem.selfDeliveryDetails);
    }
    delete sanitizedItem.deliveryOtp;

    const formattedOrder = formatSellerSingleOrder(order, scope) || order;

    res.json({
      success: true,
      message: `Item status updated to ${formattedStatus}. Overall order status: ${order.overallStatus}`,
      status: formattedStatus,
      overallStatus: order.overallStatus,
      item: sanitizedItem,
      order: formattedOrder
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update item delivery & status", error: error.message });
  }
};

// 4. Update Overall Order Status for Seller Order
export const updateSellerOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const {
      status,
      trackingNumber,
      courierName,
      trackingUrl,
      estimatedDeliveryDate,
      deliveryType,
      deliveryMode,
      selfDeliveryDetails,
      sellerDetails
    } = req.body;

    const order = await findOrderById(orderId);

    if (!order) return res.status(404).json({ message: "Order not found" });

    // Check if order is already completed
    const isOrderFinal = ["delivered", "completed", "cancelled", "canceled"].includes(String(order.overallStatus || order.status || "").toLowerCase());
    if (isOrderFinal && !status) {
      return res.status(400).json({
        success: false,
        message: `Order is already '${order.overallStatus || order.status}' and cannot be modified.`
      });
    }

    const formattedStatus = status
      ? normalizeOrderStatus(status)
      : normalizeOrderStatus(order.status || "Pending");

    const sellerInfo = await resolveSellerProfileDetails(req, order);
    order.sellerDetails = sellerInfo;

    let rawMode = deliveryMode || deliveryType || (selfDeliveryDetails ? "self_delivery" : (courierName || trackingNumber ? "third_party" : (order.deliveryMode || "")));
    if (rawMode === "self") rawMode = "self_delivery";
    if (rawMode === "courier") rawMode = "third_party";
    const validModes = ["third_party", "self_delivery", "pending_choice", "standard", "express", ""];
    const resolvedMode = validModes.includes(rawMode) ? rawMode : "pending_choice";
    order.deliveryMode = resolvedMode;

    let computedTrackingUrl = trackingUrl || "";
    let effectiveAwb = "";
    let mergedSelf = null;

    if (resolvedMode === "third_party") {
      order.courierName = courierName || order.courierName || "Shiprocket";
      order.carrier = order.courierName;
      order.selfDeliveryDetails = undefined;
      order.deliveryOtp = "";
      const isCod = String(order.paymentMethod || "").toUpperCase().includes("COD");
      const dynamicRule = isCod ? "COD_THIRD_PARTY_DELIVERY" : "ONLINE_THIRD_PARTY_DELIVERY";
      order.settlementRule = dynamicRule;
      if (Array.isArray(order.items)) {
        order.items.forEach(it => {
          it.deliveryOtp = "";
          it.selfDeliveryDetails = undefined;
          it.deliveryType = "third_party";
          it.settlementRule = dynamicRule;
        });
      }
      effectiveAwb = trackingNumber || order.trackingNumber || "";
      if (!effectiveAwb || effectiveAwb.startsWith("DLV-")) {
        const courierPrefix = String(order.courierName || "SHIPROCKET")
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
          .slice(0, 10) || "COURIER";
        effectiveAwb = `${courierPrefix}-${Math.floor(10000000 + Math.random() * 90000000)}`;
      }
      order.trackingNumber = effectiveAwb;
      computedTrackingUrl = trackingUrl || resolveCarrierTrackingUrl(order.courierName, effectiveAwb);
      if (computedTrackingUrl) order.trackingUrl = computedTrackingUrl;
    } else if (resolvedMode === "self_delivery") {
      const clientAppUrl = (process.env.CLIENT_URL || process.env.FRONTEND_BASE_URL || "http://localhost:5173").replace(/\/+$/, '');
      const tokenVal = String(
        selfDeliveryDetails?.deliveryPartnerToken ||
        order.selfDeliveryDetails?.deliveryPartnerToken ||
        `DLV-${Math.floor(100000 + Math.random() * 900000)}`
      ).trim();
      const trackingLink = `${clientAppUrl}/#delivery-partner?token=${encodeURIComponent(tokenVal)}`;
      const existingOtpCandidate = String(selfDeliveryDetails?.deliveryOtp || order.deliveryOtp || order.selfDeliveryDetails?.deliveryOtp || "").trim();
      const otpVal = /^\d{4}$/.test(existingOtpCandidate) ? existingOtpCandidate : Math.floor(1000 + Math.random() * 9000).toString();
      const otpLastSentAt = selfDeliveryDetails?.otpLastSentAt || order.selfDeliveryDetails?.otpLastSentAt || new Date();
      const otpExpiresAt = selfDeliveryDetails?.otpExpiresAt || order.selfDeliveryDetails?.otpExpiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000);

      const sanitizeDriverLocation = (rawLoc) => {
        if (!rawLoc || typeof rawLoc !== 'object') return { lat: null, lng: null, updatedAt: null };
        return {
          lat: typeof rawLoc.lat === 'number' ? rawLoc.lat : (rawLoc.lat ? Number(rawLoc.lat) || null : null),
          lng: typeof rawLoc.lng === 'number' ? rawLoc.lng : (rawLoc.lng ? Number(rawLoc.lng) || null : null),
          updatedAt: rawLoc.updatedAt ? new Date(rawLoc.updatedAt) : null
        };
      };

      const existingDriverLoc = order.selfDeliveryDetails?.driverLocation;
      const inputDriverLoc = selfDeliveryDetails?.driverLocation !== undefined
        ? sanitizeDriverLocation(selfDeliveryDetails.driverLocation)
        : sanitizeDriverLocation(existingDriverLoc);

      mergedSelf = {
        deliveryPersonName: selfDeliveryDetails?.deliveryPersonName || order.selfDeliveryDetails?.deliveryPersonName || "",
        deliveryPersonPhone: selfDeliveryDetails?.deliveryPersonPhone || order.selfDeliveryDetails?.deliveryPersonPhone || "",
        vehicleNumber: selfDeliveryDetails?.vehicleNumber || order.selfDeliveryDetails?.vehicleNumber || "",
        deliveryPartnerToken: tokenVal,
        trackingUrl: trackingLink,
        deliveryOtp: otpVal,
        driverLocation: inputDriverLoc,
        otpLastSentAt,
        otpExpiresAt
      };

      const isCod = String(order.paymentMethod || "").toUpperCase().includes("COD");
      const dynamicRule = isCod ? "COD_SELF_DELIVERY" : "ONLINE_SELF_DELIVERY";
      order.settlementRule = dynamicRule;
      order.deliveryOtp = otpVal;
      order.selfDeliveryDetails = mergedSelf;
      if (Array.isArray(order.items)) {
        order.items.forEach(it => {
          it.deliveryOtp = otpVal;
          if (it.selfDeliveryDetails) it.selfDeliveryDetails.deliveryOtp = otpVal;
          it.deliveryType = "self_delivery";
          it.settlementRule = dynamicRule;
        });
      }
      order.trackingUrl = trackingLink;
      order.trackingNumber = tokenVal;
      order.courierName = "";
      order.carrier = "";
    } else {
      // pending_choice
      order.deliveryOtp = "";
      order.selfDeliveryDetails = undefined;
      if (Array.isArray(order.items)) {
        order.items.forEach(it => {
          it.deliveryOtp = "";
          it.selfDeliveryDetails = undefined;
          it.deliveryType = "pending_choice";
        });
      }
    }

    // Fully Automated WhatsApp Dispatch to Delivery Boy
    let whatsappDispatchResult = null;
    if (resolvedMode === "self_delivery" && mergedSelf && mergedSelf.deliveryPersonPhone) {
      whatsappDispatchResult = await sendDeliveryPartnerWhatsAppDispatch({
        order,
        selfDeliveryDetails: mergedSelf,
        clientAppUrl: req.headers.origin || req.headers.referer
      });

      if (whatsappDispatchResult.success) {
        mergedSelf.whatsappStatus = "sent";
        mergedSelf.whatsappSentAt = whatsappDispatchResult.sentAt;
        mergedSelf.whatsappMessageId = whatsappDispatchResult.messageId;
        mergedSelf.whatsappSentTo = whatsappDispatchResult.sentTo;
      } else {
        mergedSelf.whatsappStatus = "failed";
      }
    }

    // Build update object
    const updatePayload = {
      status: formattedStatus,
      overallStatus: formattedStatus,
      deliveryMode: resolvedMode,
      sellerDetails: sellerInfo
    };

    // Keep returnRequest intact if active

    if (formattedStatus.toLowerCase().includes("delivered")) {
      updatePayload.deliveredAt = order.deliveredAt || new Date();
      const isCod = String(order.paymentMethod || "").toUpperCase().includes("COD") || String(order.paymentStatus || "").toLowerCase() !== "paid";
      if (isCod) {
        updatePayload.paymentStatus = "Paid";
        updatePayload.isPaid = true;
        updatePayload.codCollectedAt = order.codCollectedAt || new Date();
        updatePayload.codCollectedBy = sellerInfo.storeName || "Delivery Partner";
      }
    }

    if (resolvedMode === "third_party") {
      updatePayload.courierName = order.courierName || courierName || "Shiprocket";
      updatePayload.carrier = updatePayload.courierName;
      updatePayload.selfDeliveryDetails = null;
      if (effectiveAwb) updatePayload.trackingNumber = effectiveAwb;
      if (computedTrackingUrl) updatePayload.trackingUrl = computedTrackingUrl;
    } else if (resolvedMode === "self_delivery" && mergedSelf) {
      updatePayload.courierName = "";
      updatePayload.carrier = "";
      updatePayload.selfDeliveryDetails = mergedSelf;
      updatePayload.deliveryOtp = mergedSelf.deliveryOtp;
      updatePayload.trackingUrl = mergedSelf.trackingUrl;
      updatePayload.trackingNumber = mergedSelf.deliveryPartnerToken;
    }

    // Build timeline event
    const newTimeline = Array.isArray(order.timeline) ? [...order.timeline] : [];
    const deliveryDesc = resolvedMode === "self_delivery"
      ? `Direct Self-Delivery by ${sellerInfo.storeName} ${mergedSelf?.deliveryPersonName ? `(Rider: ${mergedSelf.deliveryPersonName})` : ''}`
      : (effectiveAwb ? `Courier: ${courierName || order.courierName || 'Express'} (AWB: ${effectiveAwb})` : 'Dispatched via Courier');

    newTimeline.push({
      status: formattedStatus,
      title: `Order ${formattedStatus}`,
      description: `Status updated to ${formattedStatus} by seller (${sellerInfo.storeName}). ${deliveryDesc}`,
      timestamp: new Date(),
      updatedBy: sellerInfo.storeName || "Seller"
    });

    if (whatsappDispatchResult?.success) {
      newTimeline.push({
        status: "whatsapp_sent",
        title: "WhatsApp Link Sent to Delivery Boy",
        description: `Automated WhatsApp dispatch sent to ${mergedSelf.deliveryPersonName} (${mergedSelf.deliveryPersonPhone}) with live tracking portal link: ${mergedSelf.trackingUrl} (Ref: ${whatsappDispatchResult.messageId})`,
        timestamp: new Date(),
        updatedBy: "System (WhatsApp Service)"
      });
    }

    updatePayload.timeline = newTimeline;

    // Also update item statuses in items array for seller's items
    if (Array.isArray(order.items) && order.items.length > 0) {
      const scope = await getExpandedSellerScope(req);
      const targetKey = String(formattedStatus || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
      const targetRank = STAGE_RANK[targetKey];

      const updatedItems = order.items.map(item => {
        const itemObj = item.toObject ? item.toObject() : item;
        const isBelongingToSeller = isItemBelongingToSellerScope(itemObj, scope);
        if (!isBelongingToSeller) {
          return itemObj; // Preserved untouched: other sellers' items remain unchanged
        }

        const itKey = String(itemObj.status || 'Pending').toLowerCase().trim().replace(/[\s-]+/g, '_');
        let nextStatus = formattedStatus;
        if (targetRank !== undefined) {
          if (itKey === 'cancelled' || itKey === 'canceled') {
            nextStatus = itemObj.status; // Keep cancelled items cancelled
          } else {
            const itRank = STAGE_RANK[itKey] !== undefined ? STAGE_RANK[itKey] : 0;
            // Promote if behind target; keep current if already at or ahead of target
            nextStatus = itRank < targetRank ? formattedStatus : itemObj.status;
          }
        }

        const itemGross = Number(itemObj.total || Math.max(0, (Number(itemObj.price || 0) * Number(itemObj.quantity || 1)) - Number(itemObj.offerDiscount || itemObj.discount || 0)));
        const itGstRate = Number(itemObj.gstRate ?? itemObj.gstPercent ?? itemObj.gstPercentage ?? itemObj.gst ?? (itemObj.category?.toLowerCase()?.includes('book') ? 0 : 5));
        const customerShippingFee = Number(order.shippingFee ?? order.shippingCost ?? order.shippingAmount ?? 0);
        const ordTotalVal = Number(order.totalAmount || order.total || itemGross);
        const freeDeliveryThreshold = Number(order.freeDeliveryThreshold ?? 401);
        const resolvedBorneBy = (ordTotalVal >= freeDeliveryThreshold) ? 'admin' : (customerShippingFee > 0 ? 'customer' : (order.deliveryChargeBorneBy || 'seller'));

        const itemStl = calculateSellerSettlement(itemGross, {
          commissionRate: Number(itemObj.commissionRate ?? order.commissionRate ?? sellerInfo.commissionRate ?? 10),
          sellerGstNumber: sellerInfo.gstNumber || "",
          paymentMethod: order.paymentMethod || "UPI",
          deliveryMode: resolvedMode,
          courierName: order.courierName || courierName,
          orderTotal: ordTotalVal,
          sellerState: sellerInfo.state || "Uttar Pradesh",
          customerState: order.shippingAddress?.state || "Uttar Pradesh",
          gstRate: itGstRate,
          category: itemObj.category || "",
          name: itemObj.name || "",
          deliveryCharge: customerShippingFee || order.deliveryCharge || 49,
          shippingFee: customerShippingFee,
          shippingCost: customerShippingFee,
          codFee: Number(order.codFee ?? order.appliedCodFee ?? order.codCharges ?? 0),
          appliedCodFee: Number(order.appliedCodFee ?? order.codFee ?? 0),
          freeDeliveryThreshold,
          deliveryChargeBorneBy: resolvedBorneBy,
          isCancelled: ['cancelled', 'canceled', 'refunded'].includes(String(nextStatus).toLowerCase())
        });

        return {
          ...itemObj,
          status: nextStatus,
          deliveryType: resolvedMode,
          sellerDetails: sellerInfo,
          sellerName: sellerInfo.sellerName,
          storeName: sellerInfo.storeName,
          sellerPhone: sellerInfo.phone,
          commissionRate: itemStl.commissionRate,
          commissionAmount: itemStl.commissionAmount,
          gstOnCommissionRate: itemStl.gstOnCommissionRate,
          gstOnCommissionAmount: itemStl.gstOnCommissionAmount,
          tdsRate: itemStl.tdsRate,
          tdsAmount: itemStl.tdsAmount,
          isIntraState: itemStl.isIntraState,
          gstTcsRate: itemStl.gstTcsRate,
          gstTcsAmount: itemStl.gstTcsAmount,
          cgstTcsRate: itemStl.cgstTcsRate,
          cgstTcsAmount: itemStl.cgstTcsAmount,
          sgstTcsRate: itemStl.sgstTcsRate,
          sgstTcsAmount: itemStl.sgstTcsAmount,
          igstTcsRate: itemStl.igstTcsRate,
          igstTcsAmount: itemStl.igstTcsAmount,
          deliveryChargeAmount: itemStl.deliveryChargeAmount,
          gstOnDeliveryAmount: itemStl.gstOnDeliveryAmount,
          totalDeliveryDeduction: itemStl.totalDeliveryDeduction,
          deliveryChargeBorneBy: itemStl.deliveryChargeBorneBy,
          settlementRule: itemStl.ruleCode,
          totalDeductions: itemStl.totalDeductions,
          netSettlementAmount: itemStl.netSettlement,
          ...(resolvedMode === "third_party" ? {
            thirdPartyDetails: {
              ...(itemObj.thirdPartyDetails || {}),
              courierName: order.courierName || courierName || "Shiprocket",
              trackingNumber: effectiveAwb || itemObj.thirdPartyDetails?.trackingNumber || order.trackingNumber,
              trackingUrl: computedTrackingUrl || itemObj.thirdPartyDetails?.trackingUrl,
              estimatedDeliveryDate: estimatedDeliveryDate || itemObj.thirdPartyDetails?.estimatedDeliveryDate
            },
            selfDeliveryDetails: null
          } : {}),
          ...(resolvedMode === "self_delivery" && mergedSelf ? {
            selfDeliveryDetails: mergedSelf,
            thirdPartyDetails: null
          } : {})
        };
      });

      updatePayload.items = updatedItems;
      const recomputedOverall = calculateOverallOrderStatus(updatedItems, order);
      const hasActiveReturn = order.returnRequest &&
        order.returnRequest.type &&
        !['none', 'n/a', '', 'null'].includes(String(order.returnRequest.type).toLowerCase().trim()) &&
        !['none', 'n/a', 'no_request', 'normal', 'null', ''].includes(String(order.returnRequest.status || '').toLowerCase().trim());
      if (!hasActiveReturn) {
        updatePayload.status = recomputedOverall;
        updatePayload.overallStatus = recomputedOverall;
      }
    }

    // Update MongoDB directly using updateOne
    await Order.updateOne({ _id: order._id }, { $set: updatePayload });

    // Fetch updated document and format for seller view to eliminate flicker
    const updatedOrder = await Order.findById(order._id);
    const scope = await getExpandedSellerScope(req);
    const formattedResult = formatSellerSingleOrder(updatedOrder, scope) || updatedOrder;

    invalidateSellerOrdersCache();
    invalidateOrdersCache();
    try {
      broadcastRealtimeEvent({
        type: "ORDER_UPDATED",
        orderId: updatedOrder?.orderId || order.orderId,
        masterOrderId: updatedOrder?.masterOrderId || order.masterOrderId,
        sellerId: updatedOrder?.sellerId || order.sellerId,
        status: updatedOrder?.overallStatus || updatedOrder?.status || formattedStatus
      });
    } catch (rtErr) {}

    // Fast2SMS DLT Status Update SMS (Shipped, Out for Delivery, Delivered, Cancelled)
    try {
      const targetStatus = updatedOrder?.overallStatus || updatedOrder?.status || formattedStatus;
      sendOrderStatusSms(updatedOrder, targetStatus, {
        trackingUrl: updatedOrder?.trackingUrl || updatedOrder?.selfDeliveryDetails?.trackingUrl,
        refundAmount: updatedOrder?.refundDetails?.amount || updatedOrder?.totalAmount
      }).catch(err => console.warn("⚠️ [FAST2SMS] Seller status update SMS error:", err.message));
    } catch (smsErr) {}

    res.json({
      success: true,
      message: `Order status updated to ${formattedStatus}`,
      order: formattedResult,
      whatsappDispatch: whatsappDispatchResult
    });
  } catch (error) {
    console.error("Error in updateSellerOrderStatus:", error);
    res.status(500).json({ success: false, message: "Failed to update order status", error: error.message });
  }
};

// Re-send WhatsApp Link to Delivery Boy for an existing Order
export const resendSellerDeliveryBoyWhatsApp = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await findOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const selfDetails = order.selfDeliveryDetails;
    if (!selfDetails || !selfDetails.deliveryPersonPhone) {
      return res.status(400).json({ success: false, message: "No self-delivery partner details found for this order" });
    }

    const dispatchResult = await sendDeliveryPartnerWhatsAppDispatch({
      order,
      selfDeliveryDetails: selfDetails,
      clientAppUrl: req.headers.origin || req.headers.referer
    });

    if (dispatchResult.success) {
      order.selfDeliveryDetails = {
        ...selfDetails,
        whatsappStatus: "sent",
        whatsappSentAt: dispatchResult.sentAt,
        whatsappMessageId: dispatchResult.messageId,
        whatsappSentTo: dispatchResult.sentTo
      };

      order.timeline = order.timeline || [];
      order.timeline.push({
        status: "whatsapp_sent",
        title: "WhatsApp Link Resent to Delivery Boy",
        description: `WhatsApp tracking link re-dispatched to ${selfDetails.deliveryPersonName} (${selfDetails.deliveryPersonPhone}). Ref: ${dispatchResult.messageId}`,
        timestamp: new Date(),
        updatedBy: "Seller (Resend)"
      });

      await order.save();
    }

    res.json({
      success: dispatchResult.success,
      message: dispatchResult.success ? "WhatsApp tracking link dispatched to delivery boy" : dispatchResult.error,
      whatsappDispatch: dispatchResult
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to dispatch WhatsApp link", error: error.message });
  }
};

// 5. Download Seller Tax Invoice / Packing Slip
export const downloadSellerInvoice = async (req, res) => {
  try {
    const { orderId } = req.params;
    const sellerId = resolveSellerId(req);

    const order = await findOrderById(orderId);
    if (order) {
      await order.populate("items.productId", "name price images mrp");
      await order.populate("items.sellerId", "storeName name phone city");
    }

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // STRICT CONFIRMATION CHECK: Do not generate invoice when product status is pending
    const status = String(order.overallStatus || order.status || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
    const isPending = !status || status === "pending" || status === "unconfirmed" || status === "placed";
    const isPaid = String(order.paymentStatus || "").toLowerCase() === "paid" || Number(order.advancePaidAmount || 0) > 0;
    const isConfirmedAndOnward = [
      "assigned", "accepted", "confirmed", "processing", "production", "packed", "shipped",
      "dispatched", "in_transit", "out_for_delivery", "delivered", "completed", "fulfilled",
      "return_requested", "returned", "exchange_requested", "exchanged", "refunded", "cancelled"
    ].includes(status);

    const isStrictlyPending = !isConfirmedAndOnward && !isPaid && isPending;
    if (isStrictlyPending) {
      return res.status(400).json({
        message: `Tax Invoice & Certificate can only be generated strictly after the order and products are confirmed. Current status: '${order.overallStatus || order.status || "Pending"}'.`
      });
    }

    const { generateTaxInvoicePDF } = await import("../services/invoiceService.js");

    const orderObj = order.toObject ? order.toObject() : order;
    const enrichedOrder = (await enrichOrdersWithSellerAndConsumer([orderObj]))[0];

    const filename = `Seller_Invoice_${enrichedOrder.orderId || enrichedOrder._id}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    let platformSettings = {};
    try {
      const PlatformSetting = (await import("../models/PlatformSetting.js")).default;
      platformSettings = (await PlatformSetting.findOne({ key: "global_settings" })) || {};
    } catch (e) {}

    const pdfDoc = generateTaxInvoicePDF(enrichedOrder, sellerId, {
      view: "seller",
      platformSetting: platformSettings,
      companyName: platformSettings.companyName,
      companyAddress: platformSettings.companyAddress,
      companyGstin: platformSettings.companyGstin,
      supportEmail: platformSettings.supportEmail || platformSettings.customerCareEmail,
      supportPhone: platformSettings.supportPhone || platformSettings.customerCarePhone
    });
    pdfDoc.pipe(res);
  } catch (error) {
    console.error("Seller invoice download error:", error);
    if (error.message && error.message.toLowerCase().includes("pending")) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: "Failed to generate seller invoice", error: error.message });
  }
};

// 6. Download Seller Credit Note PDF
export const downloadSellerCreditNote = async (req, res) => {
  try {
    const { orderId } = req.params;
    const sellerId = resolveSellerId(req);
    const order = await findOrderById(orderId);
    if (order) {
      await order.populate("items.productId", "name price images mrp");
      await order.populate("items.sellerId", "storeName name phone city");
    }
    if (!order) return res.status(404).json({ message: "Order not found" });

    const orderObj = order.toObject ? order.toObject() : order;
    const enrichedOrder = (await enrichOrdersWithSellerAndConsumer([orderObj]))[0];

    const reqType = String(enrichedOrder.returnRequest?.type || enrichedOrder.returnRequest?.requestType || "").toLowerCase();
    const orderOverallStatus = String(enrichedOrder.overallStatus || enrichedOrder.status || "").toLowerCase().trim().replace(/[\s-]+/g, '_');
    const returnStatus = String(enrichedOrder.returnRequest?.status || "").toLowerCase().trim().replace(/[\s-]+/g, '_');
    const isReturn = reqType === "return" || orderOverallStatus.includes("return") || returnStatus.includes("return");
    const isCancelled = orderOverallStatus === "cancelled" || Boolean(enrichedOrder.cancelledAt);

    // Statutory Check: Credit Note is generated ONLY after return is accepted / approved by store
    if (isReturn && !isCancelled) {
      const acceptedStatuses = [
        'approved', 'return_approved', 'pickup_scheduled',
        'product_received', 'product_return_received',
        'refund_initiated', 'refund_processed', 'refund_completed', 'refunded'
      ];
      const isAccepted = acceptedStatuses.some(s => orderOverallStatus.includes(s) || returnStatus.includes(s));
      if (!isAccepted) {
        return res.status(400).json({
          message: "Credit Note will be generated after the return request is accepted/approved by the seller or store."
        });
      }
    }

    const { generateCreditNotePDF } = await import("../services/invoiceService.js");
    const isExchangeOrder = String(enrichedOrder.returnRequest?.type || enrichedOrder.returnRequest?.requestType || '').toLowerCase() === 'exchange' ||
      String(enrichedOrder.overallStatus || enrichedOrder.status || '').toLowerCase().includes('exchange');
    const filename = isExchangeOrder
      ? `Seller_ExchangeInvoice_${enrichedOrder.orderId || enrichedOrder._id}.pdf`
      : `Seller_CreditNote_${enrichedOrder.orderId || enrichedOrder._id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    let platformSettings = {};
    try {
      const PlatformSetting = (await import("../models/PlatformSetting.js")).default;
      platformSettings = (await PlatformSetting.findOne({ key: "global_settings" })) || {};
    } catch (e) {}

    const pdfDoc = generateCreditNotePDF(enrichedOrder, sellerId, {
      platformSetting: platformSettings,
      companyName: platformSettings.companyName,
      companyAddress: platformSettings.companyAddress,
      companyGstin: platformSettings.companyGstin
    });
    pdfDoc.pipe(res);
  } catch (error) {
    console.error("Seller credit note download error:", error);
    res.status(500).json({ message: "Failed to generate seller credit note", error: error.message });
  }
};

// 7. Download Seller Exchange Invoice PDF
export const downloadSellerExchangeInvoice = async (req, res) => {
  try {
    const { orderId } = req.params;
    const sellerId = resolveSellerId(req);
    const order = await findOrderById(orderId);
    if (order) {
      await order.populate("items.productId", "name price images mrp");
      await order.populate("items.sellerId", "storeName name phone city");
    }
    if (!order) return res.status(404).json({ message: "Order not found" });

    const { generateExchangeInvoicePDF } = await import("../services/invoiceService.js");
    const orderObj = order.toObject ? order.toObject() : order;
    const enrichedOrder = (await enrichOrdersWithSellerAndConsumer([orderObj]))[0];

    const filename = `Seller_ExchangeInvoice_${enrichedOrder.orderId || enrichedOrder._id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    let platformSettings = {};
    try {
      const PlatformSetting = (await import("../models/PlatformSetting.js")).default;
      platformSettings = (await PlatformSetting.findOne({ key: "global_settings" })) || {};
    } catch (e) {}

    const pdfDoc = generateExchangeInvoicePDF(enrichedOrder, sellerId, {
      platformSetting: platformSettings,
      companyName: platformSettings.companyName,
      companyAddress: platformSettings.companyAddress,
      companyGstin: platformSettings.companyGstin
    });
    pdfDoc.pipe(res);
  } catch (error) {
    console.error("Seller exchange invoice download error:", error);
    res.status(500).json({ message: "Failed to generate seller exchange invoice", error: error.message });
  }
};
