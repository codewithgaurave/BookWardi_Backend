import mongoose from "mongoose";
import Order from "../models/Order.js";
import SchoolBulkOrder from "../models/SchoolBulkOrder.js";
import { broadcastRealtimeEvent } from "../services/realtimeService.js";
import { calculateSellerSettlement, calculateSettlementMaturity, reconcileSellerSettlementBalances } from "../services/settlementService.js";
import { sendFast2SmsOtp, sendFast2SmsOrderDelivered, sendFast2SmsExchangeOtp, sendFast2SmsReturnOtp } from "../services/smsService.js";

// Helper to locate order or bulk requisition by token or ID
const findOrderByTokenOrId = async (tokenOrId) => {
  if (!tokenOrId) return null;

  let normalizedToken = String(tokenOrId).trim();
  // Strip full URL prefix if whole link was passed as token
  if (normalizedToken.includes('token=')) {
    const parts = normalizedToken.split('token=');
    normalizedToken = parts[parts.length - 1].split('&')[0];
  }
  normalizedToken = normalizedToken.trim();

  const tokenPattern = { $regex: `^${normalizedToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" };
  const cleanId = normalizedToken.replace(/^(DLV|BV-SLF|SLF)[-_]/i, '').trim();
  const cleanPattern = cleanId ? { $regex: `^${cleanId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } : null;

  // 1. Direct match on retail Order
  const retailConditions = [
    { "selfDeliveryDetails.deliveryPartnerToken": normalizedToken },
    { "selfDeliveryDetails.deliveryPartnerToken": tokenPattern },
    { "items.selfDeliveryDetails.deliveryPartnerToken": normalizedToken },
    { "items.selfDeliveryDetails.deliveryPartnerToken": tokenPattern },
    { trackingNumber: normalizedToken },
    { trackingNumber: tokenPattern },
    { orderId: normalizedToken },
    { orderId: tokenPattern },
    { id: normalizedToken }
  ];

  if (cleanId && cleanId !== normalizedToken) {
    retailConditions.push(
      { orderId: cleanId },
      { orderId: cleanPattern },
      { id: cleanId },
      { trackingNumber: cleanId },
      { "selfDeliveryDetails.deliveryPartnerToken": cleanId }
    );
  }

  if (mongoose.Types.ObjectId.isValid(normalizedToken)) {
    retailConditions.push({ _id: normalizedToken });
  }
  if (cleanId && mongoose.Types.ObjectId.isValid(cleanId)) {
    retailConditions.push({ _id: cleanId });
  }

  let order = await Order.findOne({ $or: retailConditions });

  // 2. Array elemMatch fallback
  if (!order) {
    const elemOrConditions = [
      { "deliveryPartnerToken": normalizedToken },
      { "deliveryPartnerToken": tokenPattern }
    ];
    if (cleanId && cleanId !== normalizedToken) {
      elemOrConditions.push(
        { "deliveryPartnerToken": cleanId },
        { "deliveryPartnerToken": cleanPattern }
      );
    }
    order = await Order.findOne({
      "items.selfDeliveryDetails": {
        $elemMatch: {
          $or: elemOrConditions
        }
      }
    });
  }

  if (order) {
    return { order, isBulk: false };
  }

  // 3. Check SchoolBulkOrder (Institutional B2B Orders)
  const bulkConditions = [
    { "deliveryDetails.deliveryPartnerToken": normalizedToken },
    { "deliveryDetails.deliveryPartnerToken": tokenPattern },
    { "deliveryDetails.trackingId": normalizedToken },
    { "deliveryDetails.trackingId": tokenPattern },
    { referenceId: normalizedToken },
    { referenceId: tokenPattern }
  ];

  if (cleanId && cleanId !== normalizedToken) {
    bulkConditions.push(
      { referenceId: cleanId },
      { referenceId: cleanPattern },
      { "deliveryDetails.trackingId": cleanId },
      { "deliveryDetails.deliveryPartnerToken": cleanId }
    );
  }

  if (mongoose.Types.ObjectId.isValid(normalizedToken)) {
    bulkConditions.push({ _id: normalizedToken });
  }
  if (cleanId && mongoose.Types.ObjectId.isValid(cleanId)) {
    bulkConditions.push({ _id: cleanId });
  }

  const bulkOrder = await SchoolBulkOrder.findOne({ $or: bulkConditions });
  if (bulkOrder) {
    return { order: bulkOrder, isBulk: true };
  }

  return null;
};

// 1. Get Delivery Partner Order View (Sanitized - OTP Omitted)
export const getDeliveryPartnerOrder = async (req, res) => {
  try {
    const { token } = req.params;
    const lookup = await findOrderByTokenOrId(token);

    if (!lookup) {
      return res.status(404).json({ success: false, message: "Delivery task not found or link expired." });
    }

    if (lookup.isBulk) {
      const bulkOrder = lookup.order;
      const winningQuote = (bulkOrder.quotations || []).find(
        q => String(q._id) === String(bulkOrder.acceptedQuoteId) || q.negotiationStage === "seller_accepted_counter" || q.status === "approved"
      );
      const totalAmount = Number(bulkOrder.overallBudget || bulkOrder.targetBudgetPerKit || winningQuote?.quoteAmount || 0);
      const advancePaidAmount = Number(bulkOrder.advancePaidAmount || 0);
      const remainingAmount = Math.max(0, totalAmount - advancePaidAmount);
      const isPaid = bulkOrder.remainingPaymentStatus === "paid" || bulkOrder.status === "completed" || bulkOrder.status === "delivered";

      const sanitizedSelfDetails = {
        deliveryPersonName: bulkOrder.deliveryDetails?.deliveryBoyName || "Store Fleet Rider",
        deliveryPersonPhone: bulkOrder.deliveryDetails?.deliveryBoyPhone || "",
        vehicleNumber: bulkOrder.deliveryDetails?.vehicleNumber || "Store Fleet",
        deliveryPartnerToken: bulkOrder.deliveryDetails?.deliveryPartnerToken || token,
        trackingUrl: bulkOrder.deliveryDetails?.trackingUrl || "",
        driverLocation: bulkOrder.deliveryDetails?.driverLocation || null,
        otpLastSentAt: bulkOrder.deliveryDetails?.otpLastSentAt || null,
        otpExpiresAt: bulkOrder.deliveryDetails?.otpExpiresAt || (bulkOrder.deliveryDetails?.otpLastSentAt ? new Date(new Date(bulkOrder.deliveryDetails.otpLastSentAt).getTime() + 10 * 60 * 1000) : null),
        notes: bulkOrder.deliveryDetails?.notes || ""
      };

      const sanitizedOrder = {
        id: bulkOrder._id,
        orderId: bulkOrder.referenceId,
        isBulkOrder: true,
        overallStatus: bulkOrder.status,
        status: bulkOrder.status,
        date: bulkOrder.createdAt ? new Date(bulkOrder.createdAt).toLocaleDateString("en-IN") : "",
        totalAmount,
        advancePaidAmount,
        remainingAmount,
        paymentMethod: "Online / UPI (Razorpay)",
        paymentStatus: isPaid ? "paid" : "pending_balance",
        customer: {
          name: bulkOrder.institutionName || bulkOrder.contactName || "School Campus",
          phone: bulkOrder.contactPhone || bulkOrder.userPhone || "",
          email: bulkOrder.contactEmail || bulkOrder.userEmail || "",
          designation: bulkOrder.designation || "Administrator"
        },
        shippingAddress: {
          street: bulkOrder.address || "",
          city: bulkOrder.city || "",
          state: bulkOrder.state || "",
          pincode: bulkOrder.pincode || ""
        },
        items: (bulkOrder.requirements || []).map((r, i) => ({
          id: r._id || i + 1,
          name: r.itemName || "Institutional Uniform / Supply",
          price: Number(r.sellerPricePerUnit || 0),
          quantity: Number(r.quantity || 1),
          size: r.size || "",
          category: r.category || "School Uniform",
          image: r.samplePhoto || ""
        })),
        sellerDetails: {
          storeName: winningQuote?.sellerStoreName || winningQuote?.sellerName || "Store Fleet",
          phone: winningQuote?.sellerPhone || "",
          email: winningQuote?.sellerEmail || ""
        },
        selfDeliveryDetails: sanitizedSelfDetails
      };

      return res.json({ success: true, order: sanitizedOrder });
    }

    const order = lookup.order;

    // Prepare sanitized self delivery details (omit deliveryOtp for security)
    const selfDetails = order.selfDeliveryDetails || order.items?.[0]?.selfDeliveryDetails || {};
    const sanitizedSelfDetails = {
      deliveryPersonName: selfDetails.deliveryPersonName || "",
      deliveryPersonPhone: selfDetails.deliveryPersonPhone || "",
      vehicleNumber: selfDetails.vehicleNumber || "",
      deliveryPartnerToken: selfDetails.deliveryPartnerToken || token,
      trackingUrl: selfDetails.trackingUrl || "",
      driverLocation: selfDetails.driverLocation || null,
      otpLastSentAt: selfDetails.otpLastSentAt || order.updatedAt || order.createdAt || new Date(),
      otpExpiresAt: selfDetails.otpExpiresAt || new Date(new Date(selfDetails.otpLastSentAt || order.updatedAt || order.createdAt || Date.now()).getTime() + 24 * 60 * 60 * 1000)
    };

    const isExchangeOrder = Boolean(
      order.returnRequest?.type === 'exchange' ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('exchange')
    );
    const isReturnOrder = Boolean(
      order.returnRequest?.type === 'return' ||
      (!isExchangeOrder && Boolean(order.returnRequest?.type || order.returnRequest?.reason)) ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('return') ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('pickup')
    );

    const sanitizedOrder = {
      id: order._id,
      orderId: order.orderId || order.id || order._id,
      overallStatus: order.overallStatus || order.status || "Processing",
      status: order.overallStatus || order.status || "Processing",
      date: order.date || (order.createdAt ? new Date(order.createdAt).toLocaleDateString("en-IN") : ""),
      totalAmount: order.totalAmount || order.total || 0,
      subtotal: order.subtotal || (order.items || []).reduce((s, it) => s + (Number(it.finalPrice || it.price || 0) * Number(it.quantity || 1)), 0),
      shippingFee: order.shippingFee !== undefined ? order.shippingFee : (order.shippingCost !== undefined ? order.shippingCost : 0),
      shippingCost: order.shippingCost !== undefined ? order.shippingCost : (order.shippingFee !== undefined ? order.shippingFee : 0),
      discount: order.discount || order.discountAmount || 0,
      discountAmount: order.discountAmount || order.discount || 0,
      gst: order.gst || order.taxAmount || 0,
      paymentMethod: order.paymentMethod || "COD",
      paymentStatus: (() => {
        if (isReturnOrder) return "return_in_progress";
        const rawMethod = String(order.paymentMethod || "").toLowerCase();
        const isCodOrder = rawMethod.includes("cod") || rawMethod.includes("cash") || Boolean(order.isCod);
        const isDelivered = order.overallStatus === "Delivered" || order.status === "Delivered" || Boolean(order.codCollectedAt);
        if (isCodOrder) {
          return isDelivered ? "paid" : "pending";
        }
        return order.paymentStatus || "pending";
      })(),
      customer: {
        name: order.customer?.name || "Customer",
        phone: order.customer?.phone || order.shippingAddress?.phone || "",
        email: order.customer?.email || ""
      },
      shippingAddress: order.shippingAddress || { street: order.address || "" },
      items: (order.items || []).map((it) => ({
        id: it._id || it.id,
        name: it.name,
        price: it.finalPrice || it.price,
        quantity: it.quantity || 1,
        size: it.size || "",
        unit: it.unit || "",
        isMeterBased: it.isMeterBased || false,
        subCategory: it.subCategory || "",
        category: it.category || "Stationery",
        image: (it.image && it.image.startsWith("data:") && it.image.length > 30000)
          ? "https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=500&auto=format&fit=crop&q=80"
          : (it.image || ""),
        sellerName: it.sellerName || it.storeName || order.sellerDetails?.storeName || "",
        storeName: it.storeName || it.sellerName || order.sellerDetails?.storeName || "",
        sellerPhone: it.sellerPhone || order.sellerDetails?.phone || "",
        sellerDetails: it.sellerDetails || order.sellerDetails || null
      })),
      sellerDetails: order.sellerDetails || order.items?.[0]?.sellerDetails || {
        storeName: order.items?.[0]?.storeName || order.items?.[0]?.sellerName || "Partner Merchant",
        sellerName: order.items?.[0]?.sellerName || order.items?.[0]?.storeName || "Partner Merchant",
        phone: order.items?.[0]?.sellerPhone || "",
        email: order.items?.[0]?.sellerEmail || "",
        address: order.items?.[0]?.sellerAddress || ""
      },
      isExchangeTask: isExchangeOrder,
      isReturnTask: isReturnOrder,
      returnRequest: order.returnRequest ? {
        type: order.returnRequest.type,
        reason: order.returnRequest.reason,
        comment: order.returnRequest.comment,
        itemId: order.returnRequest.itemId,
        itemName: order.returnRequest.itemName,
        exchangeSize: order.returnRequest.exchangeSize,
        exchangeLength: order.returnRequest.exchangeLength,
        isMeterBased: order.returnRequest.isMeterBased,
        priceDifference: order.returnRequest.priceDifference || 0,
        priceAdjustmentType: order.returnRequest.priceAdjustmentType || 'none',
        originalItemPrice: order.returnRequest.originalItemPrice || 0,
        replacementItemPrice: order.returnRequest.replacementItemPrice || 0,
        refundAmount: order.returnRequest.refundAmount || order.totalAmount || order.total || 0,
        refundDetails: order.returnRequest.refundDetails || null,
        status: order.returnRequest.status,
        pickupDate: order.returnRequest.pickupDate
      } : null,
      selfDeliveryDetails: sanitizedSelfDetails
    };

    return res.json({ success: true, order: sanitizedOrder });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch delivery task", error: error.message });
  }
};

// 2. Resend Delivery OTP to Customer
export const resendCustomerDeliveryOtp = async (req, res) => {
  try {
    const { token } = req.params;
    const isCashCollected = Boolean(
      req.body?.isCashCollected ||
      req.query?.isCashCollected === 'true' ||
      req.body?.isPaymentVerified
    );
    const lookup = await findOrderByTokenOrId(token);

    if (!lookup) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const now = new Date();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours live OTP validity
    const freshOtp = Math.floor(1000 + Math.random() * 9000).toString();

    if (lookup.isBulk) {
      const bulkOrder = lookup.order;
      const isPaid = bulkOrder.remainingPaymentStatus === "paid" || bulkOrder.status === "completed" || bulkOrder.status === "delivered";

      if (!isPaid) {
        return res.status(400).json({
          success: false,
          message: "🔒 Remaining balance for School Bulk Order must be paid online via Razorpay / UPI before sending OTP."
        });
      }

      if (!bulkOrder.deliveryDetails) bulkOrder.deliveryDetails = {};
      bulkOrder.deliveryDetails.deliveryOtp = freshOtp;
      bulkOrder.deliveryDetails.otpLastSentAt = now;
      bulkOrder.deliveryDetails.otpExpiresAt = expiresAt;
      bulkOrder.deliveryOtp = freshOtp;
      await bulkOrder.save();

      await SchoolBulkOrder.updateOne(
        { _id: bulkOrder._id },
        {
          $set: {
            deliveryOtp: freshOtp,
            "deliveryDetails.deliveryOtp": freshOtp,
            "deliveryDetails.otpLastSentAt": now,
            "deliveryDetails.otpExpiresAt": expiresAt
          }
        }
      );

      const rawCustomerPhone = bulkOrder.contactPhone || bulkOrder.userPhone || "";
      const cleanPhone = String(rawCustomerPhone).replace(/\D/g, "").slice(-10);

      if (cleanPhone && cleanPhone.length === 10) {
        try {
          await sendFast2SmsOtp(cleanPhone, freshOtp);
          console.log(`📲 [FAST2SMS] Bulk Delivery OTP sent successfully to +91 ${cleanPhone} for Requisition #${bulkOrder.referenceId}`);
        } catch (smsErr) {
          console.warn("⚠️ [FAST2SMS] Failed to send bulk delivery OTP:", smsErr.message);
        }
      }

      const maskedPhone = cleanPhone ? cleanPhone.slice(-4).padStart(10, 'X') : "registered mobile";

      return res.json({
        success: true,
        message: `Delivery OTP has been sent via SMS to customer's registered mobile (+91 ${maskedPhone}).`,
        otpLastSentAt: now,
        otpExpiresAt: expiresAt,
        cooldownSeconds: 60
      });
    }

    const order = lookup.order;
    const isExchangeOrder = Boolean(
      order.returnRequest?.type === 'exchange' ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('exchange')
    );
    const isReturnOrder = Boolean(
      order.returnRequest?.type === 'return' ||
      (!isExchangeOrder && Boolean(order.returnRequest?.type || order.returnRequest?.reason)) ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('return') ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('pickup')
    );

    const returnReq = order.returnRequest || {};
    const exchangeDiff = Number(returnReq.priceDifference || 0);
    const exchangeAdjType = returnReq.priceAdjustmentType || (exchangeDiff > 0 ? 'extra_payment' : exchangeDiff < 0 ? 'partial_refund' : 'none');
    const isExchangeExtraPayment = isExchangeOrder && exchangeAdjType === 'extra_payment' && exchangeDiff > 0;

    const rawMethod = String(order.paymentMethod || "").toLowerCase();
    const isCodOrder = !isExchangeOrder && !isReturnOrder && (rawMethod.includes("cod") || rawMethod.includes("cash") || Boolean(order.isCod));

    const isPaid = isReturnOrder
      ? true
      : (isExchangeOrder
        ? (!isExchangeExtraPayment || isCashCollected)
        : (isCodOrder
          ? Boolean(isCashCollected || order.overallStatus === "Delivered" || order.codCollectedAt)
          : (order.paymentStatus === "paid" || order.paymentStatus === "Paid" || isCashCollected)));

    if (!isPaid) {
      return res.status(400).json({
        success: false,
        message: isExchangeExtraPayment
          ? `🔒 Extra exchange charge of ₹${exchangeDiff} must be collected from customer before sending OTP.`
          : "🔒 Cash payment must be collected & verified by executive before sending OTP."
      });
    }

    const partnerToken = order.selfDeliveryDetails?.deliveryPartnerToken || `DLV-${order.orderId || token}`;

    order.deliveryMode = "self_delivery";
    order.deliveryOtp = freshOtp;
    if (!order.selfDeliveryDetails) {
      order.selfDeliveryDetails = {};
    }
    order.selfDeliveryDetails.deliveryOtp = freshOtp;
    order.selfDeliveryDetails.otpLastSentAt = now;
    order.selfDeliveryDetails.otpExpiresAt = expiresAt;
    order.selfDeliveryDetails.deliveryPartnerToken = partnerToken;

    if (Array.isArray(order.items)) {
      order.items.forEach((item) => {
        item.deliveryOtp = freshOtp;
        if (!item.selfDeliveryDetails) item.selfDeliveryDetails = {};
        item.selfDeliveryDetails.deliveryOtp = freshOtp;
        item.selfDeliveryDetails.otpLastSentAt = now;
        item.selfDeliveryDetails.otpExpiresAt = expiresAt;
      });
    }

    await order.save();

    // Direct MongoDB persistence to guarantee OTP is saved in database without being modified
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          deliveryMode: "self_delivery",
          deliveryOtp: freshOtp,
          "selfDeliveryDetails.deliveryOtp": freshOtp,
          "selfDeliveryDetails.otpLastSentAt": now,
          "selfDeliveryDetails.otpExpiresAt": expiresAt,
          "selfDeliveryDetails.deliveryPartnerToken": partnerToken,
          ...(Array.isArray(order.items) ? {
            items: order.items.map(it => ({
              ...(it.toObject ? it.toObject() : it),
              deliveryOtp: freshOtp,
              selfDeliveryDetails: {
                ...(it.selfDeliveryDetails || {}),
                deliveryOtp: freshOtp,
                otpLastSentAt: now,
                otpExpiresAt: expiresAt
              }
            }))
          } : {})
        }
      }
    );

    const rawCustomerPhone = order.customer?.phone || order.shippingAddress?.phone || order.phone || "";
    const cleanPhone = String(rawCustomerPhone).replace(/\D/g, "").slice(-10);
    const taskTypeName = isReturnOrder ? "Return Pickup OTP" : (isExchangeOrder ? "Exchange Delivery OTP" : "Delivery OTP");

    if (cleanPhone && cleanPhone.length === 10) {
      try {
        const orderIdentifier = order.orderId || order.referenceId || order.id || token;
        if (isExchangeOrder) {
          await sendFast2SmsExchangeOtp(cleanPhone, orderIdentifier, freshOtp);
        } else if (isReturnOrder) {
          await sendFast2SmsReturnOtp(cleanPhone, orderIdentifier, freshOtp);
        } else {
          await sendFast2SmsOtp(cleanPhone, freshOtp);
        }
        console.log(`📲 [FAST2SMS] ${taskTypeName} sent successfully to +91 ${cleanPhone} for Order #${order.orderId}`);
      } catch (smsErr) {
        console.warn(`⚠️ [FAST2SMS] Failed to send ${taskTypeName}:`, smsErr.message);
      }
    }

    const maskedPhone = cleanPhone ? cleanPhone.slice(-4).padStart(10, 'X') : "registered mobile";

    return res.json({
      success: true,
      message: `${taskTypeName} has been sent via SMS to customer's registered mobile (+91 ${maskedPhone}).`,
      otpLastSentAt: now,
      otpExpiresAt: expiresAt,
      cooldownSeconds: 60
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to resend OTP", error: error.message });
  }
};

// 3. Verify Delivery OTP and Complete Order / Exchange / Return
export const verifyDeliveryOtp = async (req, res) => {
  try {
    const { token } = req.params;
    const { otp, isCashCollected, isPaymentVerified } = req.body;

    if (!otp) {
      return res.status(400).json({ success: false, message: "4-digit OTP is required." });
    }

    const providedOtp = String(otp).trim();
    const lookup = await findOrderByTokenOrId(token);

    if (!lookup) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const hasConfirmedPayment = Boolean(isCashCollected || isPaymentVerified);

    if (lookup.isBulk) {
      const bulkOrder = lookup.order;
      const isPaid = bulkOrder.remainingPaymentStatus === "paid" || bulkOrder.status === "completed" || bulkOrder.status === "delivered";

      if (!isPaid) {
        return res.status(400).json({
          success: false,
          message: "🔒 Remaining balance for School Bulk Order must be paid online via Razorpay / UPI before delivery OTP can be verified."
        });
      }

      // Check OTP expiry (10 min expiry)
      const bulkExpiresAt = bulkOrder.deliveryDetails?.otpExpiresAt;
      const bulkLastSentAt = bulkOrder.deliveryDetails?.otpLastSentAt;
      const nowMs = Date.now();
      if (bulkExpiresAt) {
        if (nowMs > new Date(bulkExpiresAt).getTime()) {
          return res.status(400).json({
            success: false,
            message: "Delivery OTP has expired. Please click 'Resend OTP' to get a fresh PIN."
          });
        }
      } else if (bulkLastSentAt && (nowMs - new Date(bulkLastSentAt).getTime()) > 24 * 60 * 60 * 1000) {
        return res.status(400).json({
          success: false,
          message: "Delivery OTP has expired. Please click 'Resend OTP' to get a fresh PIN."
        });
      }

      const expectedOtp = String(bulkOrder.deliveryDetails?.deliveryOtp || bulkOrder.deliveryOtp || "").trim();

      if (!expectedOtp || providedOtp !== expectedOtp) {
        return res.status(400).json({
          success: false,
          message: "Invalid Delivery OTP. Please enter the correct 4-digit PIN sent to customer's mobile."
        });
      }

      // Invalidate OTP once verified
      bulkOrder.deliveryOtp = "";
      if (bulkOrder.deliveryDetails) bulkOrder.deliveryDetails.deliveryOtp = "";

      bulkOrder.status = "delivered";
      bulkOrder.overallStatus = "Delivered";
      bulkOrder.deliveryStatus = "Delivered";
      if (!bulkOrder.deliveryDetails) bulkOrder.deliveryDetails = {};
      bulkOrder.deliveryDetails.deliveredAt = new Date();
      bulkOrder.deliveryDetails.status = "Delivered";
      if (bulkOrder.remainingPaymentStatus !== "paid") {
        bulkOrder.remainingPaymentStatus = "paid";
        bulkOrder.remainingPaidAt = new Date();
        bulkOrder.remainingPaymentMode = "Razorpay / UPI Verified";
      }
      await bulkOrder.save();

      try {
        broadcastRealtimeEvent({
          type: "SCHOOL_ORDER_UPDATED",
          orderId: bulkOrder.referenceId || bulkOrder._id,
          id: String(bulkOrder._id),
          referenceId: bulkOrder.referenceId,
          status: "delivered",
          deliveryStatus: "delivered",
          remainingPaymentStatus: "paid",
          deliveredAt: bulkOrder.deliveryDetails?.deliveredAt
        });
      } catch (rtErr) {}

      // Template 225930: Delivered SMS
      try {
        const rawBulkPhone = bulkOrder.deliveryDetails?.deliveryBoyPhone || bulkOrder.contactPhone || bulkOrder.phone;
        const cleanBulkPhone = String(rawBulkPhone || "").replace(/\D/g, "").slice(-10);
        if (cleanBulkPhone.length === 10) {
          sendFast2SmsOrderDelivered(cleanBulkPhone, bulkOrder.referenceId || bulkOrder._id).catch(() => {});
        }
      } catch (e) {}

      return res.json({
        success: true,
        message: "🎉 Delivery OTP verified successfully! Bulk order marked as Delivered.",
        orderId: bulkOrder.referenceId,
        status: "delivered"
      });
    }

    const order = lookup.order;
    const isExchangeOrder = Boolean(
      order.returnRequest?.type === 'exchange' ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('exchange')
    );
    const isReturnOrder = Boolean(
      order.returnRequest?.type === 'return' ||
      (!isExchangeOrder && Boolean(order.returnRequest?.type || order.returnRequest?.reason)) ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('return') ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('pickup')
    );

    const returnReq = order.returnRequest || {};
    const exchangeDiff = Number(returnReq.priceDifference || 0);
    const exchangeAdjType = returnReq.priceAdjustmentType || (exchangeDiff > 0 ? 'extra_payment' : exchangeDiff < 0 ? 'partial_refund' : 'none');
    const isExchangeExtraPayment = isExchangeOrder && exchangeAdjType === 'extra_payment' && exchangeDiff > 0;

    const isPaid = isReturnOrder
      ? true
      : (isExchangeOrder
        ? (!isExchangeExtraPayment || hasConfirmedPayment)
        : (order.paymentStatus === "paid" || order.paymentStatus === "Paid" || hasConfirmedPayment));

    if (!isPaid) {
      return res.status(400).json({
        success: false,
        message: isExchangeExtraPayment
          ? `🔒 Extra payment of ₹${exchangeDiff} must be collected from customer before exchange OTP can be verified.`
          : "🔒 Payment must be collected & verified before delivery OTP can be verified."
      });
    }

    // Check OTP expiry (24 hours active validity window)
    const otpExpiresAt = order.selfDeliveryDetails?.otpExpiresAt;
    const otpLastSentAt = order.selfDeliveryDetails?.otpLastSentAt;
    const nowMs = Date.now();
    if (otpExpiresAt) {
      if (nowMs > new Date(otpExpiresAt).getTime()) {
        return res.status(400).json({
          success: false,
          message: "Delivery OTP has expired. Please click 'Resend OTP' to get a fresh PIN."
        });
      }
    } else if (otpLastSentAt && (nowMs - new Date(otpLastSentAt).getTime()) > 24 * 60 * 60 * 1000) {
      return res.status(400).json({
        success: false,
        message: "Delivery OTP has expired. Please click 'Resend OTP' to get a fresh PIN."
      });
    }

    const expectedOtp = String(
      order.deliveryOtp ||
      order.selfDeliveryDetails?.deliveryOtp ||
      order.items?.[0]?.deliveryOtp ||
      order.items?.[0]?.selfDeliveryDetails?.deliveryOtp ||
      ""
    ).trim();

    if (!expectedOtp || providedOtp !== expectedOtp) {
      return res.status(400).json({
        success: false,
        message: isReturnOrder
          ? "Invalid Return Pickup OTP. Please ask customer for the correct 4-digit Return PIN sent to their mobile."
          : (isExchangeOrder
            ? "Invalid Exchange OTP. Please ask customer for the correct 4-digit Exchange PIN sent to their mobile."
            : "Invalid Delivery OTP. Please enter the correct 4-digit PIN sent to customer's mobile.")
      });
    }

    // Invalidate/clear OTP once verified to prevent reuse
    order.deliveryOtp = "";
    if (order.selfDeliveryDetails) order.selfDeliveryDetails.deliveryOtp = "";
    if (Array.isArray(order.items)) {
      order.items.forEach((it) => {
        it.deliveryOtp = "";
        if (it.selfDeliveryDetails) it.selfDeliveryDetails.deliveryOtp = "";
      });
    }

    // Mark order as Delivered, Exchanged, or Product Received upon OTP verification
    const previousStatus = order.overallStatus;
    const isCodOrder = !isExchangeOrder && !isReturnOrder && (String(order.paymentMethod || '').toUpperCase().includes("COD") || order.paymentStatus !== "paid");
    const deliveryExecName = order.selfDeliveryDetails?.deliveryPersonName || "Delivery Executive";
    const now = new Date();

    const finalStatus = isReturnOrder ? "product_received" : (isExchangeOrder ? "exchanged" : "Delivered");
    order.overallStatus = finalStatus;
    order.status = finalStatus;
    order.deliveryStatus = isReturnOrder ? "Returned (Product Received)" : (isExchangeOrder ? "Exchange Completed" : "Delivered");

    if (!isReturnOrder) {
      order.paymentStatus = "paid";
      order.deliveredAt = now;
      if (isCodOrder || isExchangeExtraPayment) {
        order.codCollectedAt = now;
        order.codCollectedBy = deliveryExecName;
      }
    }

    if (isReturnOrder && order.returnRequest) {
      order.returnRequest.status = "product_received";
      order.returnRequest.pickupDate = now;
      order.returnRequest.updatedAt = now;
    } else if (isExchangeOrder && order.returnRequest) {
      order.returnRequest.status = "exchanged";
      order.returnRequest.exchangedAt = now;
      order.returnRequest.updatedAt = now;
      order.exchangedAt = now;
      const exchangeSettlementDueDate = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
      order.settlementDueDate = exchangeSettlementDueDate;
      order.settlementStatus = "pending_exchange_buffer";
      order.isSettlementMatured = false;
    }

    if (!order.selfDeliveryDetails) order.selfDeliveryDetails = {};
    order.selfDeliveryDetails.deliveredAt = now;
    order.selfDeliveryDetails.status = isReturnOrder ? "Pickup Completed" : (isExchangeOrder ? "Exchange Completed" : "Delivered");

    if (Array.isArray(order.items)) {
      const targetExchItemId = order.returnRequest?.itemId ? String(order.returnRequest.itemId) : null;
      const targetExchItemName = order.returnRequest?.itemName ? String(order.returnRequest.itemName).trim().toLowerCase() : null;

      order.items.forEach((it) => {
        // Partial exchange check: if this order has multiple items and only one was requested for exchange,
        // ONLY the exchanged item transitions to "exchanged", keeping other delivered items intact!
        const isTargetOfExchange = isExchangeOrder && (targetExchItemId || targetExchItemName)
          ? (
              (targetExchItemId && (String(it._id || it.id || it.productId) === targetExchItemId)) ||
              (targetExchItemName && String(it.name || '').trim().toLowerCase() === targetExchItemName)
            )
          : true;

        if (isExchangeOrder && !isTargetOfExchange) {
          // Leave non-exchanged delivered items as they are
          return;
        }

        it.status = finalStatus;
        if (!it.selfDeliveryDetails) it.selfDeliveryDetails = {};
        it.selfDeliveryDetails.deliveredAt = now;
        it.selfDeliveryDetails.status = isReturnOrder ? "Pickup Completed" : (isExchangeOrder ? "Exchange Completed" : "Delivered");
        if (isExchangeOrder) {
          it.exchangedAt = now;
          it.settlementDueDate = order.settlementDueDate;
          it.settlementStatus = "pending_exchange_buffer";
          it.isSettlementMatured = false;
        }
      });
    }

    // Auto-restore stock for returned / exchanged items upon OTP verification
    if (isReturnOrder || isExchangeOrder) {
      try {
        const Product = (await import("../models/Product.js")).default;
        for (const item of order.items || []) {
          const pId = item.productId || item._id;
          const qty = Number(item.quantity || 1);
          if (pId && Product) {
            await Product.findByIdAndUpdate(pId, { $inc: { stock: qty } });
            console.log(`📦 [AUTO-RESTOCK] Restored ${qty} units to product ${pId} on ${isExchangeOrder ? 'exchange' : 'return'} pickup verification.`);
          }
        }
      } catch (stockErr) {
        console.warn("Stock auto-restoration notice:", stockErr.message);
      }
    }

    // Credit seller wallet earnings if newly delivered
    if (!isReturnOrder && !isExchangeOrder && previousStatus !== "Delivered" && previousStatus !== "delivered") {
      try {
        const Seller = (await import("../models/Seller.js")).default;
        for (const item of order.items || []) {
          if (item.sellerId) {
            const seller = await Seller.findById(item.sellerId);
            if (seller) {
              const itemTotal = item.total || (item.finalPrice || item.price || 0) * (item.quantity || 1);
              const commRate = Number(item.commissionRate ?? order.commissionRate ?? seller.commissionRate ?? seller.commissionPercentage ?? 10);
              const ordTotal = Number(order.totalAmount || order.total || itemTotal);
              const itemGstRate = Number(item.gstPercent ?? item.gstPercentage ?? item.gstRate ?? item.gst ?? (item.category?.toLowerCase()?.includes('book') ? 0 : 5));
              const stl = calculateSellerSettlement(itemTotal, {
                commissionRate: commRate,
                paymentMethod: order.paymentMethod,
                deliveryMode: order.deliveryMode || "self_delivery",
                courierName: order.courierName || item.thirdPartyDetails?.courierName,
                orderTotal: ordTotal,
                sellerState: seller.state || seller.storeDetails?.state || "Uttar Pradesh",
                customerState: order.shippingAddress?.state || "Uttar Pradesh",
                gstRate: itemGstRate,
                category: item.category || "",
                name: item.name || item.productName || "",
                deliveryCharge: order.shippingAmount || order.deliveryCharge || 40,
                freeDeliveryThreshold: Number(order.freeDeliveryThreshold ?? 401),
                deliveryChargeBorneBy: order.deliveryChargeBorneBy || (ordTotal >= Number(order.freeDeliveryThreshold ?? 401) ? 'admin' : (Number(order.shippingAmount || 0) > 0 ? 'customer' : 'seller'))
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
              item.totalDeductions = stl.totalDeductions;
              item.netSettlementAmount = stl.netSettlement;
              item.settlementRule = stl.ruleCode;

              const maturity = calculateSettlementMaturity({ order, item, deliveredAt: now, now });
              item.settlementDueDate = maturity.settlementDueDate;
              item.returnWindowDays = maturity.returnWindowDays;

              const sellerNetSettlement = stl.netSettlement;
              const realEarnings = stl.isSellerCollectedCash
                ? Math.round((itemTotal - stl.totalDeductions) * 100) / 100
                : sellerNetSettlement;

              if (maturity.isMatured) {
                item.settlementStatus = "credited";
                item.isSettlementMatured = true;
                item.settlementMaturedAt = now;
                seller.walletBalance = Math.round(((seller.walletBalance || 0) + sellerNetSettlement) * 100) / 100;
              } else {
                item.settlementStatus = "pending_return_window";
                item.isSettlementMatured = false;
                seller.pendingSettlementBalance = Math.round(((seller.pendingSettlementBalance || 0) + sellerNetSettlement) * 100) / 100;
              }

              seller.totalEarnings = Math.round(((seller.totalEarnings || 0) + realEarnings) * 100) / 100;
              await seller.save();

              order.settlementDueDate = maturity.settlementDueDate;
              order.settlementStatus = maturity.isMatured ? "credited" : "pending_return_window";
            }
          }
        }
      } catch (err) {
        console.warn("⚠️ Earnings credit warning on self delivery:", err.message);
      }
    }

    // Append timeline event
    order.timeline = order.timeline || [];
    order.timeline.push({
      status: finalStatus.toLowerCase(),
      title: isReturnOrder
        ? "Return Pickup Completed via OTP Verification"
        : (isExchangeOrder
          ? (isExchangeExtraPayment ? `Exchange Completed & Extra ₹${exchangeDiff} Collected` : "Exchange Completed via OTP Verification")
          : (isCodOrder ? "COD Payment Collected & Order Delivered" : "Order Delivered via OTP Verification")),
      description: isReturnOrder
        ? `Return item collected from customer by ${deliveryExecName} and customer OTP verified. Item marked as Product Received.`
        : (isExchangeOrder
          ? `Exchange handover completed by ${deliveryExecName} and customer OTP verified.${isExchangeExtraPayment ? ` Extra amount of ₹${exchangeDiff} collected.` : ''}`
          : (isCodOrder
            ? `Cash on Delivery (₹${order.totalAmount || order.total || 0}) collected by ${deliveryExecName} and customer OTP verified.`
            : `Order successfully delivered by ${deliveryExecName} and customer OTP verified.`)),
      location: order.shippingAddress?.city || order.shippingAddress?.town || "Customer Address",
      timestamp: now,
      updatedBy: "Delivery Executive"
    });

    await order.save();

    // Trigger instant settlement balance reconciliation for seller
    try {
      const primarySellerId = order.sellerId || (order.items && order.items[0]?.sellerId);
      if (primarySellerId) {
        reconcileSellerSettlementBalances(primarySellerId).catch(() => {});
      }
    } catch (reconcileErr) {
      console.warn("Auto-reconcile on delivery OTP verification warning:", reconcileErr.message);
    }

    try {
      broadcastRealtimeEvent({
        type: "ORDER_UPDATED",
        orderId: order.orderId || order.id || order._id,
        masterOrderId: order.masterOrderId,
        sellerId: order.sellerId,
        status: finalStatus
      });
    } catch (rtErr) {}

    // Template 225930: Retail Order Delivered SMS
    if (finalStatus === "Delivered") {
      try {
        const rawCustomerPhone = order.customer?.phone || order.shippingAddress?.phone || order.phone || "";
        const cleanPhone = String(rawCustomerPhone).replace(/\D/g, "").slice(-10);
        if (cleanPhone.length === 10) {
          sendFast2SmsOrderDelivered(cleanPhone, order.orderId || order._id).catch(() => {});
        }
      } catch (e) {}
    }

    return res.json({
      success: true,
      message: isReturnOrder
        ? "🎉 Return Pickup OTP verified successfully! Item collected and marked as Product Received."
        : (isExchangeOrder
          ? "🎉 Exchange OTP verified successfully! Replacement delivered & original item collected."
          : "🎉 Delivery OTP verified successfully! Order marked as Delivered."),
      orderId: order.orderId,
      status: finalStatus
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to verify OTP", error: error.message });
  }
};

// 4. Update Delivery Executive Live GPS Coordinates
export const updateDriverLocation = async (req, res) => {
  try {
    const { token } = req.params;
    const { lat, lng } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ success: false, message: "Valid lat and lng coordinates required." });
    }

    const lookup = await findOrderByTokenOrId(token);
    if (!lookup) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    if (lookup.isBulk) {
      const bulkOrder = lookup.order;
      if (!bulkOrder.deliveryDetails) bulkOrder.deliveryDetails = {};
      bulkOrder.deliveryDetails.driverLocation = {
        lat: Number(lat),
        lng: Number(lng),
        updatedAt: new Date()
      };
      await bulkOrder.save();
      return res.json({ success: true, message: "Driver location updated successfully." });
    }

    const order = lookup.order;

    if (!order.selfDeliveryDetails) order.selfDeliveryDetails = {};
    order.selfDeliveryDetails.driverLocation = {
      lat: Number(lat),
      lng: Number(lng),
      updatedAt: new Date()
    };

    await order.save();
    return res.json({ success: true, message: "Driver location updated successfully." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to update location", error: error.message });
  }
};
