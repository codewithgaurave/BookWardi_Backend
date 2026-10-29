import Order, { generateProductOrderId } from "../models/Order.js";
import Product from "../models/Product.js";
import Kit from "../models/Kit.js";
import User from "../models/User.js";
import Seller from "../models/Seller.js";
import Coupon from "../models/Coupon.js";
import SellerOffer from "../models/SellerOffer.js";
import PlatformSetting from "../models/PlatformSetting.js";
import Cart from "../models/Cart.js";
import mongoose from "mongoose";
import { sendDeliveryPartnerWhatsAppDispatch } from "../services/whatsappService.js";
import { broadcastRealtimeEvent } from "../services/realtimeService.js";
import { calculateSellerSettlement, calculateSettlementMaturity, reconcileSellerSettlementBalances, isGstExempted } from "../services/settlementService.js";
import { 
  sendFast2SmsOrderPlaced,
  sendFast2SmsOrderConfirmation, 
  sendFast2SmsSellerNewOrder,
  sendFast2SmsOtp,
  sendFast2SmsOrderShippedWithTracking,
  sendFast2SmsOrderShipped,
  sendFast2SmsOutForDelivery,
  sendFast2SmsOrderDelivered,
  sendFast2SmsOrderCancelled,
  sendFast2SmsRefundInitiated,
  sendFast2SmsReturnApproved,
  sendFast2SmsRefundProcessed,
  sendFast2SmsExchangeOtp,
  sendFast2SmsReturnOtp,
  sendOrderStatusSms
} from "../services/smsService.js";
import { saveBase64ToFile } from "./sellerAuthController.js";
import { getSellerInvoicePrefix, formatSellerInvoiceNumber, formatSellerCreditNoteNumber, getSellerCreditNoteNumber } from "../utils/invoiceHelper.js";

// Global in-memory cache for ultra-fast order retrieval
let adminOrdersCache = null;
let adminOrdersCacheTime = 0;
const ORDER_CACHE_TTL_MS = 45 * 1000; // 45 seconds TTL

// Metadata caches for fast order enrichment
const sellerMetaCache = new Map();
const productMetaCache = new Map();
const META_CACHE_TTL_MS = 120 * 1000; // 2 minutes

export const invalidateOrdersCache = () => {
  adminOrdersCache = null;
  adminOrdersCacheTime = 0;
  sellerMetaCache.clear();
  productMetaCache.clear();
  if (global.__invalidateSellerOrdersCache) {
    try {
      global.__invalidateSellerOrdersCache();
    } catch {}
  }
};
global.__invalidateAdminOrdersCache = invalidateOrdersCache;


// Helper to locate user document by ID, email, or phone
const findUserByIdentifier = async (req) => {
  const userId = req.user?.id || req.user?._id || req.body?.userId;
  const userPhone = req.user?.phone || req.headers?.["x-user-phone"] || req.body?.userPhone || req.body?.phone || req.body?.customer?.phone;
  const userEmail = req.user?.email || req.body?.userEmail || req.body?.email || req.body?.customer?.email;

  const query = [];
  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    query.push({ _id: userId });
  }
  if (userPhone) {
    const cleanPhone = String(userPhone).replace(/\D/g, "");
    if (cleanPhone.length >= 10) {
      query.push({ phone: { $regex: cleanPhone.slice(-10) + "$" } });
    } else {
      query.push({ phone: String(userPhone).trim() });
    }
  }
  if (userEmail) {
    query.push({ email: String(userEmail).toLowerCase().trim() });
  }

  if (query.length === 0) return null;
  return await User.findOne({ $or: query });
};

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

// Canonical milestone ranks in standard fulfillment lifecycle:
export const STAGE_RANK = {
  pending: 0,
  placed: 0,
  confirmed: 1,
  processing: 2,
  packed: 3,
  shipped: 4,
  in_transit: 4,
  out_for_delivery: 5,
  delivered: 6,
  completed: 6,
  return_requested: 6,
  return_approved: 6,
  return_rejected: 6,
  pickup_scheduled: 6,
  product_received: 6,
  product_return_received: 6,
  refund_requested: 6,
  refund_approved: 6,
  refund_initiated: 6,
  refund_completed: 6,
  refunded: 6,
  exchange_requested: 6,
  exchange_approved: 6,
  exchange_rejected: 6,
  exchange_dispatched: 6,
  exchanged: 6
};

export const RANK_TO_STATUS = [
  "Pending",          // 0
  "Confirmed",        // 1
  "Processing",       // 2
  "Packed",           // 3
  "Shipped",          // 4
  "Out for Delivery", // 5
  "Delivered"         // 6
];

// Calculate Overall Order Status across all items in a multi-product order
export const calculateOverallOrderStatus = (items = [], orderContext = null) => {
  if (!Array.isArray(items) || items.length === 0) {
    if (orderContext?.returnRequest && orderContext.returnRequest.type && !['none', 'no_request', ''].includes(String(orderContext.returnRequest.status).toLowerCase())) {
      return normalizeOrderStatus(orderContext.returnRequest.status, orderContext);
    }
    return "Pending";
  }

  // Active items are items that have not been cancelled
  const nonCancelledItems = items.filter(it => {
    const s = String(it.status || '').toLowerCase().trim();
    return s !== 'cancelled' && s !== 'canceled';
  });

  if (nonCancelledItems.length === 0) {
    return "Cancelled";
  }

  const normalizedStatuses = nonCancelledItems.map(it => {
    return normalizeOrderStatus(it.status || 'Pending', orderContext);
  });

  // If any active item is in return/exchange/refund governance, preserve that governance status!
  const isGovernanceStatus = (s) => {
    if (!s) return false;
    const low = String(s).toLowerCase().trim().replace(/[\s-]+/g, '_');
    return (
      low.startsWith('return') ||
      low.startsWith('refund') ||
      low.startsWith('exchange') ||
      low === 'exchanged' ||
      low === 'product_received' ||
      low === 'product_return_received' ||
      low === 'pickup_scheduled'
    );
  };

  const governanceItem = normalizedStatuses.find(isGovernanceStatus);
  if (governanceItem) {
    return governanceItem;
  }

  // If order context has an active return request, prioritize it
  if (orderContext?.returnRequest && orderContext.returnRequest.type) {
    const reqStatus = String(orderContext.returnRequest.status || '').toLowerCase().trim();
    if (reqStatus && !['none', 'no_request', 'normal', ''].includes(reqStatus)) {
      return normalizeOrderStatus(reqStatus, orderContext);
    }
  }

  // If all active items share the exact same status
  const firstStatus = normalizedStatuses[0];
  const allSame = normalizedStatuses.every(s => s.toLowerCase() === firstStatus.toLowerCase());
  if (allSame) {
    return firstStatus;
  }

  // Determine lowest milestone rank reached/passed by all active products
  const ranks = nonCancelledItems.map(it => {
    const key = String(it.status || 'Pending').toLowerCase().trim().replace(/[\s-]+/g, '_');
    return STAGE_RANK[key] !== undefined ? STAGE_RANK[key] : 0;
  });

  const minRank = Math.min(...ranks);
  return RANK_TO_STATUS[minRank] || "Pending";
};

// Helper to safely locate an Order document by Mongo _id, orderId, custom id, or SC- format
export const findOrderById = async (searchId) => {
  if (!searchId) return null;
  const cleanId = String(searchId).trim().replace(/^#+/, '');
  const isMongoId = mongoose.Types.ObjectId.isValid(cleanId);
  const query = isMongoId
    ? { $or: [{ _id: cleanId }, { orderId: cleanId }, { id: cleanId }] }
    : { $or: [{ orderId: cleanId }, { id: cleanId }] };

  try {
    let order = await Order.findOne(query);
    if (order) return order;

    // Case-insensitive exact string match
    const escapedClean = cleanId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    order = await Order.findOne({
      $or: [
        { orderId: new RegExp(`^${escapedClean}$`, 'i') },
        { id: new RegExp(`^${escapedClean}$`, 'i') }
      ]
    });
    if (order) return order;

    // Digits extraction for SC-XXXX codes or numeric identifiers
    const digits = cleanId.replace(/\D/g, '');
    if (digits) {
      order = await Order.findOne({
        $or: [
          { orderId: new RegExp(digits, 'i') },
          { id: new RegExp(digits, 'i') }
        ]
      });
      if (order) return order;

      // Dynamic SC- code matching fallback
      const numCode = parseInt(digits, 10);
      if (!isNaN(numCode)) {
        const candidateOrders = await Order.find().sort({ createdAt: -1 }).limit(500);
        const match = candidateOrders.find(o => {
          const derivedNum = (parseInt(String(o._id || '').slice(-4), 16) % 9000) + 1000;
          return derivedNum === numCode;
        });
        if (match) {
          const rawOrderId = `SC-${numCode}`;
          Order.updateOne({ _id: match._id }, { $set: { orderId: rawOrderId, id: rawOrderId } }).exec().catch(() => {});
          return match;
        }
      }
    }

    return null;
  } catch (err) {
    console.error("Error in findOrderById:", err);
    return null;
  }
};

// Helper to safely locate a Product document without throwing CastError on non-ObjectId search IDs
const findProductByIdOrCustomId = async (searchId) => {
  if (!searchId) return null;
  try {
    if (mongoose.Types.ObjectId.isValid(searchId)) {
      const prod = await Product.findById(searchId);
      if (prod) return prod;
    }
    return await Product.findOne({ id: searchId });
  } catch (err) {
    return null;
  }
};

// Helper to safely locate a Kit document without throwing CastError on non-ObjectId search IDs
const findKitByIdOrCustomId = async (searchId) => {
  if (!searchId) return null;
  try {
    if (mongoose.Types.ObjectId.isValid(searchId)) {
      const kit = await Kit.findById(searchId);
      if (kit) return kit;
    }
    return await Kit.findOne({ id: searchId });
  } catch (err) {
    return null;
  }
};

export const isPlaceholderCust = (str) => {
  if (!str || typeof str !== 'string') return true;
  const s = str.trim().toLowerCase();
  return (
    s === '' ||
    s === 'student' ||
    s === 'student customer' ||
    s === 'customer' ||
    s === 'valued customer' ||
    s === 'verified customer' ||
    s === 'test student' ||
    s === 'avatar upload tester' ||
    s === 'user' ||
    s === 'null' ||
    s === 'undefined' ||
    s === 'n/a'
  );
};

export const isPlaceholderSeller = (str) => {
  if (!str || typeof str !== 'string') return true;
  const s = str.trim().toLowerCase();
  return (
    s === '' ||
    s.includes(',') || // Multi-seller / composite strings are not a single valid store name
    s === 'bookvardi verified seller hub' ||
    s === 'bookvardi verified seller' ||
    s === 'bookvardimerchant' ||
    s === 'bookvardi merchant' ||
    s === 'book vardi partner merchant' ||
    s === 'book vardi partner store' ||
    s === 'verified seller' ||
    s === 'other verified seller' ||
    s === 'partner merchant' ||
    s === 'unknown seller' ||
    s === 'new merchant' ||
    s === 'merchant store' ||
    s === 'direct marketplace' ||
    s === 'seller' ||
    s === 'merchant' ||
    s === 'partner' ||
    s === 'n/a' ||
    s === 'null' ||
    s === 'undefined'
  );
};

// Helper to safely decrement stock and size variant stock for a product or kit on order placement
const decrementItemStock = async (item) => {
  const qty = Math.max(0.01, Math.round((Number(item.quantity) || 1) * 100) / 100);
  const searchId = item.productId || item.id || item._id;
  const itemSize = String(item.size || item.selectedSize || "").trim();

  let prod = await findProductByIdOrCustomId(searchId);
  if (!prod && item.name) {
    const cleanItemName = item.name.replace(/\s*\([^)]*\)/g, "").trim();
    prod = await Product.findOne({
      name: { $regex: new RegExp(cleanItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }
    });
  }

  if (prod) {
    // 1. Decrement top level stock floor at 0
    const currentStock = Number(prod.stockQuantity ?? prod.stock ?? 0);
    const newStock = Math.max(0, Math.round((currentStock - qty) * 100) / 100);
    prod.stock = newStock;
    prod.stockQuantity = newStock;

    // 2. Decrement sizeVariants stock if size specified
    if (itemSize && Array.isArray(prod.sizeVariants) && prod.sizeVariants.length > 0) {
      const variant = prod.sizeVariants.find(
        (v) => String(v.size || v.measureValue || "").trim().toLowerCase() === itemSize.toLowerCase()
      );
      if (variant) {
        const vStock = Number(variant.stockQuantity ?? variant.stock ?? 0);
        const vNewStock = Math.max(0, Math.round((vStock - qty) * 100) / 100);
        variant.stock = vNewStock;
        variant.stockQuantity = vNewStock;
      }
    }

    // 3. Update out-of-stock status if stock reaches 0
    if (prod.stock <= 0) {
      prod.status = "out-of-stock";
      prod.inStock = false;
    }

    await prod.save();
    return;
  }

  // Also handle Kit document stock (only if not a regular Product)
  let kit = await findKitByIdOrCustomId(searchId);
  if (!kit && item.name) {
    const cleanItemName = item.name.replace(/\s*\([^)]*\)/g, "").trim();
    kit = await Kit.findOne({
      title: { $regex: new RegExp(cleanItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }
    });
  }

  if (kit) {
    kit.stock = Math.max(0, (Number(kit.stock) || 0) - qty);
    await kit.save();
  }
};

// Helper to safely restore stock and size variant stock on order cancellation or product return
const incrementItemStock = async (item) => {
  const qty = Math.max(0.01, Math.round((Number(item.quantity) || 1) * 100) / 100);
  const searchId = item.productId || item.id || item._id;
  const itemSize = String(item.size || item.selectedSize || "").trim();

  let prod = await findProductByIdOrCustomId(searchId);
  if (!prod && item.name) {
    const cleanItemName = item.name.replace(/\s*\([^)]*\)/g, "").trim();
    prod = await Product.findOne({
      name: { $regex: new RegExp(cleanItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }
    });
  }

  if (prod) {
    // 1. Restore top level stock
    const currentStock = Number(prod.stockQuantity ?? prod.stock ?? 0);
    const newStock = currentStock + qty;
    prod.stock = newStock;
    prod.stockQuantity = newStock;

    // 2. Restore sizeVariants stock if size specified
    if (itemSize && Array.isArray(prod.sizeVariants) && prod.sizeVariants.length > 0) {
      const variant = prod.sizeVariants.find(
        (v) => String(v.size || v.measureValue || "").trim().toLowerCase() === itemSize.toLowerCase()
      );
      if (variant) {
        const vStock = Number(variant.stockQuantity ?? variant.stock ?? 0);
        const vNewStock = vStock + qty;
        variant.stock = vNewStock;
        variant.stockQuantity = vNewStock;
      }
    }

    // 3. Reset status to active if stock > 0
    if (prod.stock > 0) {
      if (prod.status === "out-of-stock") prod.status = "active";
      prod.inStock = true;
    }

    await prod.save();
  }

  // Also handle Kit document stock
  let kit = await findKitByIdOrCustomId(searchId);
  if (!kit && item.name) {
    const cleanItemName = item.name.replace(/\s*\([^)]*\)/g, "").trim();
    kit = await Kit.findOne({
      title: { $regex: new RegExp(cleanItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }
    });
  }

  if (kit) {
    kit.stock = (Number(kit.stock) || 0) + qty;
    await kit.save();
  }
};

// Helper to enrich orders with real seller and real consumer details
export const enrichOrdersWithSellerAndConsumer = async (orders) => {
  if (!orders) return orders;
  const isArray = Array.isArray(orders);
  const orderList = isArray ? orders : [orders];
  if (orderList.length === 0) return orders;

  try {
    const sellerIds = new Set();
    const userIds = new Set();
    const productIds = new Set();
    const userMap = new Map();
    orderList.forEach(ord => {
      if (ord.userId) {
        if (typeof ord.userId === "object" && ord.userId._id && ord.userId.name) {
          userMap.set(ord.userId._id.toString(), ord.userId);
        } else {
          const uId = ord.userId._id ? ord.userId._id.toString() : ord.userId.toString();
          if (mongoose.Types.ObjectId.isValid(uId)) userIds.add(uId);
        }
      }
      if (ord.sellerDetails?.sellerId) {
        const sId = ord.sellerDetails.sellerId.toString();
        if (mongoose.Types.ObjectId.isValid(sId)) sellerIds.add(sId);
      }
      (ord.items || []).forEach(item => {
        if (item.sellerId) {
          const sId = item.sellerId._id ? item.sellerId._id.toString() : item.sellerId.toString();
          if (mongoose.Types.ObjectId.isValid(sId)) sellerIds.add(sId);
        }
        const rawPId = item.productId || item.id || item._id;
        if (rawPId) {
          const pId = rawPId._id ? rawPId._id.toString() : rawPId.toString();
          if (mongoose.Types.ObjectId.isValid(pId)) productIds.add(pId);
        }
      });
    });

    const now = Date.now();
    const sellerMap = new Map();
    const productMap = new Map();

    const neededSellerIds = [];
    sellerIds.forEach(id => {
      const cached = sellerMetaCache.get(id);
      if (cached && (now - cached.timestamp < META_CACHE_TTL_MS)) {
        sellerMap.set(id, cached.data);
      } else {
        neededSellerIds.push(id);
      }
    });

    const neededProductIds = [];
    productIds.forEach(id => {
      const cached = productMetaCache.get(id);
      if (cached && (now - cached.timestamp < META_CACHE_TTL_MS)) {
        productMap.set(id, cached.data);
      } else {
        neededProductIds.push(id);
      }
    });

    const unpopulatedUserIds = Array.from(userIds).filter(id => !userMap.has(id));

    const [sellers, users, prods] = await Promise.all([
      neededSellerIds.length > 0 
        ? Seller.find({ _id: { $in: neededSellerIds } }).lean()
        : [],
      unpopulatedUserIds.length > 0 
        ? User.find({ _id: { $in: unpopulatedUserIds } }).lean()
        : [],
      neededProductIds.length > 0 
        ? Product.find({ _id: { $in: neededProductIds } }).select("_id sellerId sellerStoreName storeName unit isMeterBased minMeter meterStep subCategory category name returnPolicy isReturnable isExchangeable isRefundable returnWindowDays").lean()
        : []
    ]);

    sellers.forEach(s => {
      const formatted = {
        sellerId: s._id,
        storeName: s.storeName || s.name,
        sellerName: s.name || s.storeName,
        name: s.name,
        phone: s.phone || "",
        email: s.email || "",
        address: s.address || "",
        city: s.city || "",
        state: s.state || "",
        pincode: s.pincode || "",
        gstNumber: s.gstNumber || "",
        commissionRate: s.commissionRate ?? s.commissionPercentage ?? 10,
        commissionPercentage: s.commissionPercentage ?? s.commissionRate ?? 10
      };
      sellerMap.set(s._id.toString(), formatted);
      sellerMetaCache.set(s._id.toString(), { data: formatted, timestamp: now });
    });

    users.forEach(u => userMap.set(u._id.toString(), u));

    const missingSellerIds = new Set();
    prods.forEach(p => {
      productMap.set(p._id.toString(), p);
      productMetaCache.set(p._id.toString(), { data: p, timestamp: now });
      if (p.sellerId && !sellerMap.has(p.sellerId.toString())) {
        missingSellerIds.add(p.sellerId.toString());
      }
    });

    // Check User collection for seller IDs that might be users
    const remainingSellerIds = Array.from(sellerIds).filter(id => !sellerMap.has(id));
    if (remainingSellerIds.length > 0) {
      const sellerUsers = await User.find({ _id: { $in: remainingSellerIds } }).lean();
      sellerUsers.forEach(u => {
        sellerMap.set(u._id.toString(), {
          sellerId: u._id,
          storeName: u.storeName || u.name,
          sellerName: u.name || u.storeName,
          name: u.name,
          phone: u.phone || "",
          email: u.email || "",
          address: u.address || "",
          city: u.city || "",
          state: u.state || "",
          pincode: u.pincode || "",
          gstNumber: "",
          commissionRate: u.commissionRate ?? u.commissionPercentage ?? 10,
          commissionPercentage: u.commissionPercentage ?? u.commissionRate ?? 10
        });
      });
    }

    // Fetch any newly discovered sellerIds from products
    if (missingSellerIds.size > 0) {
      const extraSellers = await Seller.find({ _id: { $in: Array.from(missingSellerIds) } }).lean();
      extraSellers.forEach(s => {
        sellerMap.set(s._id.toString(), {
          sellerId: s._id,
          storeName: s.storeName || s.name,
          sellerName: s.name || s.storeName,
          name: s.name,
          phone: s.phone || "",
          email: s.email || "",
          address: s.address || "",
          city: s.city || "",
          state: s.state || "",
          pincode: s.pincode || "",
          gstNumber: s.gstNumber || "",
          commissionRate: s.commissionRate ?? s.commissionPercentage ?? 10,
          commissionPercentage: s.commissionPercentage ?? s.commissionRate ?? 10
        });
      });
    }

    orderList.forEach(ord => {
      const uId = ord.userId ? (ord.userId._id ? ord.userId._id.toString() : ord.userId.toString()) : null;
      const userDoc = uId ? userMap.get(uId) : null;
      const rawAddr = (ord.shippingAddress && typeof ord.shippingAddress === 'object') ? ord.shippingAddress : {};

      // 1. Resolve Consumer Details
      const candNames = [
        rawAddr.name,
        rawAddr.fullName,
        rawAddr.recipientName,
        userDoc?.name,
        ord.customer?.name,
        ord.customerName
      ].filter(n => n && !isPlaceholderCust(n));

      const realName = candNames[0] || (userDoc && !isPlaceholderCust(userDoc.name) ? userDoc.name : "Verified Consumer");

      const realPhone = rawAddr.phone || rawAddr.mobile || ord.customer?.phone || userDoc?.phone || ord.phone || "";
      const realEmail = ord.customer?.email || rawAddr.email || userDoc?.email || ord.email || "";

      // Hydrate address from user profile if order shipping address is missing
      if (!rawAddr.street && !rawAddr.addressLine && userDoc?.addresses && userDoc.addresses.length > 0) {
        const uAddr = userDoc.addresses.find(a => a.isDefault) || userDoc.addresses[0];
        if (uAddr) {
          rawAddr.name = rawAddr.name || uAddr.name || realName;
          rawAddr.phone = rawAddr.phone || uAddr.phone || realPhone;
          rawAddr.addressLine = uAddr.addressLine || uAddr.street;
          rawAddr.street = uAddr.street || uAddr.addressLine;
          rawAddr.city = uAddr.city;
          rawAddr.state = uAddr.state;
          rawAddr.pincode = uAddr.pincode;
          rawAddr.landmark = uAddr.landmark;
          ord.shippingAddress = rawAddr;
          ord.address = [uAddr.addressLine, uAddr.street, uAddr.city, uAddr.state].filter(Boolean).join(', ') + (uAddr.pincode ? ` - ${uAddr.pincode}` : '');
        }
      }

      if (!ord.customer) ord.customer = {};
      ord.customer.name = realName;
      if (realPhone) ord.customer.phone = realPhone;
      if (realEmail) ord.customer.email = realEmail;

      ord.customerName = realName;
      ord.customerPhone = realPhone;
      ord.customerEmail = realEmail;

      // 2. Resolve Seller Details (prioritizing sellers of confirmed items)
      let primarySellerDetails = null;
      let primarySellerIsConfirmed = false;

      (ord.items || []).forEach(item => {
        const sId = item.sellerId ? (item.sellerId._id ? item.sellerId._id.toString() : item.sellerId.toString()) : null;
        let matchedSeller = sId ? sellerMap.get(sId) : null;

        const rawPId = item.productId || item.id || item._id;
        const itemPId = rawPId ? (rawPId._id ? rawPId._id.toString() : rawPId.toString()) : null;
        const pDoc = itemPId ? productMap.get(itemPId) : null;

        if (pDoc) {
          item.isReturnable = (pDoc.returnPolicy === 'non_returnable' || pDoc.isReturnable === false) ? false : (item.isReturnable ?? pDoc.isReturnable ?? true);
          item.isExchangeable = (pDoc.returnPolicy === 'non_returnable' || pDoc.isExchangeable === false) ? false : (item.isExchangeable ?? pDoc.isExchangeable ?? true);
          item.isRefundable = (pDoc.returnPolicy === 'non_returnable' || pDoc.isRefundable === false) ? false : (item.isRefundable ?? pDoc.isRefundable ?? true);
          item.returnWindowDays = item.returnWindowDays || pDoc.returnWindowDays || 7;
          item.returnPolicy = item.returnPolicy || pDoc.returnPolicy || ((item.isReturnable === false && item.isExchangeable === false) ? 'non_returnable' : '');
          if (pDoc.unit) item.unit = item.unit || pDoc.unit;
          if (pDoc.isMeterBased !== undefined) item.isMeterBased = item.isMeterBased ?? pDoc.isMeterBased;
          if (pDoc.minMeter) item.minMeter = item.minMeter || pDoc.minMeter;
          if (pDoc.meterStep) item.meterStep = item.meterStep || pDoc.meterStep;
          if (pDoc.subCategory && !item.subCategory) item.subCategory = pDoc.subCategory;
        }

        const candMeterStr = [
          item.category,
          pDoc?.category,
          item.subCategory,
          pDoc?.subCategory,
          item.name,
          pDoc?.name,
          item.unit,
          pDoc?.unit
        ].filter(Boolean).join(' ').toLowerCase();

        const isMeter = Boolean(
          item.isMeterBased ||
          pDoc?.isMeterBased ||
          item.unit === 'meter' ||
          item.unit === 'm' ||
          item.unit === 'mtr' ||
          pDoc?.unit === 'meter' ||
          pDoc?.unit === 'm' ||
          pDoc?.unit === 'mtr' ||
          candMeterStr.includes('unstitched') ||
          candMeterStr.includes('unstiched') ||
          candMeterStr.includes('cloth') ||
          candMeterStr.includes('fabric') ||
          candMeterStr.includes('shirting') ||
          candMeterStr.includes('suiting') ||
          candMeterStr.includes('kapda') ||
          candMeterStr.includes('than') ||
          candMeterStr.includes('dress material') ||
          (Number(item.quantity) % 1 !== 0)
        );

        if (isMeter) {
          item.isMeterBased = true;
          item.unit = 'meter';
          item.minMeter = Number(pDoc?.minMeter || item.minMeter || 0.5);
          item.meterStep = Number(pDoc?.meterStep || item.meterStep || 0.5);
        }

        if (!matchedSeller && pDoc) {
          const pSellerId = pDoc.sellerId ? pDoc.sellerId.toString() : null;
            if (pSellerId && sellerMap.has(pSellerId)) {
              matchedSeller = sellerMap.get(pSellerId);
            } else if (pDoc.sellerStoreName || pDoc.storeName) {
              matchedSeller = {
                sellerId: pDoc.sellerId,
                storeName: pDoc.sellerStoreName || pDoc.storeName,
                sellerName: pDoc.sellerName || pDoc.sellerStoreName || pDoc.storeName,
                name: pDoc.sellerName || "",
                phone: "",
                email: "",
                address: "",
                city: "",
                state: "",
                pincode: "",
                gstNumber: ""
              };
            }
          }

        const itemStatusStr = String(item.status || ord.status || ord.overallStatus || '').toLowerCase().trim();
        const isItemConfirmed = itemStatusStr && !['pending', 'placed', 'unconfirmed', 'draft', ''].includes(itemStatusStr);

        if (matchedSeller) {
          item.sellerId = matchedSeller;
          item.sellerName = matchedSeller.storeName || matchedSeller.name;
          item.storeName = matchedSeller.storeName || matchedSeller.name;
          item.sellerStoreName = matchedSeller.storeName || matchedSeller.name;
          item.sellerPhone = matchedSeller.phone;
          item.sellerEmail = matchedSeller.email;
          item.sellerAddress = matchedSeller.address;
          item.sellerCity = matchedSeller.city;
          item.sellerState = matchedSeller.state;
          item.sellerDetails = matchedSeller;
          if (matchedSeller.commissionRate !== undefined && matchedSeller.commissionRate !== null) {
            item.commissionRate = matchedSeller.commissionRate;
            item.sellerCommissionRate = matchedSeller.commissionRate;
            item.commissionPercentage = matchedSeller.commissionRate;
          }
          if (!primarySellerDetails || (!primarySellerIsConfirmed && isItemConfirmed)) {
            primarySellerDetails = matchedSeller;
            if (isItemConfirmed) primarySellerIsConfirmed = true;
          }
        } else if (item.sellerDetails && !isPlaceholderSeller(item.sellerDetails.storeName)) {
          if (!primarySellerDetails || (!primarySellerIsConfirmed && isItemConfirmed)) {
            primarySellerDetails = item.sellerDetails;
            if (isItemConfirmed) primarySellerIsConfirmed = true;
          }
        } else if (!isPlaceholderSeller(item.sellerStoreName || item.sellerName || item.storeName)) {
          const sName = item.sellerStoreName || item.sellerName || item.storeName;
          if (!primarySellerDetails || (!primarySellerIsConfirmed && isItemConfirmed)) {
            primarySellerDetails = {
              storeName: sName,
              sellerName: sName,
              phone: item.sellerPhone || "",
              city: item.sellerCity || ""
            };
            if (isItemConfirmed) primarySellerIsConfirmed = true;
          }
        }
      });

      if (primarySellerDetails) {
        if (!ord.sellerDetails || isPlaceholderSeller(ord.sellerDetails.storeName)) {
          ord.sellerDetails = primarySellerDetails;
        } else {
          ord.sellerDetails.state = ord.sellerDetails.state || primarySellerDetails.state || "";
          ord.sellerDetails.city = ord.sellerDetails.city || primarySellerDetails.city || "";
          ord.sellerDetails.pincode = ord.sellerDetails.pincode || primarySellerDetails.pincode || "";
          ord.sellerDetails.gstNumber = ord.sellerDetails.gstNumber || primarySellerDetails.gstNumber || "";
          ord.sellerDetails.address = ord.sellerDetails.address || primarySellerDetails.address || "";
        }
        ord.sellerName = primarySellerDetails.storeName || primarySellerDetails.sellerName;
        ord.sellerStoreName = primarySellerDetails.storeName || primarySellerDetails.sellerName;
        ord.storeName = primarySellerDetails.storeName || primarySellerDetails.sellerName;
        if (primarySellerDetails.commissionRate !== undefined && primarySellerDetails.commissionRate !== null) {
          ord.commissionRate = primarySellerDetails.commissionRate;
          ord.sellerCommissionRate = primarySellerDetails.commissionRate;
          ord.commissionPercentage = primarySellerDetails.commissionRate;
        }
        ord.sellerPhone = primarySellerDetails.phone || ord.sellerPhone || "";
        ord.sellerCity = primarySellerDetails.city || ord.sellerCity || "";
        ord.sellerState = primarySellerDetails.state || ord.sellerState || "";
        ord.sellerPincode = primarySellerDetails.pincode || ord.sellerPincode || "";
        ord.sellerGst = primarySellerDetails.gstNumber || ord.sellerGst || "";
      }

      // Canonicalize status across overall order and individual items
      ord.overallStatus = normalizeOrderStatus(ord.overallStatus || ord.status);
      ord.status = ord.overallStatus;
      if (ord.items && Array.isArray(ord.items)) {
        ord.items.forEach(item => {
          item.status = normalizeOrderStatus(item.status || ord.overallStatus);
        });
      }

      // Ensure seller sequential invoice number is set
      if (!ord.invoiceNumber || ord.invoiceNumber.startsWith("INV-")) {
        const storeNameCand = ord.sellerStoreName || ord.storeName || ord.sellerDetails?.storeName || ord.items?.[0]?.storeName || "Store";
        const prefix = getSellerInvoicePrefix(storeNameCand);
        const seq = ord.sellerSequence || 1;
        ord.invoiceNumber = formatSellerInvoiceNumber(prefix, seq);
        ord.sellerInvoiceNo = ord.invoiceNumber;
      }

      // Security: Strip raw deliveryOtp so OTP numbers are never exposed in any API response
      ord.deliveryOtp = "";
      if (ord.selfDeliveryDetails) {
        delete ord.selfDeliveryDetails.deliveryOtp;
        delete ord.selfDeliveryDetails.otp;
      }
      if (ord.items && Array.isArray(ord.items)) {
        ord.items.forEach(item => {
          item.deliveryOtp = "";
          if (item.selfDeliveryDetails) {
            delete item.selfDeliveryDetails.deliveryOtp;
            delete item.selfDeliveryDetails.otp;
          }
        });
      }
    });

  } catch (err) {
    console.warn("⚠️ [enrichOrdersWithSellerAndConsumer] Error:", err.message);
  }

  return isArray ? orderList : orderList[0];
};

// 1. Get all orders (Admin / General) - Paginated & Lean with Ultra-Fast In-Memory Cache
export const getOrders = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 100));
    const skip = (page - 1) * limit;

    const isDefaultFetch = page === 1 && limit >= 50;
    const now = Date.now();
    if (isDefaultFetch && adminOrdersCache && (now - adminOrdersCacheTime < ORDER_CACHE_TTL_MS)) {
      return res.json(adminOrdersCache);
    }

    const orders = await Order.find()
      .populate("userId", "name email phone addresses")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    const enrichedOrders = await enrichOrdersWithSellerAndConsumer(orders);

    if (isDefaultFetch) {
      adminOrdersCache = enrichedOrders;
      adminOrdersCacheTime = Date.now();
    }

    res.json(enrichedOrders);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch orders", error: error.message });
  }
};

// 2. Get User's Own Orders
export const getMyOrders = async (req, res) => {
  try {
    const user = await findUserByIdentifier(req);
    const userPhone = req.headers["x-user-phone"] || req.query.phone || req.query.userPhone || user?.phone;
    const userEmail = req.query.email || req.query.userEmail || user?.email;
    const userExplicitId = req.query.userId || req.headers["x-user-id"] || req.user?.id || user?._id;

    const query = [];
    if (user && user._id) {
      query.push({ userId: user._id });
      query.push({ userId: String(user._id) });
    }
    if (req.user && req.user.id) {
      query.push({ userId: req.user.id });
      query.push({ userId: String(req.user.id) });
    }
    if (userExplicitId) {
      query.push({ userId: String(userExplicitId) });
      if (mongoose.Types.ObjectId.isValid(userExplicitId)) {
        query.push({ userId: new mongoose.Types.ObjectId(userExplicitId) });
      }
    }
    if (userPhone) {
      const cleanPhone = String(userPhone).replace(/\D/g, "");
      if (cleanPhone.length >= 10) {
        const last10 = cleanPhone.slice(-10);
        query.push({ "customer.phone": { $regex: last10 + "$" } });
        query.push({ "shippingAddress.phone": { $regex: last10 + "$" } });
      } else {
        query.push({ "customer.phone": String(userPhone).trim() });
      }
    }
    if (userEmail && String(userEmail).trim()) {
      query.push({ "customer.email": String(userEmail).toLowerCase().trim() });
    }

    let orders = [];
    if (query.length > 0) {
      orders = await Order.find({ $or: query }).sort({ createdAt: -1 }).lean();
      await enrichOrdersWithSellerAndConsumer(orders);
    }

    const formattedOrders = orders.map((ord) => {
      const canonicalStatus = normalizeOrderStatus(ord.overallStatus || ord.status || 'Processing');
      const isSelfDelivery = ord.deliveryMode === 'self_delivery' ||
        Boolean(ord.selfDeliveryDetails?.deliveryPersonName || ord.selfDeliveryDetails?.deliveryPartnerToken) ||
        ord.items?.some(it => (it.deliveryType === 'self' || it.deliveryType === 'self_delivery') && Boolean(it.selfDeliveryDetails?.deliveryPersonName || it.selfDeliveryDetails?.deliveryPartnerToken));

      const isThirdParty = ord.deliveryMode === 'third_party' ||
        Boolean(!isSelfDelivery && ord.courierName && ord.courierName !== 'N/A' && ord.courierName !== '');

      const resolvedDeliveryMode = isSelfDelivery ? 'self_delivery' : (isThirdParty ? 'third_party' : 'pending_choice');

      const firstItem = ord.items?.[0] || {};
      const resolvedSellerDetails = ord.sellerDetails && ord.sellerDetails.storeName ? ord.sellerDetails : (firstItem.sellerDetails || {
        sellerId: firstItem.sellerId || ord.sellerId,
        storeName: firstItem.storeName || firstItem.sellerName || "Partner Merchant",
        sellerName: firstItem.sellerName || firstItem.storeName || "Partner Merchant",
        phone: firstItem.sellerPhone || ord.sellerPhone || "",
        email: firstItem.sellerEmail || ord.sellerEmail || "",
        address: firstItem.sellerAddress || ord.sellerAddress || "",
        city: firstItem.sellerCity || ord.sellerCity || ""
      });

      const sanitizeSelfDelivery = (sd, parentOtp) => {
        if (!sd) return null;
        const copy = typeof sd.toObject === 'function' ? sd.toObject() : { ...sd };
        copy.deliveryOtp = parentOtp || copy.deliveryOtp || "";
        return copy;
      };

      const formattedItems = (ord.items || []).map((it) => {
        const itemSelfDelivery = it.selfDeliveryDetails || ord.selfDeliveryDetails || null;
        const itemThirdParty = it.thirdPartyDetails || {
          courierName: ord.courierName || "",
          trackingNumber: ord.trackingNumber || "",
          trackingUrl: ord.trackingUrl || ""
        };
        const itemSellerDetails = it.sellerDetails || {
          sellerId: it.sellerId,
          storeName: it.storeName || it.sellerName || resolvedSellerDetails.storeName,
          sellerName: it.sellerName || it.storeName || resolvedSellerDetails.sellerName,
          phone: it.sellerPhone || resolvedSellerDetails.phone || "",
          email: it.sellerEmail || resolvedSellerDetails.email || "",
          address: it.sellerAddress || resolvedSellerDetails.address || "",
          city: it.sellerCity || resolvedSellerDetails.city || ""
        };

        const itemPrice = Math.round((Number(it.price !== undefined ? it.price : (it.finalPrice || 0))) * 100) / 100;
        const itemOriginalPrice = Math.round((Number(it.originalPrice || it.price || it.finalPrice || 0)) * 100) / 100;
        const itemFinalPrice = Math.round((Number(it.finalPrice !== undefined ? it.finalPrice : (it.price || 0))) * 100) / 100;
        const itemOfferDiscount = Math.round((Number(it.offerDiscount || it.discount || 0)) * 100) / 100;
        const itemDiscount = Math.round((Number(it.discount || it.offerDiscount || 0)) * 100) / 100;
        const itemQuantity = Math.round((Number(it.quantity) || 1) * 100) / 100;
        const itemTotal = it.total !== undefined ? Number(it.total) : Math.round((itemFinalPrice * itemQuantity) * 100) / 100;

        return {
          id: it._id || it.id,
          _id: it._id || it.id,
          productId: it.productId || it.id || it._id,
          name: it.name,
          price: itemPrice,
          originalPrice: itemOriginalPrice,
          finalPrice: itemFinalPrice,
          offerDiscount: itemOfferDiscount,
          discount: itemDiscount,
          discountPercentage: it.discountPercentage || 0,
          couponCode: it.couponCode || "",
          appliedCoupon: it.appliedCoupon || it.couponCode || "",
          quantity: itemQuantity,
          total: itemTotal,
          taxableAmount: it.taxableAmount,
          gstAmount: it.gstAmount,
          size: it.size || "",
          color: it.color || "",
          image: it.image || "",
          category: it.category || "Stationery",
          unit: it.unit || "piece",
          isMeterBased: Boolean(it.isMeterBased),
          minMeter: it.minMeter,
          meterStep: it.meterStep,
          subCategory: it.subCategory || "",
          gst: it.gst !== undefined ? it.gst : (it.gstRate ?? it.gstPercent ?? 5),
          gstPercent: it.gstPercent !== undefined ? it.gstPercent : (it.gstRate ?? it.gst ?? 5),
          gstPercentage: it.gstPercentage !== undefined ? it.gstPercentage : (it.gstRate ?? it.gst ?? 5),
          gstRate: it.gstRate !== undefined ? it.gstRate : (it.gstPercent ?? it.gst ?? 5),
          isGstInclusive: it.isGstInclusive !== false,
          deliveryType: it.deliveryType || resolvedDeliveryMode || "pending_choice",
          sellerId: it.sellerId,
          sellerName: it.sellerName || itemSellerDetails.sellerName,
          storeName: it.storeName || itemSellerDetails.storeName,
          sellerPhone: it.sellerPhone || itemSellerDetails.phone,
          sellerDetails: itemSellerDetails,
          selfDeliveryDetails: sanitizeSelfDelivery(itemSelfDelivery),
          thirdPartyDetails: itemThirdParty,
          status: normalizeOrderStatus(it.status || canonicalStatus),
          isReturnable: (it.returnPolicy === 'non_returnable' || it.isReturnable === false) ? false : (it.isReturnable ?? true),
          isExchangeable: (it.returnPolicy === 'non_returnable' || it.isExchangeable === false) ? false : (it.isExchangeable ?? true),
          isRefundable: (it.returnPolicy === 'non_returnable' || it.isRefundable === false) ? false : (it.isRefundable ?? true),
          returnWindowDays: it.returnWindowDays || 7,
          returnPolicy: it.returnPolicy || ""
        };
      });

      return {
        id: ord.id || ord.orderId || ord._id,
        orderId: ord.orderId || ord.id || ord._id,
        date: ord.date || new Date(ord.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
        createdAt: ord.createdAt,
        status: canonicalStatus,
        overallStatus: canonicalStatus,
        customer: ord.customer || { name: ord.userName, email: ord.userEmail, phone: ord.userPhone },
        customerName: ord.customer?.name || ord.userName || ord.customerName || '',
        customerEmail: ord.customer?.email || ord.userEmail || ord.customerEmail || '',
        customerPhone: ord.customer?.phone || ord.userPhone || ord.customerPhone || '',
        deliveryMode: resolvedDeliveryMode,
        courierName: resolvedDeliveryMode === 'self_delivery' ? '' : (ord.courierName || ord.carrier || firstItem.thirdPartyDetails?.courierName || ''),
        carrier: resolvedDeliveryMode === 'self_delivery' ? '' : (ord.carrier || ord.courierName || ''),
        trackingNumber: resolvedDeliveryMode === 'self_delivery' ? (ord.selfDeliveryDetails?.deliveryPartnerToken || ord.trackingNumber || '') : (ord.trackingNumber || firstItem.thirdPartyDetails?.trackingNumber || ''),
        trackingUrl: resolvedDeliveryMode === 'self_delivery' ? (ord.selfDeliveryDetails?.trackingUrl || ord.trackingUrl || '') : (ord.trackingUrl || firstItem.thirdPartyDetails?.trackingUrl || ''),
        sellerDetails: resolvedSellerDetails,
        selfDeliveryDetails: resolvedDeliveryMode === 'self_delivery' ? sanitizeSelfDelivery(ord.selfDeliveryDetails || firstItem.selfDeliveryDetails, ord.deliveryOtp) : null,
        deliveryOtp: ord.deliveryOtp || ord.selfDeliveryDetails?.deliveryOtp || "",
        itemsCount: ord.items?.reduce((s, it) => s + (it.quantity || 1), 0) || ord.quantity || 1,
        items: formattedItems,
        subtotal: ord.subtotal || ord.totalAmount || ord.total || 0,
        shippingCost: ord.shippingCost !== undefined ? ord.shippingCost : (ord.shippingFee || 0),
        shippingFee: ord.shippingFee !== undefined ? ord.shippingFee : (ord.shippingCost || 0),
        discount: ord.discount || ord.discountAmount || 0,
        discountAmount: ord.discountAmount || ord.discount || 0,
        couponCode: ord.couponCode || ord.couponDetails?.code || '',
        couponDetails: ord.couponDetails || null,
        appliedCoupon: ord.appliedCoupon || ord.couponCode || '',
        pointsDiscount: ord.pointsDiscount || 0,
        total: ord.total || ord.totalAmount || 0,
        totalAmount: ord.totalAmount || ord.total || 0,
        isGstInclusive: ord.isGstInclusive !== false,
        shippingAddress: ord.shippingAddress || { street: ord.address || '' },
        paymentMethod: ord.paymentMethod || 'UPI',
        paymentStatus: ord.paymentStatus || 'paid',
        razorpayOrderId: ord.razorpayOrderId || '',
        razorpayPaymentId: ord.razorpayPaymentId || '',
        estimatedDelivery: ord.estimatedDelivery || '3-5 Business Days',
        cancellationReason: ord.cancellationReason || '',
        cancelledBy: ord.cancelledBy || '',
        cancelledAt: ord.cancelledAt || null,
        refundStatus: ord.refundStatus || '',
        refundDetails: ord.refundDetails || ord.returnRequest?.refundDetails || null,
        returnRequest: ord.returnRequest || null,
        timeline: ord.timeline || []
      };
    });

    return res.json(formattedOrders);
  } catch (error) {
    console.warn("⚠️ [GET /api/orders/my-orders] DB connection unavailable:", error.message);
    return res.json([]);
  }
};

// 3. Get single order by ID
export const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const isMongoId = mongoose.Types.ObjectId.isValid(id);
    let order = isMongoId
      ? await Order.findById(id)
          .populate("userId", "name email phone addresses")
          .populate("items.productId", "name price images mrp sellerId sellerStoreName storeName")
          .lean()
      : null;
    if (!order) {
      order = await Order.findOne({ $or: [{ orderId: id }, { id: id }] })
        .populate("userId", "name email phone addresses")
        .populate("items.productId", "name price images mrp sellerId sellerStoreName storeName")
        .lean();
    }
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    const enrichedOrder = (await enrichOrdersWithSellerAndConsumer([order]))[0];
    res.json(enrichedOrder);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch order", error: error.message });
  }
};

// Helper to immediately delete MongoDB cart documents for a user upon order placement
const autoClearUserCart = async (userId, userPhone) => {
  try {
    const clearQuery = [];
    if (userId) {
      clearQuery.push({ userId: String(userId) });
      if (mongoose.Types.ObjectId.isValid(userId)) {
        clearQuery.push({ userId: new mongoose.Types.ObjectId(userId) });
      }
    }
    if (userPhone) {
      const cleanPhone = String(userPhone).replace(/\D/g, "");
      if (cleanPhone.length >= 10) {
        clearQuery.push({ userPhone: { $regex: cleanPhone.slice(-10) + "$" } });
      } else {
        clearQuery.push({ userPhone: String(userPhone).trim() });
      }
    }
    if (clearQuery.length > 0) {
      const delRes = await Cart.deleteMany({ $or: clearQuery });
      console.log(`🛒 [BACKEND] Auto-cleared user cart in MongoDB (${delRes.deletedCount} docs deleted) for user:`, userId || userPhone);
    }
  } catch (err) {
    console.warn("⚠️ [BACKEND] Auto-clear user cart warning:", err.message);
  }
};

// 4. Create new order with Stock Validation & Auto-Deduction
export const createOrder = async (req, res) => {
  try {
    const user = await findUserByIdentifier(req);

    const {
      id,
      orderId,
      customer,
      items,
      shippingAddress,
      paymentMethod,
      totalAmount,
      total,
      subtotal,
      shippingCost,
      shippingFee,
      discount,
      discountAmount,
      trackingNumber,
      date,
      product,
      quantity,
      amount,
      size,
      age,
      color,
      address
    } = req.body;

    const resolvedUserId = user ? user._id : (req.user ? req.user.id : req.body.userId || null);
    const resolvedPhone = shippingAddress?.phone || user?.phone || req.headers?.["x-user-phone"] || customer?.phone || req.body.phone || "";
    const resolvedEmail = shippingAddress?.email || user?.email || customer?.email || req.body.email || "";
    const resolvedName = (shippingAddress && !isPlaceholderCust(shippingAddress.name || shippingAddress.fullName) && (shippingAddress.name || shippingAddress.fullName)) ||
      (!isPlaceholderCust(customer?.name) && customer?.name) ||
      (!isPlaceholderCust(user?.name) && user?.name) ||
      (!isPlaceholderCust(req.body.customerName) && req.body.customerName) ||
      (!isPlaceholderCust(req.body.customer) && req.body.customer) ||
      (shippingAddress?.name || shippingAddress?.fullName || customer?.name || user?.name || "Verified Consumer");

    let orderItems = items || [];
    let calculatedTotal = totalAmount || total || amount || 0;

    if ((!orderItems || orderItems.length === 0) && product) {
      orderItems = [
        {
          name: product,
          price: amount || 0,
          finalPrice: amount || 0,
          quantity: quantity || 1,
          size: size || "",
          age: age || "",
          color: color || "",
          total: (amount || 0) * (quantity || 1),
          status: "pending"
        }
      ];
      calculatedTotal = (amount || 0) * (quantity || 1);
    }

    if (!orderItems || orderItems.length === 0) {
      return res.status(400).json({ message: "Cannot place order with empty items" });
    }

    // Cache for seller lookups so multiple items under same seller do zero duplicate queries
    const sellerCache = new Map();
    const getSellerRecord = async (targetId) => {
      if (!targetId) return null;
      const key = String(targetId).trim();
      if (sellerCache.has(key)) return sellerCache.get(key);

      let record = null;
      try {
        if (mongoose.Types.ObjectId.isValid(key)) {
          record = await Seller.findById(key).lean().catch(() => null);
        }
        if (!record) {
          record = await Seller.findOne({
            $or: [{ userId: key }, { id: key }, { email: key }, { phone: key }]
          }).lean().catch(() => null);
        }
        if (!record && mongoose.Types.ObjectId.isValid(key)) {
          record = await User.findById(key).lean().catch(() => null);
        }
        if (!record) {
          record = await User.findOne({
            $or: [{ id: key }, { phone: key }, { email: key }]
          }).lean().catch(() => null);
        }
      } catch (e) {}

      sellerCache.set(key, record);
      return record;
    };

    // Auto-populate productId, sellerId, sellerName, storeName, and GST on order items from Product & User collections
    const allocatedStockMap = {};
    for (const item of orderItems) {
      // 1. Sanitize image safely (prevent array or object CastError)
      if (Array.isArray(item.image)) {
        item.image = item.image[0] || "";
      } else if (typeof item.image === "object" && item.image !== null) {
        item.image = item.image.url || item.image.dataUrl || item.image.src || "";
      }
      if (!item.image && Array.isArray(item.images) && item.images.length > 0) {
        item.image = typeof item.images[0] === "string" ? item.images[0] : (item.images[0]?.url || "");
      }
      if (typeof item.image !== "string") {
        item.image = String(item.image || "");
      }
      if (item.image && typeof item.image === "string" && item.image.startsWith("data:image/")) {
        item.image = saveBase64ToFile(item.image, "products", "order_item");
      }
      if (Array.isArray(item.images)) {
        item.images = item.images.map((img, idx) => {
          const rawUrl = typeof img === "string" ? img : (img?.url || "");
          if (rawUrl && typeof rawUrl === "string" && rawUrl.startsWith("data:image/")) {
            return saveBase64ToFile(rawUrl, "products", `order_item_${idx}`);
          }
          return img;
        });
      }

      // 2. Sanitize price, quantity, discount & total
      const basePrice = item.price !== undefined ? Number(item.price) : (item.finalPrice !== undefined ? Number(item.finalPrice) : 0);
      item.price = Number(basePrice) || 0;
      const parsedQty = Number(item.quantity);
      item.quantity = (!isNaN(parsedQty) && parsedQty > 0) ? parsedQty : 1;
      item.offerDiscount = Number(item.offerDiscount !== undefined ? item.offerDiscount : (item.discount || 0)) || 0;
      item.discount = item.offerDiscount;
      const itemGross = Math.round(item.price * item.quantity * 100) / 100;
      const unitDiscount = item.quantity > 0 ? (item.offerDiscount / item.quantity) : item.offerDiscount;
      item.finalPrice = Math.max(0, Math.round((item.price - unitDiscount) * 100) / 100);
      item.total = Math.max(0, Math.round((itemGross - item.offerDiscount) * 100) / 100);
      item.name = String(item.name || "BookVardi Product").trim();

      // 3. Sanitize size & color
      if (typeof item.size === "object" && item.size !== null) {
        item.size = item.size.size || item.size.name || item.size.label || "";
      }
      item.size = String(item.size || item.selectedSize || "");

      if (typeof item.color === "object" && item.color !== null) {
        item.color = item.color.color || item.color.name || "";
      }
      item.color = String(item.color || item.selectedColor || "");

      const searchId = item.productId || item.id || item._id;
      let prod = await findProductByIdOrCustomId(searchId);
      if (!prod && item.name) {
        const cleanItemName = item.name.replace(/\s*\([^)]*\)/g, "").trim();
        prod = await Product.findOne({
          name: { $regex: new RegExp(cleanItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }
        });
      }

      let sellerStoreName = item.sellerStoreName || item.storeName || item.sellerName || "";

      const isPlaceholder = (str) => {
        if (!str || typeof str !== "string") return true;
        const s = str.trim().toLowerCase();
        return (
          s === "" ||
          s === "bookvardimerchant" ||
          s === "bookvardi merchant" ||
          s === "book vardi partner merchant" ||
          s === "book vardi partner store" ||
          s === "partner merchant" ||
          s === "unknown seller" ||
          s === "new merchant" ||
          s === "merchant store" ||
          s === "bookvardi verified seller" ||
          s === "bookvardi verified seller hub" ||
          s === "verified seller" ||
          s === "exempt / n/a" ||
          s === "n/a"
        );
      };

      if (isPlaceholder(sellerStoreName)) {
        sellerStoreName = "";
      }

      if (prod) {
        if (!item.productId) item.productId = prod._id;
        if (!item.id) item.id = prod._id;
        if (!item.sellerId && prod.sellerId) item.sellerId = prod.sellerId;
        if (!item.image && prod.images && prod.images.length > 0) {
          const firstImg = prod.images[0];
          item.image = typeof firstImg === "string" ? firstImg : (firstImg?.url || "");
        } else if (!item.image && prod.image) {
          item.image = typeof prod.image === "string" ? prod.image : (prod.image?.url || "");
        }
        if (!sellerStoreName && prod.sellerStoreName && !isPlaceholder(prod.sellerStoreName)) sellerStoreName = prod.sellerStoreName;
        if (!sellerStoreName && prod.storeName && !isPlaceholder(prod.storeName)) sellerStoreName = prod.storeName;
        if (!sellerStoreName && prod.tradeName && !isPlaceholder(prod.tradeName)) sellerStoreName = prod.tradeName;
        if (!sellerStoreName && prod.businessName && !isPlaceholder(prod.businessName)) sellerStoreName = prod.businessName;
        if (!sellerStoreName && prod.sellerName && !isPlaceholder(prod.sellerName)) sellerStoreName = prod.sellerName;
        if (!sellerStoreName && prod.legalBusinessName && !isPlaceholder(prod.legalBusinessName)) sellerStoreName = prod.legalBusinessName;
        item.isReturnable = (prod.returnPolicy === 'non_returnable' || prod.isReturnable === false) ? false : (item.isReturnable ?? prod.isReturnable ?? true);
        item.isExchangeable = (prod.returnPolicy === 'non_returnable' || prod.isExchangeable === false) ? false : (item.isExchangeable ?? prod.isExchangeable ?? true);
        item.isRefundable = (prod.returnPolicy === 'non_returnable' || prod.isRefundable === false) ? false : (item.isRefundable ?? prod.isRefundable ?? true);
        item.returnWindowDays = item.returnWindowDays || prod.returnWindowDays || 7;
        item.returnPolicy = item.returnPolicy || prod.returnPolicy || "";
      }

      // Check meter-based fabric/cloth product rules & enforce minimum purchase length
      const candItemStr = [
        item.category,
        prod?.category,
        item.subCategory,
        prod?.subCategory,
        item.name,
        prod?.name,
        item.unit,
        prod?.unit
      ].filter(Boolean).join(' ').toLowerCase();

      const isMeterBased = Boolean(
        item.isMeterBased ||
        prod?.isMeterBased ||
        item.unit === 'meter' ||
        item.unit === 'm' ||
        item.unit === 'mtr' ||
        prod?.unit === 'meter' ||
        prod?.unit === 'm' ||
        prod?.unit === 'mtr' ||
        candItemStr.includes('unstitched') ||
        candItemStr.includes('unstiched') ||
        candItemStr.includes('cloth') ||
        candItemStr.includes('fabric') ||
        candItemStr.includes('shirting') ||
        candItemStr.includes('suiting') ||
        candItemStr.includes('kapda') ||
        candItemStr.includes('than') ||
        candItemStr.includes('dress material') ||
        (Number(item.quantity) % 1 !== 0)
      );
      const minMeter = isMeterBased ? (Number(prod?.minMeter || item.minMeter) > 0 ? Number(prod?.minMeter || item.minMeter) : 0.5) : 1;

      if (isMeterBased) {
        item.isMeterBased = true;
        item.minMeter = minMeter;
        item.meterStep = Number(prod?.meterStep || item.meterStep || 0.5);
        item.unit = 'meter';
        if (prod?.subCategory && !item.subCategory) item.subCategory = prod.subCategory;
        if (Number(item.quantity) < minMeter) {
          return res.status(400).json({
            message: `Minimum order length for "${item.name}" is ${minMeter} meter(s). Please adjust your fabric quantity.`
          });
        }
        item.quantity = Math.max(minMeter, Math.round(Number(item.quantity || minMeter) * 100) / 100);
      } else {
        item.quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
      }

      // Check stock availability & prevent overselling beyond actual inventory
      let availableStock = Infinity;
      const itemSize = String(item.size || item.selectedSize || item.variantName || "").trim();

      if (prod) {
        if (itemSize && Array.isArray(prod.sizeVariants) && prod.sizeVariants.length > 0) {
          const variant = prod.sizeVariants.find(
            (v) => String(v.size || v.measureValue || v.name || "").trim().toLowerCase() === itemSize.toLowerCase()
          );
          if (variant) {
            const vStock = variant.stockQuantity !== undefined ? variant.stockQuantity : variant.stock;
            if (vStock !== undefined && vStock !== null && vStock !== "") {
              availableStock = Number(vStock);
            }
          }
        }

        if (availableStock === Infinity) {
          const pStock = prod.stockQuantity !== undefined ? prod.stockQuantity : prod.stock;
          if (pStock !== undefined && pStock !== null && pStock !== "") {
            availableStock = Number(pStock);
          }
        }
      } else {
        let kit = await findKitByIdOrCustomId(searchId);
        if (!kit && item.name) {
          const cleanItemName = item.name.replace(/\s*\([^)]*\)/g, "").trim();
          kit = await Kit.findOne({
            title: { $regex: new RegExp(cleanItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }
          });
        }
        if (kit) {
          const kStock = kit.stock !== undefined ? kit.stock : kit.stockQuantity;
          if (kStock !== undefined && kStock !== null && kStock !== "") {
            availableStock = Number(kStock);
          }
        }
      }

      if (availableStock !== Infinity && !isNaN(availableStock)) {
        const unitLabel = isMeterBased ? "meter(s)" : "unit(s)";
        const stockKey = `${String(prod?._id || searchId)}_${itemSize.toLowerCase()}`;
        allocatedStockMap[stockKey] = Math.round(((allocatedStockMap[stockKey] || 0) + Number(item.quantity)) * 100) / 100;

        if (availableStock <= 0) {
          return res.status(400).json({
            message: `"${item.name}"${itemSize ? ` (${itemSize})` : ''} is currently out of stock. Please remove it from your order.`
          });
        }
        if (allocatedStockMap[stockKey] > availableStock) {
          return res.status(400).json({
            message: `Insufficient stock for "${item.name}"${itemSize ? ` (${itemSize})` : ''}. Only ${availableStock} ${unitLabel} available in stock, but ${allocatedStockMap[stockKey]} ${unitLabel} was requested.`
          });
        }
      }

      // Recalculate item totals with final validated quantity
      const finalItemGross = Math.round(item.price * item.quantity * 100) / 100;
      const finalUnitDiscount = item.quantity > 0 ? (item.offerDiscount / item.quantity) : item.offerDiscount;
      item.finalPrice = Math.max(0, Math.round((item.price - finalUnitDiscount) * 100) / 100);
      item.total = Math.max(0, Math.round((finalItemGross - item.offerDiscount) * 100) / 100);

      let sellerPhone = item.sellerPhone || "";
      let sellerEmail = item.sellerEmail || "";
      let sellerAddress = item.sellerAddress || "";
      let sellerCity = item.sellerCity || "";

      const targetSellerId = item.sellerId || prod?.sellerId;
      let cachedSeller = null;
      if (targetSellerId) {
        cachedSeller = await getSellerRecord(targetSellerId);
        if (cachedSeller) {
          const fetchedName =
            cachedSeller.storeName ||
            cachedSeller.tradeName ||
            cachedSeller.businessName ||
            cachedSeller.legalBusinessName ||
            cachedSeller.storeDetails?.storeName ||
            cachedSeller.name ||
            cachedSeller.legalName ||
            cachedSeller.ownerFullName ||
            "";
          if (!sellerStoreName && !isPlaceholder(fetchedName)) {
            sellerStoreName = fetchedName;
          }
          if (!sellerPhone) sellerPhone = cachedSeller.phone || cachedSeller.mobile || "";
          if (!sellerEmail) sellerEmail = cachedSeller.email || "";
          if (!sellerAddress) sellerAddress = cachedSeller.address || cachedSeller.addressLine1 || cachedSeller.registeredAddress || "";
          if (!sellerCity) sellerCity = cachedSeller.city || "";
        }
      }

      if (!sellerStoreName) {
        sellerStoreName = "BookVardi Verified Seller";
      }

      item.sellerName = sellerStoreName;
      item.storeName = sellerStoreName;
      item.sellerStoreName = sellerStoreName;
      item.sellerPhone = sellerPhone;
      item.sellerEmail = sellerEmail;
      item.sellerAddress = sellerAddress;
      item.sellerCity = sellerCity;
      item.sellerDetails = {
        sellerId: item.sellerId || targetSellerId,
        storeName: sellerStoreName,
        sellerStoreName: sellerStoreName,
        sellerName: sellerStoreName,
        phone: sellerPhone,
        email: sellerEmail,
        address: sellerAddress,
        city: sellerCity,
        gstNumber: cachedSeller?.gstNumber || item.gstNumber || ""
      };

      // Attach dynamic seller commission rate
      let itemCommRate = item.commissionRate ?? item.sellerCommissionRate ?? item.commissionPercentage;
      if (itemCommRate === undefined || itemCommRate === null || isNaN(Number(itemCommRate))) {
        if (prod && (prod.commissionRate !== undefined || prod.sellerCommissionRate !== undefined)) {
          itemCommRate = prod.commissionRate ?? prod.sellerCommissionRate;
        }
      }
      if ((itemCommRate === undefined || itemCommRate === null || isNaN(Number(itemCommRate))) && cachedSeller) {
        if (cachedSeller.commissionRate !== undefined || cachedSeller.commissionPercentage !== undefined) {
          itemCommRate = cachedSeller.commissionRate ?? cachedSeller.commissionPercentage;
        }
      }
      const resolvedCommRate = (itemCommRate !== undefined && itemCommRate !== null && !isNaN(Number(itemCommRate))) ? Number(itemCommRate) : 10;
      item.commissionRate = resolvedCommRate;
      item.sellerCommissionRate = resolvedCommRate;
      item.commissionPercentage = resolvedCommRate;

      // Ensure explicit product-level GST rate set by seller is strictly preserved
      const explicitGst = item.gstPercent ?? item.gstPercentage ?? item.gstRate ?? item.gst ?? item.taxRate ?? prod?.gstPercent ?? prod?.gstRate ?? prod?.gst ?? prod?.gstPercentage ?? prod?.taxRate;
      let resolvedGst = 5;
      if (explicitGst !== undefined && explicitGst !== null && String(explicitGst).trim() !== "" && !isNaN(Number(explicitGst))) {
        resolvedGst = Number(explicitGst);
      }
      item.gst = resolvedGst;
      item.gstPercent = resolvedGst;
      item.gstPercentage = resolvedGst;
      item.gstRate = resolvedGst;
      item.isGstInclusive = item.isGstInclusive !== undefined ? item.isGstInclusive : (prod?.isGstInclusive !== undefined ? prod.isGstInclusive : true);
    }

    const orderIdVal = (orderId && !/^[0-9a-fA-F]{24}$/.test(orderId))
      ? orderId
      : ((id && !/^[0-9a-fA-F]{24}$/.test(id))
          ? id
          : generateProductOrderId());

      const isCodOrder = paymentMethod && String(paymentMethod).toUpperCase().includes("COD");
      const initialPaymentStatus = req.body.paymentStatus || (req.body.razorpayPaymentId || req.body.isPaid ? "paid" : "pending");

      const rawDeliveryMode = req.body.deliveryMode || req.body.deliveryType || "";
      let topDeliveryMode = "pending_choice";
      if (req.body.deliveryMode === "self_delivery" || (req.body.selfDeliveryDetails && req.body.selfDeliveryDetails.deliveryPersonName)) {
        topDeliveryMode = "self_delivery";
      } else if (req.body.deliveryMode === "third_party" || (req.body.courierName && req.body.courierName !== "N/A")) {
        topDeliveryMode = "third_party";
      } else if (["third_party", "self_delivery", "pending_choice"].includes(rawDeliveryMode)) {
        topDeliveryMode = rawDeliveryMode;
      }

    const isInitialSelfDelivery = topDeliveryMode === "self_delivery";
    const masterOtp = isInitialSelfDelivery
      ? String(req.body.deliveryOtp || req.body.selfDeliveryDetails?.deliveryOtp || Math.floor(1000 + Math.random() * 9000).toString())
      : "";
    for (const item of orderItems) {
      item.status = "pending";
      item.deliveryOtp = masterOtp;
      if (isInitialSelfDelivery && item.selfDeliveryDetails) {
        item.selfDeliveryDetails.deliveryOtp = masterOtp;
      } else if (!isInitialSelfDelivery) {
        item.selfDeliveryDetails = undefined;
      }
    }

    // Fully Dynamic Item-Level Coupon & Combine Offer Discount Preservation
    // If a coupon code was applied to a specific product or combine offer, ensure the discount
    // stays strictly with the eligible product and is NOT split or leaked across other products/sellers.
    const appliedCouponCode = String(
      req.body.couponCode ||
      req.body.appliedCoupon ||
      req.body.coupon?.code ||
      req.body.appliedCoupon?.code ||
      req.body.promoCode ||
      ""
    ).toUpperCase().trim();

    const totalDiscount = Number(discount || discountAmount || 0);
    const existingItemsDiscount = orderItems.reduce((sum, it) => sum + (Number(it.offerDiscount || it.discount) || 0), 0);

    // If coupon code exists, resolve coupon model to ensure couponDetails is persisted
    let matchedCoupon = null;
    if (appliedCouponCode) {
      try {
        matchedCoupon = await Coupon.findOne({ code: appliedCouponCode }).lean();
        if (!matchedCoupon) {
          matchedCoupon = await SellerOffer.findOne({ code: appliedCouponCode }).lean();
        }
      } catch (e) {
        console.warn("⚠️ Coupon lookup warning:", e.message);
      }
    }

    // If total discount exists but items don't have individual offerDiscount, resolve coupon to target item(s)
    if (existingItemsDiscount <= 0 && totalDiscount > 0 && appliedCouponCode && matchedCoupon) {
      try {
        const extractId = (val) => {
          if (!val) return null;
          if (typeof val === 'object') return String(val._id || val.id || '').toLowerCase().trim();
          return String(val).toLowerCase().trim();
        };

        const targetSellerId = extractId(matchedCoupon.sellerId) || extractId(matchedCoupon.storeId);
        const isSellerScoped = Boolean(matchedCoupon.createdRole === 'seller' || targetSellerId);
        const specificProdId = extractId(matchedCoupon.specificProductId);
        const specificKitId = extractId(matchedCoupon.specificKitId);
        const specificProdName = String(matchedCoupon.specificProductName || '').toLowerCase().trim();
        const specificKitName = String(matchedCoupon.specificKitTitle || '').toLowerCase().trim();
        const applicableProds = (matchedCoupon.applicableProducts || []).map(extractId).filter(Boolean);
        const applicableKits = (matchedCoupon.applicableKits || []).map(extractId).filter(Boolean);

        const isProductSpecificCoupon = Boolean(
          specificProdId ||
          specificKitId ||
          specificProdName ||
          specificKitName ||
          applicableProds.length > 0 ||
          applicableKits.length > 0 ||
          matchedCoupon.applicableScope === 'specific_product' ||
          matchedCoupon.applicableScope === 'specific_kit'
        );

        const eligibleItems = orderItems.filter((item) => {
          const itemSellerId = extractId(item.sellerId || item.sellerDetails?.sellerId);
          const itemCandidates = [
            extractId(item.productId),
            extractId(item.id),
            extractId(item._id),
            extractId(item.customId)
          ].filter(Boolean);
          const itemNameLower = String(item.name || '').toLowerCase();

          if (isSellerScoped && targetSellerId && itemSellerId && itemSellerId !== targetSellerId) {
            return false;
          }
          if (specificProdId && itemCandidates.includes(specificProdId)) {
            return true;
          }
          if (applicableProds.length > 0 && applicableProds.some(p => itemCandidates.includes(p))) {
            return true;
          }
          if (specificProdName && itemNameLower.includes(specificProdName)) {
            return true;
          }
          if (specificKitId && itemCandidates.includes(specificKitId)) {
            return true;
          }
          if (applicableKits.length > 0 && applicableKits.some(k => itemCandidates.includes(k))) {
            return true;
          }
          if (specificKitName && itemNameLower.includes(specificKitName)) {
            return true;
          }
          if (isProductSpecificCoupon) {
            return false;
          }
          return true;
        });

          if (eligibleItems.length > 0) {
            const eligibleSubtotal = eligibleItems.reduce(
              (sum, it) => sum + (Number(it.price || it.finalPrice || 0) * Number(it.quantity || 1)),
              0
            ) || 1;

            let allocated = 0;
            eligibleItems.forEach((it, idx) => {
              const itGross = Number(it.price || it.finalPrice || 0) * Number(it.quantity || 1);
              const isLast = idx === eligibleItems.length - 1;
              const itDisc = isLast
                ? Math.max(0, Math.round((totalDiscount - allocated) * 100) / 100)
                : Math.min(itGross, Math.round((totalDiscount * (itGross / eligibleSubtotal)) * 100) / 100);
              allocated += itDisc;

              it.offerDiscount = itDisc;
              it.discount = itDisc;
              it.couponCode = appliedCouponCode;
              const unitDisc = it.quantity > 0 ? (itDisc / it.quantity) : itDisc;
              it.finalPrice = Math.max(0, Math.round((Number(it.price || 0) - unitDisc) * 100) / 100);
              it.total = Math.max(0, Math.round((itGross - itDisc) * 100) / 100);
            });

            // STRICTLY ZERO OUT any non-eligible items in this combine order
            orderItems.forEach((it) => {
              if (!eligibleItems.includes(it)) {
                it.offerDiscount = 0;
                it.discount = 0;
                it.couponCode = "";
                it.finalPrice = Number(it.price || 0);
                it.total = Math.round((Number(it.price || 0) * Number(it.quantity || 1)) * 100) / 100;
              }
            });
          }
        } catch (e) {
          console.warn("⚠️ Coupon auto-allocation warning:", e.message);
        }
      }

    // Fetch dynamic platform logistics settings for free delivery threshold
    let dynamicThreshold = 401;
    let universalShippingFee = 49;
    let universalCodFee = 0;
    try {
      const globalSettings = await PlatformSetting.findOne({ key: "global_settings" }).lean();
      dynamicThreshold = Number(globalSettings?.freeShippingThreshold ?? globalSettings?.minOrderFreeShipping ?? 401);
      universalShippingFee = Number(globalSettings?.shippingFee ?? 49);
      universalCodFee = Number(globalSettings?.codFee ?? 0);
    } catch (e) {
      console.warn("⚠️ Error fetching global settings for order creation:", e.message);
    }

    const overallItemsSubtotal = orderItems.reduce(
      (sum, it) => sum + (Number(it.finalPrice || it.price || 0) * Number(it.quantity || 1)),
      0
    ) || 1;

    let totalShipping = 0;
    // Strict enforcement: if overall items subtotal qualifies for free shipping, delivery fee is 0
    if (overallItemsSubtotal >= dynamicThreshold) {
      totalShipping = 0;
    } else if (shippingCost !== undefined && shippingCost !== null && !isNaN(Number(shippingCost))) {
      totalShipping = Number(shippingCost);
    } else if (shippingFee !== undefined && shippingFee !== null && !isNaN(Number(shippingFee))) {
      totalShipping = Number(shippingFee);
    } else {
      const distinctCount = orderItems.length;
      totalShipping = distinctCount * universalShippingFee;
    }

    // Group items by unique seller to support individual multi-vendor sub-orders
    const sellerGroupsMap = new Map();
    for (const item of orderItems) {
      const sKey = String(
        item.sellerId?._id ||
        item.sellerId ||
        item.sellerDetails?.sellerId ||
        item.storeName ||
        item.sellerName ||
        "default_seller"
      ).trim();

      if (!sellerGroupsMap.has(sKey)) {
        sellerGroupsMap.set(sKey, {
          sellerId: item.sellerId || item.sellerDetails?.sellerId || null,
          sellerStoreName: item.storeName || item.sellerName || item.sellerDetails?.storeName || "",
          sellerDetails: item.sellerDetails || null,
          items: []
        });
      }
      sellerGroupsMap.get(sKey).items.push(item);
    }

    const sellerGroups = Array.from(sellerGroupsMap.values());
    const primarySeller = sellerGroups[0] || {};
    const allSellerStoreNames = [
      ...new Set(
        sellerGroups
          .map((g) => g.sellerStoreName)
          .filter(Boolean)
      )
    ].join(", ");

    // Check if any items have item-specific coupon/offer discounts
    const anyItemHasSpecificDiscount = orderItems.some(
      (it) => Number(it.offerDiscount || it.discount || 0) > 0
    );

    // Attach dynamic Seller Settlement breakdown (Rules 1, 2, 3 & 4)
    const effectiveOrderTotal = Number(totalAmount || 0) || overallItemsSubtotal;
    const customerState = req.body.shippingAddress?.state || "Uttar Pradesh";
    const isCod = /cod|cash\s*on\s*delivery/i.test(String(paymentMethod || ''));
    const orderCodFee = isCod
      ? (req.body.codFee !== undefined && req.body.codFee !== null && !isNaN(Number(req.body.codFee))
          ? Number(req.body.codFee)
          : (req.body.appliedCodFee !== undefined && req.body.appliedCodFee !== null && !isNaN(Number(req.body.appliedCodFee))
              ? Number(req.body.appliedCodFee)
              : universalCodFee))
      : 0;

    for (const it of orderItems) {
      const itGross = Number(it.total) || Math.round(((Number(it.finalPrice || it.price || 0)) * (Number(it.quantity) || 1)) * 100) / 100;
      const itGstRate = Number(it.gstPercent ?? it.gstPercentage ?? it.gstRate ?? it.gst ?? (it.category?.toLowerCase()?.includes('book') ? 0 : 5));
      const sellerState = it.sellerDetails?.state || it.sellerId?.state || it.sellerState || "Uttar Pradesh";
      const candidateGsts = [
        it.sellerDetails?.gstNumber,
        it.sellerId?.gstNumber,
        it.sellerGstNumber,
        primarySeller.sellerDetails?.gstNumber,
        primarySeller.sellerId?.gstNumber
      ].filter(Boolean);
      const isExemptSellerItem = candidateGsts.some(isGstExempted) ||
        String(it.sellerStoreName || it.storeName || primarySeller.sellerStoreName || "").toLowerCase().includes("national school dress") ||
        String(it.sellerPhone || it.sellerDetails?.phone || "").replace(/\D/g, "").includes("9027237697");
      const sellerGst = isExemptSellerItem ? "09BLMPK2840L2ZN" : (candidateGsts[0] || "");

      const stl = calculateSellerSettlement(itGross, {
        commissionRate: isExemptSellerItem ? 0 : (it.commissionRate ?? 10),
        sellerGstNumber: sellerGst,
        isFullyExempted: isExemptSellerItem,
        paymentMethod: paymentMethod || "UPI",
        deliveryMode: topDeliveryMode || it.deliveryType,
        courierName: req.body.courierName || it.thirdPartyDetails?.courierName || "",
        orderTotal: effectiveOrderTotal || itGross,
        sellerState,
        customerState,
        gstRate: itGstRate,
        category: it.category || "",
        name: it.name || it.productName || "",
        deliveryCharge: totalShipping > 0 ? (req.body.shippingFee ?? req.body.shippingAmount ?? req.body.shippingCost ?? universalShippingFee ?? 49) : 0,
        shippingFee: totalShipping,
        shippingCost: totalShipping,
        codFee: orderCodFee,
        appliedCodFee: orderCodFee,
        freeDeliveryThreshold: dynamicThreshold,
        deliveryChargeBorneBy: (effectiveOrderTotal >= dynamicThreshold ? 'admin' : (totalShipping > 0 ? 'customer' : (req.body.deliveryChargeBorneBy || 'seller')))
      });
      it.commissionRate = stl.commissionRate;
      it.commissionAmount = stl.commissionAmount;
      it.gstOnCommissionRate = stl.gstOnCommissionRate;
      it.gstOnCommissionAmount = stl.gstOnCommissionAmount;
      it.tdsRate = stl.tdsRate;
      it.tdsAmount = stl.tdsAmount;
      it.isIntraState = stl.isIntraState;
      it.gstTcsRate = stl.gstTcsRate;
      it.gstTcsAmount = stl.gstTcsAmount;
      it.cgstTcsRate = stl.cgstTcsRate;
      it.cgstTcsAmount = stl.cgstTcsAmount;
      it.sgstTcsRate = stl.sgstTcsRate;
      it.sgstTcsAmount = stl.sgstTcsAmount;
      it.igstTcsRate = stl.igstTcsRate;
      it.igstTcsAmount = stl.igstTcsAmount;
      it.deliveryChargeAmount = stl.deliveryChargeAmount;
      it.gstOnDeliveryRate = stl.gstOnDeliveryRate;
      it.gstOnDeliveryAmount = stl.gstOnDeliveryAmount;
      it.totalDeliveryDeduction = stl.totalDeliveryDeduction;
      it.deliveryChargeBorneBy = stl.deliveryChargeBorneBy;
      it.codChargeAmount = stl.codChargeAmount;
      it.codChargeRetainedBy = stl.codChargeRetainedBy;
      it.codChargeDeduction = stl.codChargeDeduction;
      it.isCodExempted = stl.isCodExempted;
      it.totalDeductions = stl.totalDeductions;
      it.netSettlementAmount = stl.netSettlement;
      it.settlementStatus = "pending";
      it.settlementRule = stl.ruleCode;
    }

    // =========================================================================
    // UNIFIED ORDER CREATION (Supports single-seller & multi-seller checkouts)
    // Both items remain in one unified order; Seller Panel automatically filters
    // items per seller scope via sellerOrderController.isItemBelongingToSellerScope.
    // =========================================================================

    const computedTax = req.body.taxAmount !== undefined
      ? Number(req.body.taxAmount) || 0
      : orderItems.reduce((sum, it) => {
          const isInc = it.isGstInclusive !== false;
          if (!isInc) {
            const rate = Number(it.gst || it.gstRate || it.gstPercent || 5);
            const itemSub = Number(it.finalPrice || it.price || 0) * Number(it.quantity || 1);
            return sum + (itemSub * rate) / 100;
          }
          return sum;
        }, 0);

    const isCod = /cod|cash\s*on\s*delivery/i.test(String(paymentMethod || ''));
    const orderCodFee = isCod
      ? (req.body.codFee !== undefined && req.body.codFee !== null && !isNaN(Number(req.body.codFee))
          ? Number(req.body.codFee)
          : (req.body.appliedCodFee !== undefined && req.body.appliedCodFee !== null && !isNaN(Number(req.body.appliedCodFee))
              ? Number(req.body.appliedCodFee)
              : universalCodFee))
      : 0;

    const finalTotalAmount = Number(calculatedTotal) > 0
      ? Number(calculatedTotal)
      : Math.max(0, Math.round((overallItemsSubtotal + totalShipping + computedTax + orderCodFee - totalDiscount) * 100) / 100);

    // Dynamic Delivery GST Rate (Section 8 Composite Supply: Delivery GST dynamically matches product GST)
    const itemGstRates = orderItems.map(it => {
      const cat = String(it.category || '').toLowerCase();
      const isBook = cat.includes('book') || cat.includes('textbook') || String(it.name || '').toLowerCase().includes('book');
      return Number(it.gstPercent ?? it.gstPercentage ?? it.gstRate ?? it.gst ?? (isBook ? 0 : 5));
    }).filter(r => !isNaN(r));
    const principalDeliveryGstRate = itemGstRates.length > 0 ? Math.max(...itemGstRates) : 5;

    // Calculate sequential seller Tax Invoice Number (e.g. NSD01, NSD02...)
    const sellerStoreForInvoice = allSellerStoreNames || primarySeller.sellerStoreName || primarySeller.name || "Store";
    const sellerInvoicePrefix = getSellerInvoicePrefix(sellerStoreForInvoice);

    let sellerPrevOrderCount = 0;
    try {
      const sellerCountFilter = primarySeller.sellerId ? {
        $or: [
          { sellerId: primarySeller.sellerId },
          { "items.sellerId": primarySeller.sellerId },
          { sellerStoreName: sellerStoreForInvoice }
        ]
      } : { sellerStoreName: sellerStoreForInvoice };
      sellerPrevOrderCount = await Order.countDocuments(sellerCountFilter);
    } catch (cntErr) {
      console.warn("⚠️ [BACKEND] Count seller orders warning:", cntErr.message);
    }
    const currentSellerSeq = sellerPrevOrderCount + 1;
    const generatedSellerInvoiceNo = formatSellerInvoiceNumber(sellerInvoicePrefix, currentSellerSeq);

    const newOrder = new Order({
      orderId: orderIdVal,
      id: orderIdVal,
      invoiceNumber: generatedSellerInvoiceNo,
      sellerInvoiceNo: generatedSellerInvoiceNo,
      sellerSequence: currentSellerSeq,
      masterOrderId: orderIdVal,
      isSubOrder: false,
      subOrderIndex: 1,
      subOrdersCount: 1,
      sellerId: primarySeller.sellerId || null,
      sellerStoreName: allSellerStoreNames || primarySeller.sellerStoreName || "",
      userId: resolvedUserId,
      customer: customer || {
        name: resolvedName,
        email: resolvedEmail,
        phone: resolvedPhone
      },
      items: orderItems,
      subtotal: subtotal || overallItemsSubtotal || 0,
      taxAmount: Math.round(computedTax * 100) / 100,
      freeDeliveryThreshold: dynamicThreshold,
      shippingCost: totalShipping,
      shippingFee: totalShipping,
      codFee: orderCodFee,
      appliedCodFee: orderCodFee,
      shippingGstRate: principalDeliveryGstRate,
      deliveryGstRate: principalDeliveryGstRate,
      discount: discount || discountAmount || totalDiscount || 0,
      discountAmount: discountAmount || discount || totalDiscount || 0,
      appliedCoupon: appliedCouponCode || "",
      couponCode: appliedCouponCode || "",
      couponDetails: req.body.couponDetails || matchedCoupon || req.body.coupon || null,
      commissionRate: orderItems[0]?.commissionRate ?? 10,
      sellerCommissionRate: orderItems[0]?.commissionRate ?? 10,
      commissionPercentage: orderItems[0]?.commissionRate ?? 10,
      totalAmount: finalTotalAmount,
      total: finalTotalAmount,
      date: date || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
      shippingAddress: shippingAddress || { street: address || "" },
      paymentMethod: paymentMethod || "UPI",
      paymentStatus: initialPaymentStatus,
      razorpayOrderId: req.body.razorpayOrderId || "",
      razorpayPaymentId: req.body.razorpayPaymentId || "",
      overallStatus: "Pending",
      status: "Pending",
      deliveryMode: topDeliveryMode,
      courierName: topDeliveryMode === "self_delivery" ? "" : (req.body.courierName || ""),
      trackingNumber: topDeliveryMode === "self_delivery" ? (req.body.selfDeliveryDetails?.deliveryPartnerToken || "") : (trackingNumber || ""),
      trackingUrl: req.body.trackingUrl || "",
      sellerDetails: req.body.sellerDetails || primarySeller.sellerDetails || orderItems[0]?.sellerDetails || null,
      selfDeliveryDetails: isInitialSelfDelivery && req.body.selfDeliveryDetails ? { ...req.body.selfDeliveryDetails, deliveryOtp: masterOtp } : undefined,
      deliveryOtp: masterOtp,
      address: typeof shippingAddress === "string" ? shippingAddress : (address || shippingAddress?.street || ""),
      product: product || (orderItems.map(it => it.name).filter(Boolean).join(", ") || orderItems[0]?.name || ""),
      quantity: quantity || (orderItems.reduce((acc, it) => acc + (Number(it.quantity) || 1), 0)),
      amount: finalTotalAmount
    });

    await newOrder.save();

    // Auto-decrease product and kit stock in MongoDB in parallel as order is placed
    try {
      await Promise.all(orderItems.map((item) => decrementItemStock(item).catch(() => {})));
    } catch (stockErr) {
      console.warn("⚠️ Stock auto-decrement warning:", stockErr.message);
    }

    // Auto-increment coupon redemption count on Coupon and SellerOffer models
    try {
      const appliedCode = req.body.couponCode || req.body.coupon?.code || req.body.appliedCoupon?.code || req.body.coupon || req.body.promoCode;
      if (appliedCode) {
        const cleanCode = String(appliedCode).toUpperCase().trim();
        await Coupon.findOneAndUpdate(
          { code: cleanCode },
          { $inc: { usageCount: 1 } }
        ).catch(() => {});
        await SellerOffer.findOneAndUpdate(
          { code: cleanCode },
          { $inc: { usageCount: 1 } }
        ).catch(() => {});
      }
    } catch (couponErr) {
      console.warn("⚠️ Coupon redemption increment warning:", couponErr.message);
    }

    // Auto-clear cart in MongoDB database for user
    await autoClearUserCart(resolvedUserId, resolvedPhone);

    // Send automated Fast2SMS DLT Order Placed SMS (Template 228314) to Customer
    try {
      const targetPhone = newOrder.customer?.phone || resolvedPhone;
      const displayOrderId = newOrder.orderId || newOrder.id || orderIdVal;
      if (targetPhone && displayOrderId && !newOrder.orderPlacedSmsSent) {
        sendFast2SmsOrderPlaced(targetPhone, displayOrderId)
          .then(async (smsRes) => {
            if (smsRes?.success) {
              console.log(`📲 [FAST2SMS] Order placed SMS sent to +91 ${targetPhone} for Order ${displayOrderId}`);
              try {
                await Order.updateOne(
                  { _id: newOrder._id },
                  {
                    $set: {
                      orderPlacedSmsSent: true,
                      orderPlacedSmsSentAt: new Date(),
                      orderPlacedSmsRequestId: smsRes.requestId
                    }
                  }
                );
              } catch (e) {}
            } else {
              console.warn(`⚠️ [FAST2SMS] Order placed SMS dispatch warning for +91 ${targetPhone}:`, smsRes?.error || smsRes?.message);
            }
          })
          .catch((smsErr) => {
            console.warn("⚠️ [FAST2SMS] Order placed SMS dispatch error:", smsErr.message);
          });
      }

      // Send automated Fast2SMS DLT New Order Notification (Template 228311) to Seller(s)
      const sellerPhones = [
        ...new Set(
          orderItems
            .map(it => it.sellerPhone || it.sellerDetails?.phone)
            .filter(Boolean)
        )
      ];
      sellerPhones.forEach((sPhone) => {
        sendFast2SmsSellerNewOrder(sPhone, displayOrderId)
          .then((sRes) => {
            if (sRes?.success) {
              console.log(`📲 [FAST2SMS] New order alert SMS sent to seller +91 ${sPhone} for Order ${displayOrderId}`);
            }
          })
          .catch((sErr) => {
            console.warn(`⚠️ [FAST2SMS] Seller order alert dispatch error for +91 ${sPhone}:`, sErr.message);
          });
      });
    } catch (smsErr) {
      console.warn("⚠️ [FAST2SMS] Failed to initiate order placed SMS:", smsErr.message);
    }

    try {
      broadcastRealtimeEvent({
        type: "ORDER_CREATED",
        orderId: newOrder.orderId,
        masterOrderId: newOrder.masterOrderId,
        sellerId: newOrder.sellerId,
        total: newOrder.totalAmount,
        customerName: newOrder.customer?.name,
        customerPhone: newOrder.customer?.phone,
        userId: newOrder.userId,
        status: newOrder.overallStatus || newOrder.status || "Pending",
        order: newOrder
      });
    } catch (rtErr) {
      console.warn("⚠️ Realtime broadcast error:", rtErr.message);
    }

    const sanitizedOrder = typeof newOrder.toObject === 'function' ? newOrder.toObject() : { ...newOrder };
    delete sanitizedOrder.deliveryOtp;
    if (sanitizedOrder.selfDeliveryDetails) {
      delete sanitizedOrder.selfDeliveryDetails.deliveryOtp;
    }
    if (Array.isArray(sanitizedOrder.items)) {
      sanitizedOrder.items.forEach(it => {
        delete it.deliveryOtp;
        if (it.selfDeliveryDetails) delete it.selfDeliveryDetails.deliveryOtp;
      });
    }

    return res.status(201).json({ message: "Order placed successfully in DB", order: sanitizedOrder });
  } catch (error) {
    console.error("❌ [POST /api/orders] Error creating order:", error);
    return res.status(400).json({ message: "Failed to create order", error: error.message });
  }
};

// 5. Track Order API with Full Visual Timeline & Delivery Status
export const trackOrder = async (req, res) => {
  try {
    const orderId = req.params.orderId || req.params.id;

    // Search by either MongoDB _id or custom orderId (e.g. SK-MTMPX58U)
    const isMongoId = /^[0-9a-fA-F]{24}$/.test(orderId);
    const query = isMongoId ? { _id: orderId } : { orderId };

    const order = await Order.findOne(query)
      .populate("items.productId", "name price images category")
      .populate("items.sellerId", "storeName name phone address city");

    if (!order) {
      return res.status(404).json({ message: "Order not found with provided tracking identifier." });
    }

    // Standard 6-Step Visual Tracking Steps for Front-end Stepper UI
    const standardSteps = [
      { key: "placed", label: "Order Placed", stepNumber: 1 },
      { key: "confirmed", label: "Order Confirmed", stepNumber: 2 },
      { key: "packed", label: "Packed", stepNumber: 3 },
      { key: "shipped", label: "Shipped", stepNumber: 4 },
      { key: "out_for_delivery", label: "Out for Delivery", stepNumber: 5 },
      { key: "delivered", label: "Delivered", stepNumber: 6 }
    ];

    const currentStatus = (order.overallStatus || order.status || "").toLowerCase();
    const isCancelled = currentStatus === "cancelled" || currentStatus === "canceled" || order.status === "Cancelled" || order.overallStatus === "Cancelled";
    const currentStepIndex = standardSteps.findIndex((s) => s.key === currentStatus);

    const hasReturn = Boolean(
      order.returnRequest &&
      order.returnRequest.type &&
      !['none', 'n/a', '', 'null'].includes(String(order.returnRequest.type).toLowerCase().trim()) &&
      !['none', 'n/a', 'no_request', 'normal', 'null', ''].includes(String(order.returnRequest.status || '').toLowerCase().trim())
    );

    const retReqType = String(order.returnRequest?.type || '').toLowerCase();
    const retReqStatus = String(order.returnRequest?.status || '').toLowerCase().trim().replace(/[\s-]+/g, '_');

    const returnSteps = retReqType === 'exchange' ? [
      { key: 'exchange_requested', label: 'Exchange Requested', desc: 'Customer requested replacement', stepNumber: 1 },
      { key: 'exchange_approved', label: 'Exchange Approved', desc: 'Store approved replacement', stepNumber: 2 },
      { key: 'pickup_scheduled', label: 'Pickup Scheduled', desc: 'Courier / Rider scheduled', stepNumber: 3 },
      { key: 'exchange_dispatched', label: 'Replacement Dispatched', desc: 'Replacement on the way', stepNumber: 4 },
      { key: 'exchanged', label: 'Exchange Completed', desc: 'Handover verified', stepNumber: 5 }
    ] : [
      { key: 'return_requested', label: 'Return Requested', desc: 'Customer initiated return', stepNumber: 1 },
      { key: 'return_approved', label: 'Return Approved', desc: 'Store accepted return request', stepNumber: 2 },
      { key: 'pickup_scheduled', label: 'Pickup Scheduled', desc: 'Return parcel pickup scheduled', stepNumber: 3 },
      { key: 'product_received', label: 'Product Received', desc: 'Returned item verified & restocked', stepNumber: 4 },
      { key: 'refund_completed', label: 'Refund Completed', desc: 'Refund payout settled to customer', stepNumber: 5 }
    ];

    let currentReturnStepIndex = -1;
    if (hasReturn) {
      if (retReqStatus === 'requested' || retReqStatus.endsWith('_requested')) currentReturnStepIndex = 0;
      else if (retReqStatus === 'approved' || retReqStatus.endsWith('_approved')) currentReturnStepIndex = 1;
      else if (retReqStatus === 'pickup_scheduled') currentReturnStepIndex = 2;
      else if (retReqStatus === 'product_received' || retReqStatus === 'product_return_received') currentReturnStepIndex = 3;
      else if (retReqStatus === 'exchange_dispatched') currentReturnStepIndex = 3;
      else if (retReqStatus === 'refund_initiated' || retReqStatus === 'refund_processed' || retReqStatus === 'refund_completed' || retReqStatus === 'refunded') currentReturnStepIndex = 4;
      else if (retReqStatus === 'exchanged') currentReturnStepIndex = 4;
      else currentReturnStepIndex = 0;
    }

    const trackingSummary = {
      orderId: order.orderId,
      orderDbId: order._id,
      createdAt: order.createdAt,
      estimatedDeliveryDate: order.estimatedDeliveryDate,
      currentStatus: order.overallStatus || order.status,
      overallStatus: order.overallStatus || order.status,
      status: order.status || order.overallStatus,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      shippingAddress: order.shippingAddress || { street: order.address },
      totalAmount: order.totalAmount,
      isCancelled,
      trackingStatus: isCancelled ? "terminated" : (hasReturn ? "return_active" : "active"),
      cancellationReason: order.cancellationReason || "",
      cancelledBy: order.cancelledBy || "",
      cancelledAt: order.cancelledAt || null,
      refundStatus: order.refundStatus || "",
      returnRequest: order.returnRequest || null,
      refundDetails: order.refundDetails || order.returnRequest?.refundDetails || null,
      isReturnOrExchange: hasReturn,
      returnType: retReqType || null,
      returnStatus: retReqStatus || null,
      currentReturnStepIndex,
      returnSteps: returnSteps.map((st, idx) => ({
        ...st,
        isCompleted: currentReturnStepIndex >= idx,
        isCurrent: currentReturnStepIndex === idx
      })),
      message: isCancelled
        ? "Fulfillment and shipping tracking closed due to order cancellation."
        : (hasReturn ? `Return & Exchange tracking active: ${retReqStatus}` : "Tracking active"),
      isDelivered: currentStatus === "delivered",
      currentStepIndex: isCancelled ? -1 : (currentStepIndex > -1 ? currentStepIndex : (currentStatus === "processing" ? 1 : 0)),
      deliveryMode: (() => {
        const isSelf = order.deliveryMode === "self_delivery" || Boolean(order.selfDeliveryDetails?.deliveryPersonName || order.selfDeliveryDetails?.deliveryPartnerToken);
        const isThird = order.deliveryMode === "third_party" || Boolean(!isSelf && order.courierName && order.courierName !== "N/A" && order.courierName !== "");
        return isSelf ? "self_delivery" : (isThird ? "third_party" : "pending_choice");
      })(),
      courierName: (order.deliveryMode === "self_delivery" || Boolean(order.selfDeliveryDetails?.deliveryPersonName)) ? "" : (order.courierName || order.carrier || order.items?.[0]?.thirdPartyDetails?.courierName || ""),
      carrier: (order.deliveryMode === "self_delivery" || Boolean(order.selfDeliveryDetails?.deliveryPersonName)) ? "" : (order.carrier || order.courierName || ""),
      trackingNumber: (order.deliveryMode === "self_delivery" || Boolean(order.selfDeliveryDetails?.deliveryPersonName)) ? (order.selfDeliveryDetails?.deliveryPartnerToken || order.trackingNumber || "") : (order.trackingNumber || order.items?.[0]?.thirdPartyDetails?.trackingNumber || ""),
      trackingUrl: (order.deliveryMode === "self_delivery" || Boolean(order.selfDeliveryDetails?.deliveryPersonName)) ? (order.selfDeliveryDetails?.trackingUrl || order.trackingUrl || "") : (order.trackingUrl || order.items?.[0]?.thirdPartyDetails?.trackingUrl || ""),
      sellerDetails: order.sellerDetails || order.items?.[0]?.sellerDetails || (order.items?.[0]?.sellerId ? {
        storeName: order.items[0].sellerId.storeName || order.items[0].sellerName || "",
        sellerName: order.items[0].sellerName || order.items[0].sellerId.storeName || "",
        phone: order.items[0].sellerId.phone || "",
        email: order.items[0].sellerId.email || "",
        address: order.items[0].sellerId.address || order.items[0].sellerId.city || ""
      } : null),
      selfDeliveryDetails: (() => {
        const rawSd = (order.deliveryMode === "self_delivery" || Boolean(order.selfDeliveryDetails?.deliveryPersonName)) ? (order.selfDeliveryDetails || order.items?.[0]?.selfDeliveryDetails || null) : null;
        if (!rawSd) return null;
        const copy = typeof rawSd.toObject === 'function' ? rawSd.toObject() : { ...rawSd };
        copy.deliveryOtp = order.deliveryOtp || copy.deliveryOtp || "";
        return copy;
      })(),
      deliveryOtp: order.deliveryOtp || order.selfDeliveryDetails?.deliveryOtp || "",
      steps: standardSteps.map((step, idx) => ({
        ...step,
        isCompleted: isCancelled ? false : currentStepIndex >= idx,
        isCurrent: isCancelled ? false : currentStepIndex === idx
      })),
      timeline: order.timeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
      items: order.items.map((item) => {
        const itemSellerDoc = item.sellerId && typeof item.sellerId === 'object' ? item.sellerId : null;
        const itemSellerDetails = item.sellerDetails || {
          sellerId: itemSellerDoc?._id || item.sellerId,
          storeName: item.storeName || item.sellerName || itemSellerDoc?.storeName || itemSellerDoc?.name || "Partner Merchant",
          sellerName: item.sellerName || item.storeName || itemSellerDoc?.name || itemSellerDoc?.storeName || "Partner Merchant",
          phone: item.sellerPhone || itemSellerDoc?.phone || "",
          email: item.sellerEmail || itemSellerDoc?.email || "",
          address: item.sellerAddress || itemSellerDoc?.address || "",
          city: item.sellerCity || itemSellerDoc?.city || ""
        };

        const sanitizeItemSd = (sd) => {
          if (!sd) return null;
          const copy = typeof sd.toObject === 'function' ? sd.toObject() : { ...sd };
          delete copy.deliveryOtp;
          return copy;
        };

        const baseItemPrice = Number(item.price !== undefined && item.price !== null && !isNaN(Number(item.price)) ? item.price : (item.finalPrice || 0));
        const finalItemPrice = Number(item.finalPrice !== undefined && item.finalPrice !== null && !isNaN(Number(item.finalPrice)) ? item.finalPrice : baseItemPrice);
        const itemOfferDiscount = Number(item.offerDiscount || item.discount || 0);

        return {
          id: item._id,
          _id: item._id,
          name: item.name,
          quantity: item.quantity,
          price: baseItemPrice,
          originalPrice: baseItemPrice,
          finalPrice: finalItemPrice,
          offerDiscount: itemOfferDiscount,
          discount: itemOfferDiscount,
          total: Number(item.total) || Math.round((finalItemPrice * (Number(item.quantity) || 1)) * 100) / 100,
          gstPercent: item.gstPercent !== undefined ? item.gstPercent : (item.gstRate ?? item.gst ?? 5),
          gstRate: item.gstRate !== undefined ? item.gstRate : (item.gstPercent ?? item.gst ?? 5),
          isGstInclusive: item.isGstInclusive !== false,
          size: item.size,
          age: item.age,
          color: item.color,
          image: item.image,
          deliveryType: item.deliveryType || order.deliveryMode || "pending_choice",
          deliveryOtp: "",
          selfDelivery: sanitizeItemSd(item.selfDeliveryDetails || order.selfDeliveryDetails),
          selfDeliveryDetails: sanitizeItemSd(item.selfDeliveryDetails || order.selfDeliveryDetails),
          thirdParty: item.thirdPartyDetails || {
            courierName: order.courierName,
            trackingNumber: order.trackingNumber,
            trackingUrl: order.trackingUrl
          },
          thirdPartyDetails: item.thirdPartyDetails || {
            courierName: order.courierName,
            trackingNumber: order.trackingNumber,
            trackingUrl: order.trackingUrl
          },
          sellerName: itemSellerDetails.sellerName,
          storeName: itemSellerDetails.storeName,
          sellerPhone: itemSellerDetails.phone,
          sellerDetails: itemSellerDetails,
          itemStatus: item.status
        };
      })
    };

    res.json(trackingSummary);
  } catch (error) {
    res.status(500).json({ message: "Failed to track order", error: error.message });
  }
};

// 6. Update Order Status (Admin / Seller / System) with Timeline Push
export const updateOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const isMongoId = mongoose.Types.ObjectId.isValid(id);
    let existingOrder = isMongoId ? await Order.findById(id) : null;
    if (!existingOrder) {
      existingOrder = await Order.findOne({ $or: [{ orderId: id }, { id: id }] });
    }
    if (!existingOrder) {
      return res.status(404).json({ message: "Order not found" });
    }

    const previousStatus = existingOrder.overallStatus || existingOrder.status;
    const previousStatusKey = String(previousStatus || '').toLowerCase().trim().replace(/[\s-]+/g, "_");

    const rawNewStatus = req.body.overallStatus || req.body.status;
    const newStatusKey = rawNewStatus ? String(rawNewStatus).toLowerCase().trim().replace(/[\s-]+/g, "_") : null;
    const canonicalStatus = rawNewStatus ? normalizeOrderStatus(rawNewStatus) : null;

    // Guard against bypassing sequential return/exchange workflow via generic updateOrder
    const returnRestrictedStatuses = [
      "return_requested", "exchange_requested", "return_approved", "exchange_approved", "approved",
      "pickup_scheduled", "product_received", "product_return_received",
      "refund_initiated", "refund_completed", "refunded", "refund_processed", "refund_approved",
      "exchange_dispatched", "exchanged"
    ];
    if (existingOrder.returnRequest && existingOrder.returnRequest.type && newStatusKey && returnRestrictedStatuses.includes(newStatusKey)) {
      return res.status(422).json({
        message: "This order has an active Return/Exchange request. Please manage status transitions sequentially through the Return/Exchange action panel.",
        currentStatus: existingOrder.returnRequest.status
      });
    }

    const {
      statusTitle,
      statusDescription,
      statusLocation,
      cancellationReason,
      paymentStatus,
      estimatedDeliveryDate
    } = req.body;

    // Status Title and Description Map
    const statusTextMap = {
      placed: { title: "Order Placed", desc: "Your order has been placed successfully." },
      confirmed: { title: "Order Confirmed", desc: "Seller has confirmed your order." },
      processing: { title: "Processing Order", desc: "Order is being prepared." },
      packed: { title: "Items Packed", desc: "Items have been packed and ready for dispatch." },
      shipped: { title: "Order Shipped", desc: "Order is on the way." },
      out_for_delivery: { title: "Out for Delivery", desc: "Delivery executive is arriving at your address." },
      delivered: { title: "Delivered", desc: "Package handed over to customer." },
      cancelled: { title: "Order Cancelled", desc: cancellationReason || "Order was cancelled." },
      returned: { title: "Order Returned", desc: "Order return processed." },
      refund_requested: { title: "Refund Requested", desc: "Refund receiving details provided by customer." },
      refund_approved: { title: "Refund Approved", desc: "Admin approved refund for cancelled order." },
      refund_initiated: { title: "Refund Initiated", desc: "Refund payout initiated to customer's UPI / Bank account." },
      refund_completed: { title: "Refund Completed", desc: "Refund payout successfully credited." },
      return_requested: { title: "Return Requested", desc: "Return request submitted by customer." },
      return_approved: { title: "Return Approved", desc: "Return request approved. Doorstep pickup scheduled." },
      product_return_received: { title: "Product Return Received", desc: "Returned product received at facility and inspected." }
    };

    const targetItemId = req.body.itemId !== undefined ? req.body.itemId : req.body.itemIndex;

    let itemToUpdate = null;
    if (targetItemId !== undefined && Array.isArray(existingOrder.items)) {
      itemToUpdate = existingOrder.items.find(i => 
        String(i._id) === String(targetItemId) || 
        String(i.id) === String(targetItemId) ||
        (i.productId && String(i.productId._id || i.productId) === String(targetItemId))
      );
      if (!itemToUpdate && !isNaN(Number(targetItemId)) && existingOrder.items[Number(targetItemId)]) {
        itemToUpdate = existingOrder.items[Number(targetItemId)];
      }
      if (!itemToUpdate && req.body.itemIndex !== undefined && !isNaN(Number(req.body.itemIndex)) && existingOrder.items[Number(req.body.itemIndex)]) {
        itemToUpdate = existingOrder.items[Number(req.body.itemIndex)];
      }

      if (itemToUpdate) {
        if (canonicalStatus) {
          itemToUpdate.status = canonicalStatus;
        }
        if (req.body.deliveryMode || req.body.deliveryType) {
          itemToUpdate.deliveryType = req.body.deliveryMode || req.body.deliveryType;
        }
        if (req.body.courierName || req.body.trackingNumber !== undefined || req.body.trackingUrl) {
          itemToUpdate.thirdPartyDetails = {
            ...itemToUpdate.thirdPartyDetails,
            courierName: req.body.courierName || itemToUpdate.thirdPartyDetails?.courierName || "",
            trackingNumber: req.body.trackingNumber !== undefined ? req.body.trackingNumber : (itemToUpdate.thirdPartyDetails?.trackingNumber || ""),
            trackingUrl: req.body.trackingUrl || itemToUpdate.thirdPartyDetails?.trackingUrl || ""
          };
        }
        if (req.body.selfDeliveryDetails) {
          itemToUpdate.selfDeliveryDetails = {
            ...itemToUpdate.selfDeliveryDetails,
            ...req.body.selfDeliveryDetails
          };
        }

        // Recalculate overall status across all items
        const computedOverall = calculateOverallOrderStatus(existingOrder.items);
        existingOrder.overallStatus = computedOverall;
        existingOrder.status = computedOverall;

        // Append item-specific timeline event
        existingOrder.timeline.push({
          status: canonicalStatus || computedOverall,
          title: `Item '${itemToUpdate.name}' updated to ${canonicalStatus || itemToUpdate.status}`,
          description: statusDescription || `Item status updated to ${canonicalStatus || itemToUpdate.status}. Overall order status: ${computedOverall}.`,
          location: statusLocation || "",
          timestamp: new Date(),
          updatedBy: req.user?.role ? (req.user.role.charAt(0).toUpperCase() + req.user.role.slice(1)) : "Admin"
        });
      }
    } else if (canonicalStatus) {
      // Universal order status update
      const targetRank = STAGE_RANK[newStatusKey];
      if (targetRank !== undefined && Array.isArray(existingOrder.items)) {
        // FORWARD PROMOTION RULE:
        // Promote items whose status is behind targetRank, keep items already at or ahead of targetRank!
        existingOrder.items.forEach(item => {
          const itKey = String(item.status || 'Pending').toLowerCase().trim().replace(/[\s-]+/g, '_');
          if (itKey === 'cancelled' || itKey === 'canceled') return; // Exclude cancelled items from forward promotion
          const itRank = STAGE_RANK[itKey] !== undefined ? STAGE_RANK[itKey] : 0;
          if (itRank < targetRank) {
            item.status = canonicalStatus; // Promote item behind
          }
          // Items with itRank >= targetRank stay as-is!
        });

        // Recalculate computed overall status from the updated items
        const computedOverall = calculateOverallOrderStatus(existingOrder.items);
        existingOrder.overallStatus = computedOverall;
        existingOrder.status = computedOverall;
      } else {
        existingOrder.overallStatus = canonicalStatus;
        existingOrder.status = canonicalStatus;
        if ((newStatusKey === 'cancelled' || newStatusKey === 'canceled') && Array.isArray(existingOrder.items)) {
          existingOrder.settlementStatus = 'refunded';
          existingOrder.isSettlementMatured = false;
          existingOrder.tdsAmount = 0;
          existingOrder.gstTcsAmount = 0;
          existingOrder.cgstTcsAmount = 0;
          existingOrder.sgstTcsAmount = 0;
          existingOrder.igstTcsAmount = 0;
          existingOrder.commissionAmount = 0;
          existingOrder.gstOnCommissionAmount = 0;
          existingOrder.totalDeliveryDeduction = 0;
          existingOrder.totalDeductions = 0;
          existingOrder.sellerPayout = 0;
          existingOrder.sellerSettlement = 0;
          existingOrder.netSettlementAmount = 0;
          const cnPrefix = getSellerInvoicePrefix(existingOrder.sellerStoreName || existingOrder.storeName || existingOrder.sellerName);
          const cnSeq = existingOrder.sellerCreditNoteSequence || existingOrder.sellerSequence || 1;
          const assignedCn = formatSellerCreditNoteNumber(cnPrefix, cnSeq);
          existingOrder.sellerCreditNoteNo = existingOrder.sellerCreditNoteNo || assignedCn;
          existingOrder.creditNoteNumber = existingOrder.creditNoteNumber || assignedCn;
          existingOrder.creditNoteIssuedAt = existingOrder.creditNoteIssuedAt || new Date();
          existingOrder.items.forEach(item => {
            item.status = 'Cancelled';
            item.settlementStatus = 'refunded';
            item.isSettlementMatured = false;
            item.tdsAmount = 0;
            item.gstTcsAmount = 0;
            item.cgstTcsAmount = 0;
            item.sgstTcsAmount = 0;
            item.igstTcsAmount = 0;
            item.commissionAmount = 0;
            item.gstOnCommissionAmount = 0;
            item.totalDeliveryDeduction = 0;
            item.totalDeductions = 0;
            item.netSettlementAmount = 0;
          });
        }
      }

      // Restock item inventory on cancellation or when product return is received / completed
      const restockStatuses = ["cancelled", "returned", "product_return_received", "return_completed"];
      const isCurrentRestock = restockStatuses.includes(newStatusKey);
      const isPreviousRestock = restockStatuses.includes(previousStatusKey);

      if (isCurrentRestock && !isPreviousRestock) {
        for (const item of existingOrder.items) {
          await incrementItemStock(item);
        }
        if (cancellationReason) existingOrder.cancellationReason = cancellationReason;
      }

      // Sync sub-document statuses
      if (newStatusKey === "refund_approved") {
        existingOrder.refundStatus = "Refund Approved";
      } else if (newStatusKey === "refund_initiated") {
        existingOrder.refundStatus = "Refund Initiated";
        if (existingOrder.returnRequest) existingOrder.returnRequest.status = "refund_initiated";
      } else if (newStatusKey === "refund_completed" || newStatusKey === "refunded") {
        existingOrder.paymentStatus = "refunded";
        existingOrder.refundStatus = "Refund Completed";
        if (existingOrder.returnRequest) existingOrder.returnRequest.status = "refund_completed";
        const cnPrefix2 = getSellerInvoicePrefix(existingOrder.sellerStoreName || existingOrder.storeName || existingOrder.sellerName);
        const cnSeq2 = existingOrder.sellerCreditNoteSequence || existingOrder.sellerSequence || 1;
        const assignedCn2 = formatSellerCreditNoteNumber(cnPrefix2, cnSeq2);
        existingOrder.sellerCreditNoteNo = existingOrder.sellerCreditNoteNo || assignedCn2;
        existingOrder.creditNoteNumber = existingOrder.creditNoteNumber || assignedCn2;
        existingOrder.creditNoteIssuedAt = existingOrder.creditNoteIssuedAt || new Date();
        existingOrder.settlementStatus = "refunded";
        existingOrder.isSettlementMatured = false;
        existingOrder.tdsAmount = 0;
        existingOrder.gstTcsAmount = 0;
        existingOrder.cgstTcsAmount = 0;
        existingOrder.sgstTcsAmount = 0;
        existingOrder.igstTcsAmount = 0;
        existingOrder.commissionAmount = 0;
        existingOrder.gstOnCommissionAmount = 0;
        existingOrder.totalDeliveryDeduction = 0;
        existingOrder.totalDeductions = 0;
        existingOrder.sellerPayout = 0;
        existingOrder.sellerSettlement = 0;
        existingOrder.netSettlementAmount = 0;
        if (Array.isArray(existingOrder.items)) {
          existingOrder.items.forEach(it => {
            it.settlementStatus = "refunded";
            it.isSettlementMatured = false;
            it.tdsAmount = 0;
            it.gstTcsAmount = 0;
            it.cgstTcsAmount = 0;
            it.sgstTcsAmount = 0;
            it.igstTcsAmount = 0;
            it.commissionAmount = 0;
            it.gstOnCommissionAmount = 0;
            it.totalDeliveryDeduction = 0;
            it.totalDeductions = 0;
            it.netSettlementAmount = 0;
          });
        }
      } else if (newStatusKey === "exchanged") {
        const exchangedNow = new Date();
        existingOrder.exchangedAt = existingOrder.exchangedAt || exchangedNow;
        if (existingOrder.returnRequest) {
          existingOrder.returnRequest.status = "exchanged";
          existingOrder.returnRequest.exchangedAt = existingOrder.returnRequest.exchangedAt || exchangedNow;
        }
        const exchangeSettlementDueDate = new Date(exchangedNow.getTime() + 1 * 24 * 60 * 60 * 1000);
        existingOrder.settlementDueDate = exchangeSettlementDueDate;
        existingOrder.settlementStatus = "pending_exchange_buffer";
        existingOrder.isSettlementMatured = false;
        const exItemId = existingOrder.returnRequest?.itemId ? String(existingOrder.returnRequest.itemId) : null;
        const exItemName = existingOrder.returnRequest?.itemName ? String(existingOrder.returnRequest.itemName).trim().toLowerCase() : null;
        if (Array.isArray(existingOrder.items)) {
          existingOrder.items.forEach(it => {
            const isTargetExch = (exItemId || exItemName)
              ? ((exItemId && String(it._id || it.id || it.productId) === exItemId) || (exItemName && String(it.name || '').trim().toLowerCase() === exItemName))
              : true;
            if (isTargetExch) {
              it.exchangedAt = exchangedNow;
              it.settlementDueDate = exchangeSettlementDueDate;
              it.settlementStatus = "pending_exchange_buffer";
              it.isSettlementMatured = false;
              it.status = "Exchanged";
            }
          });
        }
      } else if (newStatusKey === "exchange_dispatched") {
        if (existingOrder.returnRequest) existingOrder.returnRequest.status = "exchange_dispatched";
        const existingOtp = String(existingOrder.deliveryOtp || existingOrder.selfDeliveryDetails?.deliveryOtp || "").trim();
        const activeOtp = /^\d{4}$/.test(existingOtp) ? existingOtp : Math.floor(1000 + Math.random() * 9000).toString();
        const now = new Date();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        existingOrder.deliveryOtp = activeOtp;
        if (!existingOrder.selfDeliveryDetails) existingOrder.selfDeliveryDetails = {};
        existingOrder.selfDeliveryDetails.deliveryOtp = activeOtp;
        existingOrder.selfDeliveryDetails.otpLastSentAt = now;
        existingOrder.selfDeliveryDetails.otpExpiresAt = expiresAt;
        if (Array.isArray(existingOrder.items)) {
          existingOrder.items.forEach(it => {
            it.deliveryOtp = activeOtp;
            if (!it.selfDeliveryDetails) it.selfDeliveryDetails = {};
            it.selfDeliveryDetails.deliveryOtp = activeOtp;
            it.selfDeliveryDetails.otpLastSentAt = now;
            it.selfDeliveryDetails.otpExpiresAt = expiresAt;
          });
        }
        const custPhone = existingOrder.customer?.phone || existingOrder.shippingAddress?.phone || existingOrder.phone;
        const cleanPhone = String(custPhone || "").replace(/\D/g, "").slice(-10);
        if (cleanPhone && cleanPhone.length === 10) {
          sendFast2SmsExchangeOtp(cleanPhone, existingOrder.orderId, activeOtp).catch(() => {});
        }
      } else if (newStatusKey === "pickup_scheduled") {
        if (existingOrder.returnRequest) existingOrder.returnRequest.status = "pickup_scheduled";
        const existingOtp = String(existingOrder.deliveryOtp || existingOrder.selfDeliveryDetails?.deliveryOtp || "").trim();
        const activeOtp = /^\d{4}$/.test(existingOtp) ? existingOtp : Math.floor(1000 + Math.random() * 9000).toString();
        const now = new Date();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        existingOrder.deliveryOtp = activeOtp;
        if (!existingOrder.selfDeliveryDetails) existingOrder.selfDeliveryDetails = {};
        existingOrder.selfDeliveryDetails.deliveryOtp = activeOtp;
        existingOrder.selfDeliveryDetails.otpLastSentAt = now;
        existingOrder.selfDeliveryDetails.otpExpiresAt = expiresAt;
        if (Array.isArray(existingOrder.items)) {
          existingOrder.items.forEach(it => {
            it.deliveryOtp = activeOtp;
            if (!it.selfDeliveryDetails) it.selfDeliveryDetails = {};
            it.selfDeliveryDetails.deliveryOtp = activeOtp;
            it.selfDeliveryDetails.otpLastSentAt = now;
            it.selfDeliveryDetails.otpExpiresAt = expiresAt;
          });
        }
        const custPhone = existingOrder.customer?.phone || existingOrder.shippingAddress?.phone || existingOrder.phone;
        const cleanPhone = String(custPhone || "").replace(/\D/g, "").slice(-10);
        if (cleanPhone && cleanPhone.length === 10) {
          const isExchange = existingOrder.returnRequest?.type === 'exchange';
          if (isExchange) {
            sendFast2SmsExchangeOtp(cleanPhone, existingOrder.orderId, activeOtp).catch(() => {});
          } else {
            sendFast2SmsReturnOtp(cleanPhone, existingOrder.orderId, activeOtp).catch(() => {});
          }
        }
      } else if (newStatusKey === "return_approved" || newStatusKey === "approved") {
        if (existingOrder.returnRequest) existingOrder.returnRequest.status = "approved";
      } else if (newStatusKey === "exchange_approved") {
        if (existingOrder.returnRequest) existingOrder.returnRequest.status = "exchange_approved";
      } else if (newStatusKey === "product_return_received" || newStatusKey === "product_received") {
        if (existingOrder.returnRequest) existingOrder.returnRequest.status = "product_received";
      }

      // If order is delivered, verify payment status for COD and credit seller wallet balance
      if (newStatusKey === "delivered" && previousStatusKey !== "delivered") {
        existingOrder.deliveredAt = existingOrder.deliveredAt || new Date();
        const isCodOrder = String(existingOrder.paymentMethod || "").toUpperCase().includes("COD") || existingOrder.paymentStatus !== "paid";
        if (isCodOrder) {
          existingOrder.paymentStatus = "paid";
          existingOrder.codCollectedAt = new Date();
          existingOrder.codCollectedBy = req.user?.name || req.body.deliveryPersonName || "Delivery Executive";
        }

        const Seller = (await import("../models/Seller.js")).default;
        for (const item of existingOrder.items) {
          if (item.sellerId) {
            const seller = await Seller.findById(item.sellerId);
            if (seller) {
              const itemTotal = item.total || (item.finalPrice || item.price) * (item.quantity || 1);
              const commRate = Number(item.commissionRate ?? existingOrder.commissionRate ?? seller.commissionRate ?? seller.commissionPercentage ?? 10);
              const ordTotal = Number(existingOrder.totalAmount || existingOrder.total || itemTotal);
              const itemGstRate = Number(item.gstPercent ?? item.gstPercentage ?? item.gstRate ?? item.gst ?? (item.category?.toLowerCase()?.includes('book') ? 0 : 5));
              const stl = calculateSellerSettlement(itemTotal, {
                commissionRate: commRate,
                sellerGstNumber: seller.gstNumber,
                paymentMethod: existingOrder.paymentMethod,
                deliveryMode: existingOrder.deliveryMode || item.deliveryType,
                courierName: existingOrder.courierName || item.thirdPartyDetails?.courierName,
                orderTotal: ordTotal,
                sellerState: seller.state || seller.storeDetails?.state || "Uttar Pradesh",
                customerState: existingOrder.shippingAddress?.state || "Uttar Pradesh",
                gstRate: itemGstRate,
                category: item.category || "",
                deliveryCharge: Number(existingOrder.shippingFee ?? existingOrder.shippingCost ?? existingOrder.shippingAmount ?? existingOrder.deliveryCharge ?? 49),
                shippingFee: Number(existingOrder.shippingFee ?? existingOrder.shippingCost ?? existingOrder.shippingAmount ?? 0),
                shippingCost: Number(existingOrder.shippingFee ?? existingOrder.shippingCost ?? existingOrder.shippingAmount ?? 0),
                codFee: Number(existingOrder.codFee ?? existingOrder.appliedCodFee ?? existingOrder.codCharges ?? 0),
                appliedCodFee: Number(existingOrder.appliedCodFee ?? existingOrder.codFee ?? 0),
                freeDeliveryThreshold: Number(existingOrder.freeDeliveryThreshold ?? 401),
                deliveryChargeBorneBy: (ordTotal >= Number(existingOrder.freeDeliveryThreshold ?? 401)) 
                  ? 'admin' 
                  : (Number(existingOrder.shippingFee ?? existingOrder.shippingCost ?? existingOrder.shippingAmount ?? 0) > 0 
                      ? 'customer' 
                      : (existingOrder.deliveryChargeBorneBy || 'seller'))
              });

              item.commissionRate = stl.commissionRate;
              item.commissionAmount = stl.commissionAmount;
              item.gstOnCommissionRate = stl.gstOnCommissionRate;
              item.gstOnCommissionAmount = stl.gstOnCommissionAmount;
              item.tdsRate = stl.tdsRate;
              item.tdsAmount = stl.tdsAmount;
              item.isIntraState = stl.isIntraState;
              item.gstTcsRate = stl.gstTcsRate;
              item.gstTcsAmount = stl.gstTcsAmount;
              item.cgstTcsRate = stl.cgstTcsRate;
              item.cgstTcsAmount = stl.cgstTcsAmount;
              item.sgstTcsRate = stl.sgstTcsRate;
              item.sgstTcsAmount = stl.sgstTcsAmount;
              item.igstTcsRate = stl.igstTcsRate;
              item.igstTcsAmount = stl.igstTcsAmount;
              item.deliveryChargeAmount = stl.deliveryChargeAmount;
              item.gstOnDeliveryRate = stl.gstOnDeliveryRate;
              item.gstOnDeliveryAmount = stl.gstOnDeliveryAmount;
              item.totalDeliveryDeduction = stl.totalDeliveryDeduction;
              item.deliveryChargeBorneBy = stl.deliveryChargeBorneBy;
              item.codChargeAmount = stl.codChargeAmount;
              item.codChargeRetainedBy = stl.codChargeRetainedBy;
              item.codChargeDeduction = stl.codChargeDeduction;
              item.isCodExempted = stl.isCodExempted;
              item.totalDeductions = stl.totalDeductions;
              item.netSettlementAmount = stl.netSettlement;
              item.settlementRule = stl.ruleCode;

              const maturity = calculateSettlementMaturity({ order: existingOrder, item, deliveredAt: new Date(), now: new Date() });
              item.settlementDueDate = maturity.settlementDueDate;
              item.returnWindowDays = maturity.returnWindowDays;

              const sellerNetSettlement = stl.netSettlement;
              const realEarnings = stl.isSellerCollectedCash
                ? Math.round((itemTotal - stl.totalDeductions) * 100) / 100
                : sellerNetSettlement;

              if (maturity.isMatured) {
                item.settlementStatus = "credited";
                item.isSettlementMatured = true;
                item.settlementMaturedAt = new Date();
                seller.walletBalance = Math.round(((seller.walletBalance || 0) + sellerNetSettlement) * 100) / 100;
              } else {
                item.settlementStatus = "pending_return_window";
                item.isSettlementMatured = false;
                seller.pendingSettlementBalance = Math.round(((seller.pendingSettlementBalance || 0) + sellerNetSettlement) * 100) / 100;
              }

              seller.totalEarnings = Math.round(((seller.totalEarnings || 0) + realEarnings) * 100) / 100;
              await seller.save();

              existingOrder.settlementDueDate = maturity.settlementDueDate;
              existingOrder.settlementStatus = maturity.isMatured ? "credited" : "pending_return_window";
            }
          }
        }
      }

      // Append to timeline
      const statusMeta = statusTextMap[newStatusKey] || {
        title: `Order ${canonicalStatus}`,
        desc: `Order status updated to ${canonicalStatus}.`
      };

      const updatedByRole = req.user?.role
        ? req.user.role.charAt(0).toUpperCase() + req.user.role.slice(1)
        : "Admin";

      existingOrder.timeline.push({
        status: canonicalStatus,
        title: statusTitle || statusMeta.title,
        description: statusDescription || statusMeta.desc,
        location: statusLocation || "",
        timestamp: new Date(),
        updatedBy: updatedByRole
      });
    }

    if (req.body.refundStatus) existingOrder.refundStatus = req.body.refundStatus;
    if (paymentStatus) existingOrder.paymentStatus = paymentStatus;
    if (estimatedDeliveryDate) existingOrder.estimatedDeliveryDate = new Date(estimatedDeliveryDate);
    if (req.body.deliveryMode) existingOrder.deliveryMode = req.body.deliveryMode;
    if (req.body.courierName) existingOrder.courierName = req.body.courierName;
    if (req.body.carrier) existingOrder.carrier = req.body.carrier;
    if (req.body.trackingNumber !== undefined) existingOrder.trackingNumber = req.body.trackingNumber;
    if (req.body.trackingUrl) existingOrder.trackingUrl = req.body.trackingUrl;
    if (req.body.sellerDetails) existingOrder.sellerDetails = req.body.sellerDetails;

    const effectiveDeliveryMode = String(req.body.deliveryMode || existingOrder.deliveryMode || "").toLowerCase();
    const effectiveCourier = String(req.body.courierName || existingOrder.courierName || "").trim();
    const hasCourier = Boolean(effectiveCourier && effectiveCourier !== "N/A" && effectiveCourier !== "null");
    const isExplicitSelf = effectiveDeliveryMode === "self_delivery" || Boolean(
      req.body.selfDeliveryDetails?.deliveryPersonName ||
      req.body.selfDeliveryDetails?.deliveryPartnerToken ||
      existingOrder.selfDeliveryDetails?.deliveryPersonName ||
      existingOrder.selfDeliveryDetails?.deliveryPartnerToken
    );
    const isExplicitThirdParty = effectiveDeliveryMode === "third_party" || (hasCourier && !isExplicitSelf);

    // Ensure 4-digit Delivery OTP is assigned whenever order is confirmed or fulfilled via Self Delivery
    if (isExplicitSelf) {
      let activeOtp = String(
        req.body.deliveryOtp ||
        req.body.selfDeliveryDetails?.deliveryOtp ||
        existingOrder.deliveryOtp ||
        existingOrder.selfDeliveryDetails?.deliveryOtp ||
        ""
      ).trim();

      if (!/^\d{4}$/.test(activeOtp)) {
        activeOtp = Math.floor(1000 + Math.random() * 9000).toString();
      }

      existingOrder.deliveryOtp = activeOtp;
      if (!existingOrder.selfDeliveryDetails) existingOrder.selfDeliveryDetails = {};
      existingOrder.selfDeliveryDetails.deliveryOtp = activeOtp;

      if (req.body.selfDeliveryDetails) {
        req.body.selfDeliveryDetails.deliveryOtp = activeOtp;
      }
    }

    let whatsappDispatchResult = null;
    if (req.body.selfDeliveryDetails && req.body.selfDeliveryDetails.deliveryPersonPhone) {
      whatsappDispatchResult = await sendDeliveryPartnerWhatsAppDispatch({
        order: existingOrder,
        selfDeliveryDetails: req.body.selfDeliveryDetails,
        clientAppUrl: req.headers.origin || req.headers.referer
      });

      if (whatsappDispatchResult.success) {
        existingOrder.selfDeliveryDetails = {
          ...existingOrder.selfDeliveryDetails,
          ...req.body.selfDeliveryDetails,
          whatsappStatus: "sent",
          whatsappSentAt: whatsappDispatchResult.sentAt,
          whatsappMessageId: whatsappDispatchResult.messageId,
          whatsappSentTo: whatsappDispatchResult.sentTo
        };
        existingOrder.timeline.push({
          status: "whatsapp_sent",
          title: "WhatsApp Link Sent to Delivery Boy",
          description: `Automated WhatsApp dispatch sent to ${req.body.selfDeliveryDetails.deliveryPersonName} (${req.body.selfDeliveryDetails.deliveryPersonPhone}) with live tracking portal link: ${existingOrder.selfDeliveryDetails?.trackingUrl || whatsappDispatchResult.trackingLink} (Ref: ${whatsappDispatchResult.messageId})`,
          timestamp: new Date(),
          updatedBy: req.user?.role ? (req.user.role.charAt(0).toUpperCase() + req.user.role.slice(1)) : "Admin"
        });
      } else {
        existingOrder.selfDeliveryDetails = {
          ...existingOrder.selfDeliveryDetails,
          ...req.body.selfDeliveryDetails,
          whatsappStatus: "failed"
        };
      }
    } else if (req.body.selfDeliveryDetails) {
      existingOrder.selfDeliveryDetails = {
        ...existingOrder.selfDeliveryDetails,
        ...req.body.selfDeliveryDetails
      };
    }

    // Dynamically recalculate and synchronize settlementRule across order and items based on resolved paymentMethod and deliveryMode
    const isCod = String(existingOrder.paymentMethod || "").toUpperCase().includes("COD");
    const dynamicSettlementRule = isCod
      ? (isExplicitThirdParty ? "COD_THIRD_PARTY_DELIVERY" : "COD_SELF_DELIVERY")
      : (isExplicitThirdParty ? "ONLINE_THIRD_PARTY_DELIVERY" : "ONLINE_SELF_DELIVERY");

    existingOrder.settlementRule = dynamicSettlementRule;

    // Propagate fulfillment details to all order items ONLY if updating entire order
    if (!itemToUpdate && existingOrder.items && Array.isArray(existingOrder.items)) {
      existingOrder.items.forEach(item => {
        if (req.body.deliveryMode) item.deliveryType = req.body.deliveryMode;
        item.settlementRule = dynamicSettlementRule;
        if (req.body.courierName || req.body.trackingNumber !== undefined || req.body.trackingUrl) {
          item.thirdPartyDetails = {
            ...item.thirdPartyDetails,
            courierName: req.body.courierName || existingOrder.courierName || "",
            trackingNumber: req.body.trackingNumber !== undefined ? req.body.trackingNumber : (existingOrder.trackingNumber || ""),
            trackingUrl: req.body.trackingUrl || existingOrder.trackingUrl || ""
          };
          if (isExplicitThirdParty) {
            item.selfDeliveryDetails = undefined;
          }
        }
        if (isExplicitSelf) {
          item.deliveryType = "self_delivery";
          item.deliveryOtp = existingOrder.deliveryOtp;
          item.selfDeliveryDetails = {
            ...(item.selfDeliveryDetails || {}),
            ...(existingOrder.selfDeliveryDetails || {})
          };
        }
      });
    } else if (itemToUpdate) {
      itemToUpdate.settlementRule = dynamicSettlementRule;
      if (isExplicitSelf) {
        itemToUpdate.deliveryType = "self_delivery";
        itemToUpdate.deliveryOtp = existingOrder.deliveryOtp;
        if (existingOrder.selfDeliveryDetails) {
          itemToUpdate.selfDeliveryDetails = {
            ...(itemToUpdate.selfDeliveryDetails || {}),
            ...existingOrder.selfDeliveryDetails
          };
        }
      }
    }

    existingOrder.markModified("items");
    existingOrder.markModified("selfDeliveryDetails");
    existingOrder.markModified("thirdPartyDetails");
    existingOrder.markModified("settlementRule");
    existingOrder.markModified("deliveryOtp");
    existingOrder.markModified("overallStatus");
    existingOrder.markModified("status");
    await existingOrder.save();

    // Trigger instant settlement balance reconciliation for seller
    try {
      const primarySellerId = existingOrder.sellerId || (existingOrder.items && existingOrder.items[0]?.sellerId);
      if (primarySellerId) {
        reconcileSellerSettlementBalances(primarySellerId).catch(() => {});
      }
    } catch (reconcileErr) {
      console.warn("Auto-reconcile on updateOrder warning:", reconcileErr.message);
    }

    // Fast2SMS DLT Status Update SMS (Confirmed, Shipped, Out for Delivery, Delivered, Cancelled)
    try {
      const isConfirmedState = newStatusKey === "confirmed" || String(existingOrder.overallStatus || "").toLowerCase() === "confirmed";
      const isNewlySwitchingToSelf = isExplicitSelf && (req.body.deliveryMode === "self_delivery" || req.body.deliveryType === "self_delivery");
      const shouldSendStatusSms = (newStatusKey && newStatusKey !== previousStatusKey) || (isNewlySwitchingToSelf && isConfirmedState);

      if (shouldSendStatusSms) {
        const smsStatusTarget = newStatusKey || (isConfirmedState ? "confirmed" : "");
        if (smsStatusTarget) {
          sendOrderStatusSms(existingOrder, smsStatusTarget, {
            trackingUrl: existingOrder.trackingUrl || existingOrder.selfDeliveryDetails?.trackingUrl,
            refundAmount: existingOrder.refundDetails?.amount || existingOrder.totalAmount,
            deliveryMode: effectiveDeliveryMode,
            deliveryOtp: existingOrder.deliveryOtp || existingOrder.selfDeliveryDetails?.deliveryOtp
          }).catch(err => console.warn("⚠️ [FAST2SMS] Order status SMS error:", err.message));
        }
      }
    } catch (smsErr) {}

    try {
      broadcastRealtimeEvent({
        type: "ORDER_UPDATED",
        orderId: existingOrder.orderId,
        masterOrderId: existingOrder.masterOrderId,
        sellerId: existingOrder.sellerId,
        total: existingOrder.totalAmount,
        status: existingOrder.overallStatus || existingOrder.status
      });
    } catch (rtErr) {
      console.warn("⚠️ Realtime broadcast error (updateOrder):", rtErr.message);
    }

    res.json({ success: true, message: "Order updated successfully", order: existingOrder, whatsappDispatch: whatsappDispatchResult });
  } catch (error) {
    res.status(400).json({ message: "Failed to update order", error: error.message });
  }
};

// Re-send WhatsApp Link to Delivery Boy by Admin
export const resendAdminDeliveryBoyWhatsApp = async (req, res) => {
  try {
    const { id } = req.params;
    const isMongoId = mongoose.Types.ObjectId.isValid(id);
    let order = isMongoId ? await Order.findById(id) : null;
    if (!order) {
      order = await Order.findOne({ $or: [{ orderId: id }, { id: id }] });
    }
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
        updatedBy: req.user?.role ? (req.user.role.charAt(0).toUpperCase() + req.user.role.slice(1)) : "Admin"
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

// 7. Delete order
export const deleteOrder = async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.json({ message: "Order deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete order", error: error.message });
  }
};


// 7. Download Flipkart / Amazon Style GST Tax Invoice PDF
export const downloadInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const cleanId = String(id || '').replace(/^#/, '').trim();
    const isMongoId = mongoose.Types.ObjectId.isValid(cleanId) || mongoose.Types.ObjectId.isValid(id);
    const targetMongoId = mongoose.Types.ObjectId.isValid(cleanId) ? cleanId : (mongoose.Types.ObjectId.isValid(id) ? id : null);
    let order = targetMongoId
      ? await Order.findById(targetMongoId)
          .populate("userId", "name email phone addresses")
          .populate("items.productId", "name price images mrp sellerId sellerStoreName storeName")
      : null;
    if (!order) {
      order = await Order.findOne({ 
        $or: [
          { orderId: cleanId }, 
          { id: cleanId }, 
          { orderId: `#${cleanId}` }, 
          { id: `#${cleanId}` },
          { orderId: new RegExp(`^#?${cleanId}$`, "i") },
          { id: new RegExp(`^#?${cleanId}$`, "i") }
        ] 
      })
        .populate("userId", "name email phone addresses")
        .populate("items.productId", "name price images mrp sellerId sellerStoreName storeName");
    }

    let isBulkOrder = false;
    let bulkOrderDoc = null;

    if (!order) {
      const SchoolBulkOrder = (await import("../models/SchoolBulkOrder.js")).default;
      const bulkQuery = [
        { referenceId: id },
        { "deliveryDetails.deliveryPartnerToken": id },
        { "deliveryDetails.trackingId": id }
      ];
      if (isMongoId) {
        bulkQuery.push({ _id: id });
      }
      bulkOrderDoc = await SchoolBulkOrder.findOne({ $or: bulkQuery });
      if (bulkOrderDoc) {
        isBulkOrder = true;
      }
    }

    if (!order && !bulkOrderDoc) {
      return res.status(404).json({ message: "Order not found" });
    }

    let enrichedOrder = null;

    if (isBulkOrder && bulkOrderDoc) {
      const authHeader = req.headers?.["authorization"] || "";
      let isAdmin = req.user?.role === "admin" || req.user?.role === "super_admin";
      let authUserId = req.user?.id ? req.user.id.toString() : "";
      let authUserPhone = String(req.user?.phone || req.user?.mobile || "").replace(/\D/g, "").slice(-10);
      let authUserEmail = String(req.user?.email || "").trim().toLowerCase();

      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const rawToken = authHeader.split(" ")[1]?.trim();
          if (rawToken && rawToken !== "undefined" && rawToken !== "null") {
            const jwtModule = (await import("jsonwebtoken")).default;
            const decoded = jwtModule.decode(rawToken);
            if (decoded) {
              if (decoded.role === "admin" || decoded.role === "super_admin" || decoded.role === "subadmin") {
                isAdmin = true;
              }
              if (!authUserId && (decoded.id || decoded._id || decoded.userId)) {
                authUserId = String(decoded.id || decoded._id || decoded.userId);
              }
              if (!authUserPhone && (decoded.phone || decoded.mobile)) {
                authUserPhone = String(decoded.phone || decoded.mobile).replace(/\D/g, "").slice(-10);
              }
              if (!authUserEmail && decoded.email) {
                authUserEmail = String(decoded.email).trim().toLowerCase();
              }
            }
          }
        } catch (e) {}
      }

      if (!authUserId) authUserId = String(req.headers?.["x-user-id"] || req.headers?.["x-seller-id"] || "");
      if (!authUserPhone) authUserPhone = String(req.headers?.["x-user-phone"] || "").replace(/\D/g, "").slice(-10);
      if (!authUserEmail) authUserEmail = String(req.headers?.["x-user-email"] || "").trim().toLowerCase();

      const bulkUserIdStr = bulkOrderDoc.userId ? bulkOrderDoc.userId.toString() : "";
      const bulkSellerIdStr = bulkOrderDoc.sellerId ? String(bulkOrderDoc.sellerId._id || bulkOrderDoc.sellerId) : "";
      const isAwardedSeller = Boolean(bulkSellerIdStr && authUserId && bulkSellerIdStr === authUserId);

      const bulkPhone = String(bulkOrderDoc.userPhone || bulkOrderDoc.contactPhone || "").replace(/\D/g, "").slice(-10);
      const bulkEmail = String(bulkOrderDoc.userEmail || bulkOrderDoc.contactEmail || "").trim().toLowerCase();

      const isOwner = Boolean(
        (bulkUserIdStr && authUserId && bulkUserIdStr === authUserId) ||
        (bulkPhone && authUserPhone && bulkPhone.length >= 10 && bulkPhone === authUserPhone) ||
        (bulkEmail && authUserEmail && !bulkEmail.includes("@bookvardi.local") && bulkEmail === authUserEmail)
      );

      if (!isAdmin && !isAwardedSeller && !isOwner) {
        return res.status(403).json({ message: "Not authorized to download this invoice" });
      }

      const winningQuote = (bulkOrderDoc.quotations || []).find(
        q => String(q._id) === String(bulkOrderDoc.acceptedQuoteId) ||
             q.negotiationStage === "seller_accepted_counter" ||
             q.status === "approved" ||
             q.status === "buyer_accepted"
      );

      const totalQty = Number(bulkOrderDoc.totalQuantity || (Array.isArray(bulkOrderDoc.requirements) ? bulkOrderDoc.requirements.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0) : 100));
      const totalAmount = Number(bulkOrderDoc.overallBudget || bulkOrderDoc.targetBudgetPerKit || winningQuote?.quoteAmount || 0);
      const avgPrice = totalQty > 0 ? Math.round(totalAmount / totalQty) : 0;
      const advancePaid = Number(bulkOrderDoc.advancePaidAmount || 0);
      const remainingAmount = Math.max(0, totalAmount - advancePaid);
      const isPaid = bulkOrderDoc.remainingPaymentStatus === "paid" || bulkOrderDoc.status === "completed" || bulkOrderDoc.status === "delivered";

      const items = Array.isArray(bulkOrderDoc.requirements) && bulkOrderDoc.requirements.length > 0
        ? bulkOrderDoc.requirements.map((r, i) => {
            const q = Number(r.quantity || 1);
            const p = Number(r.sellerPricePerUnit || (winningQuote?.itemPrices?.find(ip => String(ip.itemId || ip.itemName) === String(r._id || r.itemName))?.pricePerUnit) || avgPrice || 100);
            return {
              id: r._id || i + 1,
              name: r.itemName || "Institutional Uniform / Supply Kit",
              price: p,
              finalPrice: p,
              quantity: q,
              total: p * q,
              size: r.size || "",
              category: r.category || "School Uniform",
              gst: 5,
              gstPercent: 5,
              sellerName: winningQuote?.sellerStoreName || winningQuote?.sellerName || "BookVardi Verified Seller",
              storeName: winningQuote?.sellerStoreName || winningQuote?.sellerName || "BookVardi Verified Seller"
            };
          })
        : [{
            id: 1,
            name: "Institutional Bulk Supply Kit",
            price: avgPrice || totalAmount,
            finalPrice: avgPrice || totalAmount,
            quantity: totalQty || 1,
            total: totalAmount,
            category: "School Uniform",
            gst: 5,
            gstPercent: 5,
            sellerName: winningQuote?.sellerStoreName || winningQuote?.sellerName || "BookVardi Verified Seller",
            storeName: winningQuote?.sellerStoreName || winningQuote?.sellerName || "BookVardi Verified Seller"
          }];

      const formattedStatus = (bulkOrderDoc.status === "completed" || bulkOrderDoc.status === "delivered")
        ? "Delivered"
        : (bulkOrderDoc.status === "out_for_delivery" ? "Out for Delivery" : (bulkOrderDoc.status === "confirmed" ? "Confirmed" : (bulkOrderDoc.status || "Confirmed")));

      enrichedOrder = {
        _id: bulkOrderDoc._id,
        orderId: bulkOrderDoc.referenceId || String(bulkOrderDoc._id),
        id: bulkOrderDoc.referenceId || String(bulkOrderDoc._id),
        isBulkOrder: true,
        createdAt: bulkOrderDoc.createdAt || new Date(),
        date: bulkOrderDoc.createdAt ? new Date(bulkOrderDoc.createdAt).toLocaleDateString("en-IN") : new Date().toLocaleDateString("en-IN"),
        overallStatus: formattedStatus,
        status: formattedStatus,
        paymentStatus: isPaid ? "paid" : (bulkOrderDoc.advancePaymentStatus === "paid" ? "partially_paid" : "pending"),
        paymentMethod: "Online / UPI (Razorpay)",
        customerName: bulkOrderDoc.institutionName || bulkOrderDoc.contactName || "School Representative",
        customerPhone: bulkOrderDoc.contactPhone || bulkOrderDoc.userPhone || "",
        customerEmail: bulkOrderDoc.contactEmail || bulkOrderDoc.userEmail || "",
        customer: {
          name: bulkOrderDoc.institutionName || bulkOrderDoc.contactName || "School Representative",
          phone: bulkOrderDoc.contactPhone || bulkOrderDoc.userPhone || "",
          email: bulkOrderDoc.contactEmail || bulkOrderDoc.userEmail || ""
        },
        shippingAddress: {
          name: bulkOrderDoc.institutionName || bulkOrderDoc.contactName || "School Representative",
          street: bulkOrderDoc.address || "Campus Address",
          city: bulkOrderDoc.city || "",
          state: bulkOrderDoc.state || "",
          pincode: bulkOrderDoc.pincode || "",
          phone: bulkOrderDoc.contactPhone || bulkOrderDoc.userPhone || ""
        },
        items,
        totalAmount,
        total: totalAmount,
        subtotal: totalAmount,
        advancePaidAmount: advancePaid,
        remainingAmount: remainingAmount,
        sellerDetails: {
          sellerId: winningQuote?.sellerId || bulkOrderDoc.sellerId || null,
          storeName: winningQuote?.sellerStoreName || winningQuote?.sellerName || "BookVardi Verified Seller",
          sellerName: winningQuote?.sellerName || winningQuote?.sellerStoreName || "BookVardi Verified Seller",
          phone: winningQuote?.sellerPhone || "",
          email: winningQuote?.sellerEmail || "",
          address: winningQuote?.sellerCity || ""
        }
      };
    } else {
      if (req.user) {
        const reqUserIdStr = req.user.id ? req.user.id.toString() : "";
        const orderUserIdStr = order.userId ? (order.userId._id ? order.userId._id.toString() : order.userId.toString()) : "";
        const isOwner = Boolean(orderUserIdStr && reqUserIdStr && orderUserIdStr === reqUserIdStr);
        const isAdmin = req.user.role === "admin" || req.user.role === "super_admin" || req.user.role === "subadmin";
        const isSeller =
          req.user.role === "seller" &&
          order.items.some(
            (item) => item.sellerId && (item.sellerId._id || item.sellerId).toString() === reqUserIdStr
          );

        if (!isOwner && !isAdmin && !isSeller) {
          return res.status(403).json({ message: "Not authorized to download this invoice" });
        }
      }

      const orderObj = order.toObject ? order.toObject() : order;
      enrichedOrder = (await enrichOrdersWithSellerAndConsumer([orderObj]))[0];
    }

    const orderStatusVal = String(enrichedOrder.overallStatus || enrichedOrder.status || "").toLowerCase().trim();
    const { generateTaxInvoicePDF, generateCreditNotePDF } = await import("../services/invoiceService.js");

    if (orderStatusVal === "cancelled") {
      const filename = `CreditNote_${enrichedOrder.orderId || enrichedOrder._id}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      const pdfDoc = generateCreditNotePDF(enrichedOrder);
      return pdfDoc.pipe(res);
    }

    const filterSellerId = req.query.sellerId || req.headers["x-seller-id"] || null;
    let itemsToCheck = enrichedOrder.items || [];
    if (filterSellerId) {
      const fStr = String(filterSellerId).toLowerCase().trim();
      const fDigits = fStr.replace(/\D/g, "");
      itemsToCheck = itemsToCheck.filter((item) => {
        const sId = String(item.sellerId?._id || item.sellerId || item.sellerDetails?.sellerId || "").toLowerCase().trim();
        const sStore = String(
          item.sellerStoreName ||
          item.storeName ||
          item.sellerName ||
          item.sellerDetails?.storeName ||
          item.sellerDetails?.sellerName ||
          (typeof item.seller === 'string' ? item.seller : item.seller?.storeName) ||
          ""
        ).toLowerCase().trim();
        const sPhone = String(item.sellerPhone || item.sellerDetails?.phone || "").replace(/\D/g, "");
        const matched = (
          sId === fStr ||
          (sStore && (sStore === fStr || sStore.includes(fStr) || fStr.includes(sStore))) ||
          (fStr.length >= 8 && sId && (sId.endsWith(fStr.slice(-10)) || fStr.endsWith(sId.slice(-10)))) ||
          (fDigits.length >= 10 && sPhone && (sPhone.endsWith(fDigits.slice(-10)) || fDigits.endsWith(sPhone.slice(-10))))
        );
        return matched;
      });
      if (itemsToCheck.length === 0) {
        itemsToCheck = enrichedOrder.items || [];
      }
    }

    // STRICT PRODUCT & ORDER CONFIRMATION CHECK:
    // If order or seller's items have confirmed items, allow invoice generation for that seller
    const hasConfirmedItem = itemsToCheck.length > 0 && itemsToCheck.some((it) => {
      const itSt = String(it.status || '').toLowerCase().trim();
      return itSt && !['pending', 'placed', 'unconfirmed', 'draft', ''].includes(itSt);
    });

    const isConfirmedAndOnward = [
      "assigned", "accepted", "confirmed", "processing", "production", "packed", "shipped",
      "dispatched", "in_transit", "out_for_delivery", "delivered", "completed", "fulfilled",
      "return_requested", "returned", "exchange_requested", "exchanged", "refunded", "cancelled"
    ].includes(orderStatusVal);

    const isSellerConfirmed = hasConfirmedItem || (isConfirmedAndOnward && itemsToCheck.length > 0);

    if (filterSellerId) {
      if (!isSellerConfirmed) {
        return res.status(400).json({
          message: `Tax Invoice cannot be generated while products for this seller are pending confirmation. Items must be confirmed before generating an invoice.`
        });
      }
    } else {
      if (!hasConfirmedItem && !isConfirmedAndOnward) {
        return res.status(400).json({
          message: `Tax Invoice cannot be generated while products are pending confirmation. Current status: '${enrichedOrder.overallStatus || enrichedOrder.status || "Pending"}'. Items must be confirmed before generating an invoice.`
        });
      }
    }

    const filename = filterSellerId
      ? `Invoice_${enrichedOrder.orderId || enrichedOrder._id}_${String(filterSellerId).slice(-6)}.pdf`
      : `Invoice_${enrichedOrder.orderId || enrichedOrder._id}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    const viewQuery = String(req.query.view || req.query.audience || req.headers["x-view"] || "").toLowerCase();
    const isSellerRole = req.user?.role === "seller" || req.headers["x-is-seller"] === "true";
    const isExplicitSellerView = viewQuery === "seller" || viewQuery === "admin" || (isSellerRole && viewQuery !== "customer");

    let platformSettings = {};
    try {
      const PlatformSetting = (await import("../models/PlatformSetting.js")).default;
      platformSettings = (await PlatformSetting.findOne({ key: "global_settings" })) || {};
    } catch (e) {}

    const pdfDoc = generateTaxInvoicePDF(enrichedOrder, filterSellerId, {
      view: isExplicitSellerView ? "seller" : "customer",
      platformSetting: platformSettings,
      companyName: platformSettings.companyName,
      companyAddress: platformSettings.companyAddress,
      companyGstin: platformSettings.companyGstin,
      supportEmail: platformSettings.supportEmail || platformSettings.customerCareEmail,
      supportPhone: platformSettings.supportPhone || platformSettings.customerCarePhone
    });
    pdfDoc.pipe(res);
  } catch (error) {
    console.error("Download invoice error:", error);
    if (error.message && error.message.toLowerCase().includes("pending")) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: "Failed to generate invoice", error: error.message });
  }
};

// 7b. Dedicated Download Credit Note Endpoint
export const downloadCreditNote = async (req, res) => {
  try {
    const { id } = req.params;
    const cleanId = String(id).trim().replace(/^#+/, "");
    const isMongoId = mongoose.Types.ObjectId.isValid(cleanId);
    let order = isMongoId
      ? await Order.findById(cleanId)
          .populate("userId", "name email phone addresses")
          .populate("items.productId", "name price images mrp sellerId sellerStoreName storeName")
      : null;
    if (!order) {
      order = await Order.findOne({ $or: [{ orderId: cleanId }, { id: cleanId }, { masterOrderId: cleanId }] })
        .populate("userId", "name email phone addresses")
        .populate("items.productId", "name price images mrp sellerId sellerStoreName storeName");
    }

    if (!order) {
      try {
        const SchoolBulkOrder = (await import("../models/SchoolBulkOrder.js")).default;
        order = await SchoolBulkOrder.findOne(
          isMongoId ? { $or: [{ _id: cleanId }, { orderId: cleanId }, { id: cleanId }] } : { $or: [{ orderId: cleanId }, { id: cleanId }] }
        );
      } catch (e) {}
    }

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const clientPhone = String(req.headers["x-user-phone"] || req.query.phone || "").replace(/\D/g, "");
    if (req.user) {
      const isOwner =
        order.user?.toString() === req.user.id ||
        order.userId?.toString() === req.user.id ||
        order.customer?.phone === req.user.phone ||
        order.customer?.email === req.user.email;
      const isAdmin = req.user.role === "admin";
      const isSeller =
        req.user.role === "seller" &&
        order.items?.some(
          (item) => item.sellerId && (item.sellerId._id || item.sellerId).toString() === req.user.id
        );

      if (!isOwner && !isAdmin && !isSeller) {
        return res.status(403).json({ message: "Not authorized to download this credit note" });
      }
    } else if (clientPhone) {
      const ordPhone = String(order.customer?.phone || order.shippingAddress?.phone || "").replace(/\D/g, "");
      if (ordPhone.length >= 10 && clientPhone.length >= 10 && !ordPhone.endsWith(clientPhone.slice(-10))) {
        return res.status(403).json({ message: "Phone number does not match order record" });
      }
    }

    const orderObj = order.toObject ? order.toObject() : order;
    const enrichedOrder = (await enrichOrdersWithSellerAndConsumer([orderObj]))[0];

    const filterSellerId = req.query.sellerId || req.headers["x-seller-id"] || null;

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
      ? `ExchangeInvoice_${enrichedOrder.orderId || enrichedOrder._id}.pdf`
      : `CreditNote_${enrichedOrder.orderId || enrichedOrder._id}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    let platformSettings = {};
    try {
      const PlatformSetting = (await import("../models/PlatformSetting.js")).default;
      platformSettings = (await PlatformSetting.findOne({ key: "global_settings" })) || {};
    } catch (e) {}

    const pdfDoc = generateCreditNotePDF(enrichedOrder, filterSellerId, {
      platformSetting: platformSettings,
      companyName: platformSettings.companyName,
      companyAddress: platformSettings.companyAddress,
      companyGstin: platformSettings.companyGstin
    });
    pdfDoc.pipe(res);
  } catch (error) {
    console.error("Download credit note error:", error);
    res.status(500).json({ message: "Failed to generate credit note", error: error.message });
  }
};

// 7c. Dedicated Download Exchange Invoice Endpoint
export const downloadExchangeInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const cleanId = String(id).trim().replace(/^#+/, "");
    const isMongoId = mongoose.Types.ObjectId.isValid(cleanId);
    let order = isMongoId
      ? await Order.findById(cleanId)
          .populate("userId", "name email phone addresses")
          .populate("items.productId", "name price images mrp sellerId sellerStoreName storeName")
      : null;
    if (!order) {
      order = await Order.findOne({ $or: [{ orderId: cleanId }, { id: cleanId }, { masterOrderId: cleanId }] })
        .populate("userId", "name email phone addresses")
        .populate("items.productId", "name price images mrp sellerId sellerStoreName storeName");
    }

    if (!order) {
      try {
        const SchoolBulkOrder = (await import("../models/SchoolBulkOrder.js")).default;
        order = await SchoolBulkOrder.findOne(
          isMongoId ? { $or: [{ _id: cleanId }, { orderId: cleanId }, { id: cleanId }] } : { $or: [{ orderId: cleanId }, { id: cleanId }] }
        );
      } catch (e) {}
    }

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const clientPhone = String(req.headers["x-user-phone"] || req.query.phone || "").replace(/\D/g, "");
    if (req.user) {
      const isOwner =
        order.user?.toString() === req.user.id ||
        order.userId?.toString() === req.user.id ||
        order.customer?.phone === req.user.phone ||
        order.customer?.email === req.user.email;
      const isAdmin = req.user.role === "admin";
      const isSeller =
        req.user.role === "seller" &&
        order.items?.some(
          (item) => item.sellerId && (item.sellerId._id || item.sellerId).toString() === req.user.id
        );

      if (!isOwner && !isAdmin && !isSeller) {
        return res.status(403).json({ message: "Not authorized to download this exchange invoice" });
      }
    } else if (clientPhone) {
      const ordPhone = String(order.customer?.phone || order.shippingAddress?.phone || "").replace(/\D/g, "");
      if (ordPhone.length >= 10 && clientPhone.length >= 10 && !ordPhone.endsWith(clientPhone.slice(-10))) {
        return res.status(403).json({ message: "Phone number does not match order record" });
      }
    }

    const orderObj = order.toObject ? order.toObject() : order;
    const enrichedOrder = (await enrichOrdersWithSellerAndConsumer([orderObj]))[0];

    const filterSellerId = req.query.sellerId || req.headers["x-seller-id"] || null;
    const { generateExchangeInvoicePDF } = await import("../services/invoiceService.js");
    const filename = `ExchangeInvoice_${enrichedOrder.orderId || enrichedOrder._id}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    let platformSettings = {};
    try {
      const PlatformSetting = (await import("../models/PlatformSetting.js")).default;
      platformSettings = (await PlatformSetting.findOne({ key: "global_settings" })) || {};
    } catch (e) {}

    const pdfDoc = generateExchangeInvoicePDF(enrichedOrder, filterSellerId, {
      platformSetting: platformSettings,
      companyName: platformSettings.companyName,
      companyAddress: platformSettings.companyAddress,
      companyGstin: platformSettings.companyGstin
    });
    pdfDoc.pipe(res);
  } catch (error) {
    console.error("Download exchange invoice error:", error);
    res.status(500).json({ message: "Failed to generate exchange invoice", error: error.message });
  }
};


// 8. Cancel Order Endpoint (Customer / User initiated before shipment)
export const cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, comment, refundDetails } = req.body;

    const finalReasonStr = (reason || comment || "").trim();
    if (!finalReasonStr) {
      return res.status(400).json({ message: "Cancellation reason is strictly required." });
    }

    const isMongoId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isMongoId ? { _id: id } : { $or: [{ orderId: id }, { id: id }] };
    const order = await Order.findOne(query);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const currentStatus = String(order.overallStatus || order.status || "").toLowerCase().trim();
    const cancellableStatuses = ["placed", "pending", "confirmed", "processing", "packed"];

    if (!cancellableStatuses.includes(currentStatus)) {
      return res.status(400).json({
        message: `Order cannot be cancelled because it is currently in '${order.overallStatus || order.status}' state.`
      });
    }

    const cancelledByName = req.user?.name || req.body?.cancelledBy || order.customer?.name || "Customer";

    order.overallStatus = "cancelled";
    order.status = "cancelled";
    order.cancellationReason = reason || comment || "Cancelled by customer";
    order.cancelledBy = cancelledByName;
    order.cancelledAt = new Date();

    const isPaid = String(order.paymentStatus || '').toLowerCase() === "paid" || (order.paymentMethod && !String(order.paymentMethod).toUpperCase().includes("COD"));
    
    if (isPaid) {
      if (refundDetails && (refundDetails.upiId || refundDetails.accountNumber || refundDetails.method)) {
        order.refundDetails = {
          method: refundDetails.method || (refundDetails.upiId ? "UPI" : "BANK"),
          upiId: refundDetails.upiId || "",
          bankName: refundDetails.bankName || "",
          accountNumber: refundDetails.accountNumber || "",
          ifscCode: refundDetails.ifscCode || "",
          accountHolderName: refundDetails.accountHolderName || "",
          submittedAt: new Date()
        };
      }
      order.refundStatus = "Refund Requested";
    } else {
      order.refundStatus = "N/A (Unpaid COD Order)";
      order.paymentStatus = "cancelled";
    }

    // Restock item inventory in DB
    try {
      for (const item of order.items) {
        await incrementItemStock(item);
      }
    } catch (stockErr) {
      console.warn("⚠️ Stock auto-increment warning on cancel:", stockErr.message);
    }

    // Append timeline checkpoint
    let timelineDesc = `Order cancelled by customer (${cancelledByName}). Reason: ${order.cancellationReason}`;
    if (isPaid) {
      const modeStr = order.refundDetails?.method === "UPI" ? `UPI (${order.refundDetails.upiId})` : (order.refundDetails?.method === "BANK" ? `Bank Transfer (${order.refundDetails.bankName})` : "Submitted Details");
      timelineDesc += ` • Online refund requested via ${modeStr}.`;
    }

    order.timeline.push({
      status: "cancelled",
      title: isPaid ? "Order Cancelled & Refund Requested" : "Order Cancelled",
      description: timelineDesc,
      timestamp: new Date(),
      updatedBy: "Customer"
    });


    await order.save();

    // Fast2SMS DLT: Order Cancelled (225929) & Refund Initiated (225926)
    try {
      const custPhone = order.customer?.phone || order.shippingAddress?.phone || order.phone;
      const cleanCustPhone = String(custPhone || "").replace(/\D/g, "").slice(-10);
      if (cleanCustPhone.length === 10) {
        // Template 225929: Cancelled SMS
        sendFast2SmsOrderCancelled(cleanCustPhone, order.orderId).catch(() => {});

        // Template 225926: Refund Initiated SMS if prepaid
        if (isPaid) {
          const refundAmt = Number(order.totalAmount || 0);
          sendFast2SmsRefundInitiated(cleanCustPhone, refundAmt, order.orderId).catch(() => {});
        }
      }
    } catch (smsErr) {}

    try {
      broadcastRealtimeEvent({
        type: "ORDER_UPDATED",
        orderId: order.orderId,
        masterOrderId: order.masterOrderId,
        sellerId: order.sellerId,
        status: "Cancelled"
      });
    } catch (rtErr) {}

    return res.json({ success: true, message: "Order cancelled successfully", order });
  } catch (error) {
    return res.status(500).json({ message: "Failed to cancel order", error: error.message });
  }
};

// 9. Request Return or Exchange Endpoint (Customer / User initiated within return window)
export const requestReturnExchange = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      type, // "return" | "exchange"
      reason,
      comment,
      exchangeSize,
      exchangeLength,
      exchangeColor,
      priceDifference = 0,
      priceAdjustmentType = "none",
      originalItemPrice = 0,
      replacementItemPrice = 0,
      refundMethod,
      refundDetails
    } = req.body;

    if (!type || !["return", "exchange"].includes(type)) {
      return res.status(400).json({ message: "Request type must be either 'return' or 'exchange'" });
    }

    let order = await findOrderById(id);

    if (!order) {
      try {
        const SchoolBulkOrder = (await import("../models/SchoolBulkOrder.js")).default;
        const cleanId = String(id).trim().replace(/^#+/, '');
        const isMongoId = mongoose.Types.ObjectId.isValid(cleanId);
        const query = isMongoId
          ? { $or: [{ _id: cleanId }, { orderId: cleanId }, { id: cleanId }] }
          : { $or: [{ orderId: cleanId }, { id: cleanId }] };
        order = await SchoolBulkOrder.findOne(query);
      } catch (err) {
        console.warn('SchoolBulkOrder lookup fallback failed:', err.message);
      }
    }

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Resolve the target item being returned or exchanged in this combined/single order
    const targetItem = (Array.isArray(order.items) && order.items.length > 0)
      ? (order.items.find(it => {
          const reqId = req.body.itemId ? String(req.body.itemId).trim() : '';
          const matchId = reqId && (
            String(it._id || '') === reqId ||
            String(it.id || '') === reqId ||
            String(it.productId || '') === reqId
          );
          const reqName = req.body.itemName ? String(req.body.itemName).trim().toLowerCase() : '';
          const matchName = reqName && String(it.name || '').trim().toLowerCase() === reqName;
          return matchId || matchName;
        }) || (order.items.length === 1 ? order.items[0] : null))
      : null;

    const statusLower = String(order.status || "").toLowerCase().trim();
    const overallStatusLower = String(order.overallStatus || "").toLowerCase().trim();
    const targetItemStatusLower = String(targetItem?.status || "").toLowerCase().trim();
    const validDeliveredStatuses = ["delivered", "completed", "fulfilled", "received", "delivered_to_customer", "order_delivered"];

    const isTargetItemDelivered = 
      validDeliveredStatuses.includes(targetItemStatusLower) || 
      targetItemStatusLower.includes("delivered") || 
      targetItemStatusLower.includes("received");

    const isOrderDelivered = 
      validDeliveredStatuses.includes(statusLower) || 
      validDeliveredStatuses.includes(overallStatusLower) || 
      statusLower.includes("delivered") || 
      statusLower.includes("completed") || 
      statusLower.includes("fulfilled") || 
      statusLower.includes("received") || 
      statusLower.includes("exchange") || 
      statusLower.includes("return") || 
      overallStatusLower.includes("exchange") || 
      overallStatusLower.includes("return") || 
      Boolean(order.deliveredAt || order.deliveryDetails?.deliveredAt);

    const isDeliveredState = isTargetItemDelivered || isOrderDelivered;

    if (!isDeliveredState) {
      return res.status(400).json({ 
        message: `Return or Exchange is only available for delivered items. Current item status: '${targetItem?.status || order.status || order.overallStatus || 'Pending'}'` 
      });
    }

    // Check product return window days, returnability, and exchangability for the target item
    let returnWindowDays = 7;
    let isReturnable = true;
    let isRefundable = true;
    let isExchangeable = true;

    let prod = null;
    if (targetItem) {
      const searchId = targetItem.productId || targetItem.id;
      if (searchId) {
        prod = await findProductByIdOrCustomId(searchId);
        if (prod) {
          if (prod.isReturnable === false) isReturnable = false;
          if (prod.isRefundable === false) isRefundable = false;
          if (prod.isExchangeable === false) isExchangeable = false;
          if (prod.returnWindowDays && Number(prod.returnWindowDays) > 0) {
            returnWindowDays = Number(prod.returnWindowDays);
          }
        }
      }
      if (targetItem.isReturnable === false) isReturnable = false;
      if (targetItem.isExchangeable === false) isExchangeable = false;
      if (targetItem.returnWindowDays && Number(targetItem.returnWindowDays) > 0) {
        returnWindowDays = Number(targetItem.returnWindowDays);
      }
    }

    if (type === "return" && !isReturnable) {
      return res.status(400).json({ message: "This product is marked as non-returnable." });
    }
    if (type === "refund" && !isRefundable) {
      return res.status(400).json({ message: "This product is marked as non-refundable." });
    }
    if (type === "exchange" && !isExchangeable) {
      return res.status(400).json({ message: "This product is marked as non-exchangeable." });
    }

    const candTargetStr = [
      targetItem?.category,
      prod?.category,
      targetItem?.subCategory,
      prod?.subCategory,
      targetItem?.name,
      prod?.name
    ].filter(Boolean).join(' ').toLowerCase();

    const isExplicitFootwear = candTargetStr.includes('footwear') || candTargetStr.includes('shoe') || candTargetStr.includes('boot') || candTargetStr.includes('sandal') || candTargetStr.includes('sneaker') || candTargetStr.includes('sock');
    const isExplicitBook = candTargetStr.includes('book') || candTargetStr.includes('ncert') || candTargetStr.includes('textbook') || candTargetStr.includes('atlas') || candTargetStr.includes('syllabus');
    const isExplicitStationery = candTargetStr.includes('notebook') || candTargetStr.includes('register') || candTargetStr.includes('stationery') || candTargetStr.includes('pen') || candTargetStr.includes('pencil') || candTargetStr.includes('geometry');

    const targetRawUnit = String(targetItem?.unit || prod?.unit || targetItem?.measureScale || prod?.measureScale || '').toLowerCase().trim();
    const isTargetMeterUnit = targetRawUnit === 'meter' || targetRawUnit === 'meters' || targetRawUnit === 'mtr' || targetRawUnit === 'm';

    const isTargetExplicitMeter = Boolean(
      (targetItem?.isMeterBased === true || targetItem?.isMeterBased === 'true' || prod?.isMeterBased === true || prod?.isMeterBased === 'true' || isTargetMeterUnit) &&
      !isExplicitFootwear && !isExplicitBook && !isExplicitStationery
    );

    const hasFabricKeyword = (
      candTargetStr.includes('unstitched') ||
      candTargetStr.includes('unstiched') ||
      candTargetStr.includes('shirting') ||
      candTargetStr.includes('suiting') ||
      candTargetStr.includes('kapda') ||
      candTargetStr.includes('than') ||
      candTargetStr.includes('dress material')
    );

    const isUnstitched = !isExplicitFootwear && !isExplicitBook && !isExplicitStationery && (
      isTargetExplicitMeter ||
      (hasFabricKeyword && !candTargetStr.includes('ready to wear') && !candTargetStr.includes('stitched')) ||
      (Number(targetItem?.quantity) % 1 !== 0 && hasFabricKeyword)
    );

    // Use deliveredAt timestamp if recorded, otherwise fallback to updatedAt or current time if status is delivered
    const deliveredDate = order.deliveredAt || order.deliveryDetails?.deliveredAt || (isDeliveredState ? new Date(order.updatedAt || Date.now()) : new Date(order.createdAt || Date.now()));
    const returnEligibleUntil = new Date(deliveredDate.getTime() + returnWindowDays * 24 * 60 * 60 * 1000);

    if (new Date() > returnEligibleUntil) {
      return res.status(400).json({ 
        message: `Return/Exchange window of ${returnWindowDays} days expired on ${returnEligibleUntil.toLocaleDateString('en-IN')}.` 
      });
    }

    const formattedRefundDetails = refundDetails ? {
      method: refundDetails.method || (refundDetails.upiId ? "UPI" : "BANK"),
      upiId: refundDetails.upiId || "",
      bankName: refundDetails.bankName || "",
      accountNumber: refundDetails.accountNumber || "",
      ifscCode: refundDetails.ifscCode || "",
      accountHolderName: refundDetails.accountHolderName || ""
    } : { method: "", upiId: "", bankName: "", accountNumber: "", ifscCode: "", accountHolderName: "" };

    const newOverallStatus = type === "exchange" ? "exchange_requested" : "return_requested";
    order.overallStatus = newOverallStatus;
    order.status = newOverallStatus;

    const itemStatus = type === "exchange" ? "Exchange Requested" : "Return Requested";
    if (Array.isArray(order.items)) {
      if (targetItem) {
        targetItem.status = itemStatus;
      } else if (order.items.length === 1) {
        order.items[0].status = itemStatus;
      }
    }

    const targetItemRefund = targetItem
      ? Math.max(0, Number(targetItem.finalPrice ?? targetItem.price ?? 0) * Number(targetItem.quantity || 1))
      : Math.max(0, Number(order.subtotal || order.total || 0) - Number(order.discountAmount ?? order.discount ?? 0));
    const calculatedRefundAmount = type === "return"
      ? targetItemRefund
      : (type === "exchange" && priceAdjustmentType === "partial_refund" ? Math.abs(Number(priceDifference)) : 0);

    if (type === "return" || (type === "exchange" && priceAdjustmentType === "partial_refund")) {
      order.refundDetails = {
        ...formattedRefundDetails,
        refundAmount: calculatedRefundAmount,
        amount: calculatedRefundAmount,
        submittedAt: new Date()
      };
      order.refundStatus = type === "return" ? "Refund Requested" : "Partial Refund Requested";
    }

    const effectiveExchangeDisplay = (isUnstitched && exchangeLength) ? `${exchangeLength} Meter(s)` : (exchangeSize || "");

    order.returnRequest = {
      itemId: targetItem ? (targetItem._id || targetItem.id || targetItem.productId) : req.body.itemId,
      itemName: targetItem ? targetItem.name : req.body.itemName,
      productId: targetItem ? (targetItem.productId || targetItem.id) : undefined,
      type,
      reason: reason || "Customer request",
      comment: comment || "",
      exchangeSize: effectiveExchangeDisplay,
      exchangeLength: (isUnstitched && exchangeLength) ? Number(exchangeLength) : undefined,
      isMeterBased: Boolean(isUnstitched),
      exchangeColor: exchangeColor || "",
      priceDifference: Number(priceDifference) || 0,
      priceAdjustmentType: priceAdjustmentType || "none",
      originalItemPrice: Number(originalItemPrice) || 0,
      replacementItemPrice: Number(replacementItemPrice) || 0,
      refundAmount: calculatedRefundAmount,
      refundMethod: refundMethod || "Original Payment Method",
      refundDetails: formattedRefundDetails,
      requestedAt: new Date(),
      updatedAt: new Date(),
      status: type === "exchange" ? "exchange_requested" : "return_requested",
      returnEligibleUntil
    };

    const lengthOrSizeStr = exchangeLength ? `Requested Length: ${exchangeLength} Meter(s)` : (exchangeSize ? `Requested Size: ${exchangeSize}` : '');
    let timelineDesc = `Customer requested ${type}. Reason: ${reason || 'N/A'}${lengthOrSizeStr ? ` (${lengthOrSizeStr})` : ''}`;
    if (type === "exchange" && priceAdjustmentType === "extra_payment") {
      timelineDesc += ` • Additional amount payable: ₹${Math.abs(priceDifference)}.`;
    } else if (type === "exchange" && priceAdjustmentType === "partial_refund") {
      const modeStr = formattedRefundDetails.method === "UPI" ? `UPI (${formattedRefundDetails.upiId})` : `Bank (${formattedRefundDetails.bankName})`;
      timelineDesc += ` • Partial refund: ₹${Math.abs(priceDifference)} to ${modeStr}.`;
    } else if (type === "return" && formattedRefundDetails.method) {
      const modeStr = formattedRefundDetails.method === "UPI" ? `UPI (${formattedRefundDetails.upiId})` : `Bank (${formattedRefundDetails.bankName})`;
      timelineDesc += ` • Receiving account: ${modeStr}.`;
    }

    order.timeline = order.timeline || [];
    order.timeline.push({
      status: newOverallStatus,
      title: type === "exchange" ? "Exchange Requested" : "Return Requested",
      description: timelineDesc,
      timestamp: new Date(),
      updatedBy: "Customer"
    });

    order.markModified("items");
    order.markModified("returnRequest");
    if (order.returnRequests) {
      order.markModified("returnRequests");
    }

    await order.save();

    try {
      broadcastRealtimeEvent({
        type: "ORDER_UPDATED",
        orderId: order.orderId,
        masterOrderId: order.masterOrderId,
        sellerId: order.sellerId,
        status: order.overallStatus || order.status
      });
    } catch (rtErr) {}

    return res.json({
      success: true,
      message: `${type === 'exchange' ? 'Exchange' : 'Return'} request submitted successfully`,
      order
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to submit return/exchange request", error: error.message });
  }
};

// 10. Update Return/Exchange Request Status (Admin / Seller Action)
export const updateReturnExchangeStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      status, // "approved", "return_approved", "exchange_approved", "rejected", "return_rejected", "exchange_rejected", "pickup_scheduled", "product_received", "refund_initiated", "refund_processed", "refund_completed", "exchange_dispatched", "exchanged"
      rejectionReason,
      pickupDate,
      refundTxnId: rawRefundTxnId,
      refundTransactionId,
      exchangeAwb,
      exchangeCourier,
      notes
    } = req.body;

    const refundTxnId = rawRefundTxnId || refundTransactionId;

    if (!status) {
      return res.status(400).json({ message: "Status is required" });
    }

    const order = await findOrderById(id);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (!order.returnRequest || !order.returnRequest.type) {
      return res.status(400).json({ message: "No active Return or Exchange request found for this order." });
    }

    const type = order.returnRequest.type; // "return" or "exchange"
    const rawStatus = String(status).toLowerCase().trim().replace(/[\s-]+/g, "_");

    // ─────────────────────────────────────────────────────────────────────────
    // Server-side state-machine: enforce approval-first sequential transitions
    // ─────────────────────────────────────────────────────────────────────────
    const RETURN_STATUS_TRANSITIONS = {
      // Customer-initiated → Admin/Seller decision
      "return_requested":    ["return_approved", "return_rejected", "rejected", "approved"],
      "exchange_requested":  ["exchange_approved", "exchange_rejected", "rejected", "approved"],
      // Approved → pickup or doorstep exchange dispatch
      "return_approved":     ["pickup_scheduled", "return_rejected", "rejected"],
      "exchange_approved":   ["exchange_dispatched", "pickup_scheduled", "exchanged", "exchange_rejected", "rejected"],
      // Pickup → received or exchange dispatch
      "pickup_scheduled":    ["product_received", "product_return_received", "exchange_dispatched", "exchanged"],
      // Received → refund or dispatch
      "product_received":    ["refund_initiated", "refund_completed", "refunded", "refund_processed", "exchange_dispatched", "exchanged"],
      "product_return_received": ["refund_initiated", "refund_completed", "refunded", "refund_processed", "exchange_dispatched", "exchanged"],
      // Refund progression
      "refund_initiated":    ["refund_completed", "refunded", "refund_processed"],
      // Exchange dispatch → complete
      "exchange_dispatched": ["exchanged"],
      // Terminal states – no further automated transitions
      "return_rejected":     [],
      "exchange_rejected":   [],
      "rejected":            [],
      "refund_completed":    [],
      "refunded":            [],
      "refund_processed":    [],
      "exchanged":           [],
    };

    const currentRetStatus = String(order.returnRequest.status || "").toLowerCase().trim().replace(/[\s-]+/g, "_");

    // Normalize the incoming target status to the canonical key for the transition check
    const normalizedTarget = (() => {
      if (["approved", "return_approved", "exchange_approved"].includes(rawStatus)) {
        return type === "exchange" ? "exchange_approved" : "return_approved";
      }
      if (["rejected", "return_rejected", "exchange_rejected"].includes(rawStatus)) {
        return type === "exchange" ? "exchange_rejected" : "return_rejected";
      }
      if (["refund_completed", "refund_processed", "refunded"].includes(rawStatus)) return "refund_completed";
      if (rawStatus === "product_return_received") return "product_received";
      return rawStatus;
    })();

    const normalizedCurrent = (() => {
      if (["requested", "return_requested", "exchange_requested"].includes(currentRetStatus)) {
        return type === "exchange" ? "exchange_requested" : "return_requested";
      }
      if (["approved", "return_approved", "exchange_approved"].includes(currentRetStatus)) {
        return type === "exchange" ? "exchange_approved" : "return_approved";
      }
      if (["rejected", "return_rejected", "exchange_rejected"].includes(currentRetStatus)) {
        return type === "exchange" ? "exchange_rejected" : "return_rejected";
      }
      if (["refund_completed", "refund_processed", "refunded"].includes(currentRetStatus)) return "refund_completed";
      if (currentRetStatus === "product_return_received") return "product_received";
      return currentRetStatus;
    })();

    // Only enforce the transition guard when transitioning to a DIFFERENT state.
    // Idempotent calls (setting to the already current status) are permitted safely.
    if (normalizedCurrent && normalizedCurrent !== normalizedTarget && RETURN_STATUS_TRANSITIONS[normalizedCurrent] !== undefined) {
      const allowed = RETURN_STATUS_TRANSITIONS[normalizedCurrent];
      if (!allowed.includes(normalizedTarget) && !allowed.includes(rawStatus)) {
        return res.status(422).json({
          message: `Invalid status transition: cannot move from '${normalizedCurrent.replace(/_/g, " ")}' to '${normalizedTarget.replace(/_/g, " ")}'. ` +
            `Allowed next steps: ${allowed.length > 0 ? allowed.map(s => s.replace(/_/g, " ")).join(", ") : "none (terminal state)"}.`,
          currentStatus: normalizedCurrent,
          requestedStatus: normalizedTarget,
          allowedTransitions: allowed
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const targetItemId = String(order.returnRequest?.itemId || order.returnRequest?.productId || '').trim();
    const targetItemName = String(order.returnRequest?.itemName || '').trim().toLowerCase();
    const targetItem = (Array.isArray(order.items) && order.items.length > 0)
      ? order.items.find(it => {
          if (targetItemId && (String(it._id || '') === targetItemId || String(it.id || '') === targetItemId || String(it.productId || '') === targetItemId)) {
            return true;
          }
          if (targetItemName && String(it.name || '').trim().toLowerCase() === targetItemName) {
            return true;
          }
          return false;
        })
      : null;

    let canonicalReturnStatus = rawStatus;
    let overallStatus = order.overallStatus;
    let title = "";
    let description = notes || "";

    if (rawStatus === "approved" || rawStatus === "return_approved" || rawStatus === "exchange_approved") {
      canonicalReturnStatus = type === "exchange" ? "exchange_approved" : "return_approved";
      overallStatus = canonicalReturnStatus;
      title = type === "exchange" ? "Exchange Request Approved" : "Return Request Approved";
      description = description || `Store Admin/Seller approved the ${type} request for ${targetItem ? targetItem.name : "item"}. Pickup will be arranged.`;
    } else if (rawStatus === "rejected" || rawStatus === "return_rejected" || rawStatus === "exchange_rejected") {
      canonicalReturnStatus = type === "exchange" ? "exchange_rejected" : "return_rejected";
      overallStatus = canonicalReturnStatus;
      title = type === "exchange" ? "Exchange Request Rejected" : "Return Request Rejected";
      description = description || `Request rejected. Reason: ${rejectionReason || "Criteria not met"}`;
    } else if (rawStatus === "pickup_scheduled") {
      canonicalReturnStatus = "pickup_scheduled";
      overallStatus = "pickup_scheduled";
      title = type === "exchange" ? "Exchange Pickup Scheduled" : "Return Pickup Scheduled";
      description = description || `Pickup scheduled for ${pickupDate ? new Date(pickupDate).toLocaleDateString('en-IN') : 'upcoming business days'}.`;

      const existingOtp = String(order.deliveryOtp || order.selfDeliveryDetails?.deliveryOtp || "").trim();
      const activeOtp = /^\d{4}$/.test(existingOtp) ? existingOtp : Math.floor(1000 + Math.random() * 9000).toString();
      const now = new Date();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour live OTP validity

      order.deliveryOtp = activeOtp;
      if (!order.selfDeliveryDetails) order.selfDeliveryDetails = {};
      order.selfDeliveryDetails.deliveryOtp = activeOtp;
      order.selfDeliveryDetails.otpLastSentAt = now;
      order.selfDeliveryDetails.otpExpiresAt = expiresAt;
      if (targetItem) {
        targetItem.deliveryOtp = activeOtp;
        if (!targetItem.selfDeliveryDetails) targetItem.selfDeliveryDetails = {};
        targetItem.selfDeliveryDetails.deliveryOtp = activeOtp;
        targetItem.selfDeliveryDetails.otpLastSentAt = now;
        targetItem.selfDeliveryDetails.otpExpiresAt = expiresAt;
      } else if (Array.isArray(order.items)) {
        order.items.forEach(it => {
          it.deliveryOtp = activeOtp;
          if (!it.selfDeliveryDetails) it.selfDeliveryDetails = {};
          it.selfDeliveryDetails.deliveryOtp = activeOtp;
          it.selfDeliveryDetails.otpLastSentAt = now;
          it.selfDeliveryDetails.otpExpiresAt = expiresAt;
        });
      }

      const custPhone = order.customer?.phone || order.shippingAddress?.phone || order.phone;
      const cleanPhone = String(custPhone || "").replace(/\D/g, "").slice(-10);
      if (cleanPhone && cleanPhone.length === 10) {
        const smsAction = type === 'exchange'
          ? sendFast2SmsExchangeOtp(cleanPhone, order.orderId, activeOtp)
          : sendFast2SmsReturnOtp(cleanPhone, order.orderId, activeOtp);
        smsAction
          .then((smsRes) => {
            if (smsRes?.success) {
              console.log(`📲 [FAST2SMS] ${type === 'exchange' ? 'Exchange' : 'Return'} Pickup OTP sent to +91 ${cleanPhone}`);
            }
          })
          .catch((smsErr) => console.warn("Pickup OTP SMS dispatch error:", smsErr.message));
      }
    } else if (rawStatus === "product_received" || rawStatus === "product_return_received") {
      canonicalReturnStatus = "product_received";
      overallStatus = "product_received";
      title = "Returned Item Received & Inspected";
      description = description || `Item received back at warehouse and passed quality inspection. Stock restored to inventory.`;
      
      if (!order.stockRestored) {
        if (targetItem) {
          try {
            await incrementItemStock(targetItem);
          } catch (err) {
            console.warn("Stock restoration warning:", err.message);
          }
        } else if (Array.isArray(order.items)) {
          for (const item of order.items) {
            try {
              await incrementItemStock(item);
            } catch (err) {
              console.warn("Stock restoration warning:", err.message);
            }
          }
        }
        order.stockRestored = true;
      }
    } else if (rawStatus === "refund_initiated") {
      canonicalReturnStatus = "refund_initiated";
      overallStatus = "refund_initiated";
      order.refundStatus = "Refund Initiated";
      title = "Refund Initiated";
      description = description || `Refund payout initiated to customer's account.`;
    } else if (rawStatus === "refund_completed" || rawStatus === "refund_processed" || rawStatus === "refunded") {
      canonicalReturnStatus = "refund_completed";
      overallStatus = "refund_completed";
      order.paymentStatus = "refunded";
      order.refundStatus = "Refund Completed";
      if (refundTxnId) {
        order.refundDetails = { ...(order.refundDetails || {}), refundTxnId, status: "Completed" };
      }
      title = "Refund Processed & Completed";
      description = description || `Refund successfully processed. Reference TXN: ${refundTxnId || "N/A"}.`;

      if (!order.stockRestored) {
        if (targetItem) {
          try {
            await incrementItemStock(targetItem);
          } catch (err) {}
        } else if (Array.isArray(order.items)) {
          for (const item of order.items) {
            try {
              await incrementItemStock(item);
            } catch (err) {}
          }
        }
        order.stockRestored = true;
      }
    } else if (rawStatus === "exchange_dispatched") {
      canonicalReturnStatus = "exchange_dispatched";
      overallStatus = "exchange_dispatched";
      title = "Replacement Exchange Unit Dispatched";
      description = description || `Replacement item dispatched via ${exchangeCourier || "Courier"} (AWB: ${exchangeAwb || "N/A"}).`;
      if (exchangeAwb) {
        order.trackingNumber = exchangeAwb;
        order.courierName = exchangeCourier || order.courierName || "Shiprocket";
      }

      // Ensure active Exchange Delivery OTP is live with 24 hours window and dispatched via SMS
      const existingOtp = String(order.deliveryOtp || order.selfDeliveryDetails?.deliveryOtp || "").trim();
      const activeOtp = /^\d{4}$/.test(existingOtp) ? existingOtp : Math.floor(1000 + Math.random() * 9000).toString();
      const now = new Date();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour live OTP validity

      order.deliveryOtp = activeOtp;
      if (!order.selfDeliveryDetails) order.selfDeliveryDetails = {};
      order.selfDeliveryDetails.deliveryOtp = activeOtp;
      order.selfDeliveryDetails.otpLastSentAt = now;
      order.selfDeliveryDetails.otpExpiresAt = expiresAt;
      if (targetItem) {
        targetItem.deliveryOtp = activeOtp;
        if (!targetItem.selfDeliveryDetails) targetItem.selfDeliveryDetails = {};
        targetItem.selfDeliveryDetails.deliveryOtp = activeOtp;
        targetItem.selfDeliveryDetails.otpLastSentAt = now;
        targetItem.selfDeliveryDetails.otpExpiresAt = expiresAt;
      } else if (Array.isArray(order.items)) {
        order.items.forEach(it => {
          it.deliveryOtp = activeOtp;
          if (!it.selfDeliveryDetails) it.selfDeliveryDetails = {};
          it.selfDeliveryDetails.deliveryOtp = activeOtp;
          it.selfDeliveryDetails.otpLastSentAt = now;
          it.selfDeliveryDetails.otpExpiresAt = expiresAt;
        });
      }

      const custPhone = order.customer?.phone || order.shippingAddress?.phone || order.phone;
      const cleanPhone = String(custPhone || "").replace(/\D/g, "").slice(-10);
      if (cleanPhone && cleanPhone.length === 10) {
        sendFast2SmsExchangeOtp(cleanPhone, order.orderId, activeOtp)
          .then((smsRes) => {
            if (smsRes?.success) {
              console.log(`📲 [FAST2SMS] Exchange Delivery OTP sent to +91 ${cleanPhone}`);
            }
          })
          .catch((smsErr) => console.warn("Exchange Delivery OTP SMS dispatch error:", smsErr.message));
      }
    } else if (rawStatus === "exchanged") {
      canonicalReturnStatus = "exchanged";
      overallStatus = "exchanged";
      title = "Exchange Completed";
      description = description || `Exchange order completed and replacement delivered to customer.`;

      // Auto-restore inventory stock for the returned old item if not yet done
      if (!order.stockRestored) {
        if (targetItem) {
          try {
            await incrementItemStock(targetItem);
          } catch (err) {}
        } else if (Array.isArray(order.items)) {
          for (const item of order.items) {
            try {
              await incrementItemStock(item);
            } catch (err) {}
          }
        }
        order.stockRestored = true;
      }

      // Auto-schedule settlement maturity strictly 1 day after exchange date
      const exchangedNow = new Date();
      order.exchangedAt = exchangedNow;
      if (!order.returnRequest) order.returnRequest = {};
      order.returnRequest.exchangedAt = exchangedNow;

      const exchangeSettlementDueDate = new Date(exchangedNow.getTime() + 1 * 24 * 60 * 60 * 1000);
      order.settlementDueDate = exchangeSettlementDueDate;
      order.settlementStatus = "pending_exchange_buffer";
      order.isSettlementMatured = false;

      if (targetItem) {
        targetItem.exchangedAt = exchangedNow;
        targetItem.settlementDueDate = exchangeSettlementDueDate;
        targetItem.settlementStatus = "pending_exchange_buffer";
        targetItem.isSettlementMatured = false;
      } else if (Array.isArray(order.items)) {
        order.items.forEach(it => {
          it.exchangedAt = exchangedNow;
          it.settlementDueDate = exchangeSettlementDueDate;
          it.settlementStatus = "pending_exchange_buffer";
          it.isSettlementMatured = false;
        });
      }
    } else {
      canonicalReturnStatus = rawStatus;
      overallStatus = rawStatus;
      title = `Return/Exchange Status: ${normalizeOrderStatus(rawStatus, order)}`;
    }

    // Auto-recognize Credit Note for Refunded / Returned orders so manual credit note creation is never needed
    if (rawStatus === "refund_completed" || rawStatus === "refund_processed" || rawStatus === "refunded") {
      order.settlementStatus = "refunded";
      order.isSettlementMatured = false;
      order.tdsAmount = 0;
      order.gstTcsAmount = 0;
      order.cgstTcsAmount = 0;
      order.sgstTcsAmount = 0;
      order.igstTcsAmount = 0;
      order.commissionAmount = 0;
      order.gstOnCommissionAmount = 0;
      order.totalDeliveryDeduction = 0;
      order.totalDeductions = 0;
      order.sellerPayout = 0;
      order.sellerSettlement = 0;
      order.netSettlementAmount = 0;
      const cnPrefix3 = getSellerInvoicePrefix(order.sellerStoreName || order.storeName || order.sellerName);
      const cnSeq3 = order.sellerCreditNoteSequence || order.sellerSequence || 1;
      const assignedCn3 = formatSellerCreditNoteNumber(cnPrefix3, cnSeq3);
      order.sellerCreditNoteNo = order.sellerCreditNoteNo || assignedCn3;
      order.creditNoteNumber = order.creditNoteNumber || assignedCn3;
      order.creditNoteIssuedAt = order.creditNoteIssuedAt || new Date();

      if (targetItem) {
        targetItem.settlementStatus = "refunded";
        targetItem.isSettlementMatured = false;
        targetItem.tdsAmount = 0;
        targetItem.gstTcsAmount = 0;
        targetItem.cgstTcsAmount = 0;
        targetItem.sgstTcsAmount = 0;
        targetItem.igstTcsAmount = 0;
        targetItem.commissionAmount = 0;
        targetItem.gstOnCommissionAmount = 0;
        targetItem.totalDeliveryDeduction = 0;
        targetItem.totalDeductions = 0;
        targetItem.sellerPayout = 0;
        targetItem.sellerSettlement = 0;
        targetItem.netSettlementAmount = 0;
      } else if (Array.isArray(order.items)) {
        order.items.forEach(it => {
          it.settlementStatus = "refunded";
          it.isSettlementMatured = false;
          it.tdsAmount = 0;
          it.gstTcsAmount = 0;
          it.cgstTcsAmount = 0;
          it.sgstTcsAmount = 0;
          it.igstTcsAmount = 0;
          it.commissionAmount = 0;
          it.gstOnCommissionAmount = 0;
          it.totalDeliveryDeduction = 0;
          it.totalDeductions = 0;
          it.netSettlementAmount = 0;
        });
      }
    }

    order.returnRequest.status = canonicalReturnStatus;
    order.returnRequest.updatedAt = new Date();

    if (rejectionReason) order.returnRequest.rejectionReason = rejectionReason;
    if (pickupDate) order.returnRequest.pickupDate = new Date(pickupDate);
    if (refundTxnId) order.returnRequest.refundTxnId = refundTxnId;
    if (exchangeAwb) order.returnRequest.exchangeAwb = exchangeAwb;
    if (exchangeCourier) order.returnRequest.exchangeCourier = exchangeCourier;

    order.overallStatus = overallStatus;
    order.status = overallStatus;

    if (Array.isArray(order.items)) {
      if (targetItem) {
        targetItem.status = title;
        // In multi-item orders, ensure non-target items retain Delivered status and are not tainted by exchange
        order.items.forEach(it => {
          if (it !== targetItem) {
            const s = String(it.status || '').toLowerCase();
            if (s.includes('exchange') || s.includes('pickup scheduled')) {
              it.status = 'Delivered';
            }
          }
        });
      } else if (order.items.length === 1) {
        order.items[0].status = title;
      } else {
        // In multi-item orders, NEVER overwrite all items! Find the item that already has return/exchange
        const cand = order.items.find(it => {
          const s = String(it.status || '').toLowerCase();
          return s.includes('exchange') || s.includes('return') || s.includes('pickup');
        });
        if (cand) {
          cand.status = title;
        }
      }
    }

    order.timeline = order.timeline || [];
    order.timeline.push({
      status: overallStatus,
      title,
      description,
      timestamp: new Date(),
      updatedBy: req.seller?.storeName || req.user?.name || "Store Admin"
    });

    await order.save();

    // Trigger instant settlement reconciliation for seller
    try {
      const primarySellerId = order.sellerId || (order.items && order.items[0]?.sellerId);
      if (primarySellerId) {
        reconcileSellerSettlementBalances(primarySellerId).catch(() => {});
      }
    } catch (reconcileErr) {
      console.warn("Auto-reconcile on return/exchange status update warning:", reconcileErr.message);
    }

    // Fast2SMS DLT: Return Approved (228313), Refund Processed (228312), Refund Initiated (225926)
    try {
      const custPhone = order.customer?.phone || order.shippingAddress?.phone || order.phone;
      const cleanCustPhone = String(custPhone || "").replace(/\D/g, "").slice(-10);
      if (cleanCustPhone.length === 10) {
        if (rawStatus === "approved" || rawStatus === "return_approved" || rawStatus === "exchange_approved") {
          sendFast2SmsReturnApproved(cleanCustPhone, type, order.orderId)
            .then(res => {
              if (res?.success) console.log(`📲 [FAST2SMS] Return/Exchange approved SMS sent to +91 ${cleanCustPhone} for Order ${order.orderId}`);
            })
            .catch(() => {});
        } else if (rawStatus === "refund_completed" || rawStatus === "refund_processed" || rawStatus === "refunded") {
          const refAmt = Number(order.refundDetails?.amount || order.returnRequest?.refundAmount || order.totalAmount || 0);
          sendFast2SmsRefundProcessed(cleanCustPhone, refAmt, order.orderId, refundTxnId)
            .then(res => {
              if (res?.success) console.log(`📲 [FAST2SMS] Refund processed SMS sent to +91 ${cleanCustPhone} for Order ${order.orderId}`);
            })
            .catch(() => {});
        } else if (rawStatus === "refund_initiated") {
          const refAmt = Number(order.refundDetails?.amount || order.returnRequest?.refundAmount || order.totalAmount || 0);
          sendFast2SmsRefundInitiated(cleanCustPhone, refAmt, order.orderId).catch(() => {});
        }
      }
    } catch (smsErr) {}

    try {
      broadcastRealtimeEvent({
        type: "ORDER_UPDATED",
        orderId: order.orderId,
        masterOrderId: order.masterOrderId,
        sellerId: order.sellerId,
        status: overallStatus
      });
    } catch (rtErr) {}

    return res.json({
      success: true,
      message: `Return/Exchange status updated to ${normalizeOrderStatus(canonicalReturnStatus, order)}`,
      order
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update return/exchange status", error: error.message });
  }
};