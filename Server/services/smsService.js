/**
 * Fast2SMS DLT SMS Service for Book Vardi
 * Sender ID: BKVRDI
 * Entity ID: 1101532180000098761
 * Entity Name: NATIONAL SCHOOL DRESS EVAM PUSTAK BHANDAR
 *
 * Approved DLT Templates:
 *  1. [225935] OTP: "your BOOK VARDI otp is {#VAR#} . do not share this otp with anyone . -BOOK VARDI"
 *  2. [228314] Order Placed: "DEAR CUSTOMER , YOUR ORDER {#VAR#} HAS BEEN PLACED SUCCESSFULLY . WE WILL NOTIFY YOU ONCE THE SELLER CONFIRMS YOUR ORDER . - BOOK VARDI -BOOK VARDI"
 *  3. [225934] Order Confirmed: "Your BOOK VARDI order {#VAR#} has been confirmed successfully -BOOK VARDI"
 *  3b. [228930] Order Confirmed with Self Delivery OTP: "Your BOOK VARDI order {#VAR#} is confirmed. Your delivery OTP is {#VAR#}. Please share this OTP with the seller only upon receiving your order. -BOOK VARDI -BOOK VARDI"
 *  4. [228311] Seller New Order Alert: "HELLO SELLER , YOU HAVE RECEIVED A NEW ORDER {#VAR#} ON BOOK VARDI . PLEASE LOGIN TO YOUR SELLER PANEL TO CONFIRM AND PACK THE ORDER . - BOOK VARDI -BOOK VARDI"
 *  5. [228313] Return/Exchange Approved: "YOUR {#VAR#} REQUEST FOR BOOK VARDI ORDER {#VAR#} HAS BEEN APPROVED . OUR COURIER PARTNER WILL CONTACT YOU SOON FOR PICKUP . - BOOK VARDI -BOOK VARDI"
 *  6. [228312] Refund Processed: "REFUND OF RS .{#VAR#} FOR YOUR BOOK VARDI ORDER {#VAR#} HAS BEEN PROCESSED SUCCESSFULLY . REF NO : {#VAR#} . IT WILL CREDIT IN 3-5 BANK DAYS . - BOOK VARDI -BOOK VARDI"
 *  7. [228310] Bulk School Inquiry: "NEW BULK SCHOOL INQUIRY IS LIVE ON BOOK VARDI FOR BIDDING . LOGIN TO YOUR SELLER PORTAL TO SUMBIT YOUR QUOTATION . - BOOK VARDI -BOOK VARDI"
 *  8. [225933] Shipped + Track Link: "Your BOOK VARDI order {#VAR#} has been shipped . Track your order here : {#VAR#} -BOOK VARDI"
 *  9. [225932] Shipped (Basic): "Your BOOK VARDI order {#VAR#} has been shipped . -BOOK VARDI"
 * 10. [225931] Out For Delivery: "Your BOOK VARDI {#VAR#} is out for delivery and will reach you soon . -BOOK VARDI"
 * 11. [225930] Delivered: "Your book vardi order {#VAR#} has been delivered successfully . Thank you for shopping with us -BOOK VARDI"
 * 12. [225929] Cancelled: "Your book vardi order {#VAR#} has been cancelled successfully . -BOOK VARDI"
 * 13. [225928] Payment Success: "Payment of rs {#VAR#} for your book vardi order {#VAR#} was successful . -BOOK VARDI"
 * 14. [225927] Payment Failed: "Payment of rs {#VAR#} for your book vardi order {#VAR#} was unsuccessful . please try again . -BOOK VARDI"
 * 15. [225926] Refund Initiated: "Refund of rs {#VAR#} for your book vardi order {#VAR#} has been initiated . -BOOK VARDI"
 * 16. [225925] Back to School Promo: "Back to school shopping is now easier with book vardi . Shop school uniforms and books today : {#VAR#} -BOOK VARDI"
 * 17. [225924] Special Discount Promo: "Book vardi special discount is available on school uniforms and books . shop now and save more . -BOOK VARDI"
 */

// Core internal dispatcher for Fast2SMS DLT
const dispatchFast2Sms = async ({ phone, messageId, variablesValues = "", label = "DLT SMS" }) => {
  const apiKey = process.env.FAST2SMS_API_KEY;
  const route = process.env.FAST2SMS_ROUTE || "dlt";
  const senderId = process.env.FAST2SMS_SENDER_ID || "BKVRDI";

  if (!apiKey) {
    console.warn(`⚠️ [FAST2SMS] FAST2SMS_API_KEY is not configured in .env. Skipping ${label}.`);
    return { success: false, message: "Fast2SMS API key not configured" };
  }

  // Sanitize 10-digit mobile number
  const cleanPhone = String(phone || "").replace(/\D/g, "").slice(-10);
  if (!cleanPhone || cleanPhone.length !== 10) {
    console.warn(`⚠️ [FAST2SMS] Invalid 10-digit phone number provided for ${label}: "${phone}"`);
    return { success: false, message: "Invalid 10-digit phone number" };
  }

  const payload = {
    route,
    sender_id: senderId,
    message: String(messageId).trim(),
    flash: 0,
    numbers: cleanPhone
  };

  if (variablesValues !== undefined && variablesValues !== null && String(variablesValues).length > 0) {
    payload.variables_values = String(variablesValues).trim();
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10-second timeout

  try {
    console.log(`📲 [FAST2SMS] Dispatching ${label} to +91 ${cleanPhone} [TID: ${messageId}${variablesValues ? `, vars: "${variablesValues}"` : ""}]...`);

    const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
      method: "POST",
      headers: {
        authorization: apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const data = await res.json().catch(() => null);

    if (res.ok && data?.return === true) {
      console.log(`✅ [FAST2SMS] ${label} sent successfully to +91 ${cleanPhone}. Request ID: ${data.request_id || "N/A"}`);
      return {
        success: true,
        requestId: data.request_id,
        message: data.message?.[0] || "SMS sent successfully."
      };
    } else {
      const errMsg = (Array.isArray(data?.message) ? data.message.join(", ") : data?.message) || `Fast2SMS HTTP ${res.status}`;
      console.warn(`⚠️ [FAST2SMS] Failed to send ${label} to +91 ${cleanPhone}:`, errMsg, data);
      return {
        success: false,
        error: errMsg,
        data
      };
    }
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`❌ [FAST2SMS] Network/API Error sending ${label} to +91 ${cleanPhone}:`, err.message);
    return {
      success: false,
      error: err.name === "AbortError" ? "Request timed out after 10s" : err.message
    };
  }
};

/**
 * 1. Template ID 225935: OTP Verification
 * "your BOOK VARDI otp is {#VAR#} . do not share this otp with anyone . -BOOK VARDI"
 */
export const sendFast2SmsOtp = async (phone, otp) => {
  const messageId = process.env.FAST2SMS_MESSAGE_ID || "225935";
  const cleanOtp = String(otp || "").trim();
  if (!cleanOtp) {
    return { success: false, message: "OTP value is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: cleanOtp,
    label: "Security OTP SMS"
  });
};

/**
 * 2. Template ID 228314: Order Placed Successfully (Customer Notification)
 * "DEAR CUSTOMER , YOUR ORDER {#VAR#} HAS BEEN PLACED SUCCESSFULLY . WE WILL NOTIFY YOU ONCE THE SELLER CONFIRMS YOUR ORDER . - BOOK VARDI -BOOK VARDI"
 */
export const sendFast2SmsOrderPlaced = async (phone, orderId) => {
  const messageId = process.env.FAST2SMS_ORDER_PLACED_MESSAGE_ID || "228314";
  const cleanOrderId = String(orderId || "").trim();
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: cleanOrderId,
    label: "Order Placed SMS"
  });
};

/**
 * 3. Template ID 225934: Order Confirmed
 * "Your BOOK VARDI order {#VAR#} has been confirmed successfully -BOOK VARDI"
 */
export const sendFast2SmsOrderConfirmation = async (phone, orderId) => {
  const messageId = process.env.FAST2SMS_ORDER_SUCCESS_MESSAGE_ID || "225934";
  const cleanOrderId = String(orderId || "").trim();
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: cleanOrderId,
    label: "Order Confirmation SMS"
  });
};

/**
 * 3b. Template ID 228930: Order Confirmed with Self Delivery OTP
 * "Your BOOK VARDI order {#VAR#} is confirmed. Your delivery OTP is {#VAR#}. Please share this OTP with the seller only upon receiving your order. -BOOK VARDI -BOOK VARDI"
 */
export const sendFast2SmsOrderConfirmedWithOtp = async (phone, orderId, deliveryOtp) => {
  const messageId = process.env.FAST2SMS_ORDER_CONFIRMED_SELF_DELIVERY_MESSAGE_ID || "228930";
  const cleanOrderId = String(orderId || "").trim();
  const cleanOtp = String(deliveryOtp || "").trim();
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  if (!cleanOtp) {
    return { success: false, message: "Delivery OTP is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: `${cleanOrderId}|${cleanOtp}`,
    label: "Order Confirmed (Self Delivery with OTP) SMS"
  });
};

/**
 * 4. Template ID 228311: New Order Alert to Seller
 * "HELLO SELLER , YOU HAVE RECEIVED A NEW ORDER {#VAR#} ON BOOK VARDI . PLEASE LOGIN TO YOUR SELLER PANEL TO CONFIRM AND PACK THE ORDER . - BOOK VARDI -BOOK VARDI"
 */
export const sendFast2SmsSellerNewOrder = async (phone, orderId) => {
  const messageId = process.env.FAST2SMS_SELLER_NEW_ORDER_MESSAGE_ID || "228311";
  const cleanOrderId = String(orderId || "").trim();
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: cleanOrderId,
    label: "Seller New Order Alert SMS"
  });
};

/**
 * 3. Template ID 225933: Order Shipped with Tracking Link
 * "Your BOOK VARDI order {#VAR#} has been shipped . Track your order here : {#VAR#} -BOOK VARDI"
 */
export const sendFast2SmsOrderShippedWithTracking = async (phone, orderId, trackingUrl) => {
  const messageId = process.env.FAST2SMS_ORDER_SHIPPED_TRACKING_MESSAGE_ID || "225933";
  const cleanOrderId = String(orderId || "").trim();
  const cleanUrl = String(trackingUrl || "").trim() || "https://bookvardi.in";
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: `${cleanOrderId}|${cleanUrl}`,
    label: "Order Shipped (with Tracking Link) SMS"
  });
};

/**
 * 4. Template ID 225932: Order Shipped (Basic)
 * "Your BOOK VARDI order {#VAR#} has been shipped . -BOOK VARDI"
 */
export const sendFast2SmsOrderShipped = async (phone, orderId) => {
  const messageId = process.env.FAST2SMS_ORDER_SHIPPED_MESSAGE_ID || "225932";
  const cleanOrderId = String(orderId || "").trim();
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: cleanOrderId,
    label: "Order Shipped SMS"
  });
};

/**
 * 5. Template ID 225931: Out for Delivery
 * "Your BOOK VARDI {#VAR#} is out for delivery and will reach you soon . -BOOK VARDI"
 */
export const sendFast2SmsOutForDelivery = async (phone, orderId) => {
  const messageId = process.env.FAST2SMS_OUT_FOR_DELIVERY_MESSAGE_ID || "225931";
  const cleanOrderId = String(orderId || "").trim();
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  // Notice template wording: "Your BOOK VARDI {#VAR#} is out for delivery..."
  // Passing "order #BV-XXXX" produces: "Your BOOK VARDI order #BV-XXXX is out for delivery and will reach you soon ."
  const varValue = cleanOrderId.toLowerCase().startsWith("order") ? cleanOrderId : `order #${cleanOrderId}`;
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: varValue,
    label: "Out For Delivery SMS"
  });
};

/**
 * 6. Template ID 225930: Order Delivered Successfully
 * "Your book vardi order {#VAR#} has been delivered successfully . Thank you for shopping with us -BOOK VARDI"
 */
export const sendFast2SmsOrderDelivered = async (phone, orderId) => {
  const messageId = process.env.FAST2SMS_ORDER_DELIVERED_MESSAGE_ID || "225930";
  const cleanOrderId = String(orderId || "").trim();
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: cleanOrderId,
    label: "Order Delivered SMS"
  });
};

/**
 * 7. Template ID 225929: Order Cancelled Successfully
 * "Your book vardi order {#VAR#} has been cancelled successfully . -BOOK VARDI"
 */
export const sendFast2SmsOrderCancelled = async (phone, orderId) => {
  const messageId = process.env.FAST2SMS_ORDER_CANCELLED_MESSAGE_ID || "225929";
  const cleanOrderId = String(orderId || "").trim();
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: cleanOrderId,
    label: "Order Cancelled SMS"
  });
};

/**
 * 8. Template ID 225928: Payment Success
 * "Payment of rs {#VAR#} for your book vardi order {#VAR#} was successful . -BOOK VARDI"
 */
export const sendFast2SmsPaymentSuccess = async (phone, amount, orderId) => {
  const messageId = process.env.FAST2SMS_PAYMENT_SUCCESS_MESSAGE_ID || "225928";
  const cleanOrderId = String(orderId || "").trim();
  const cleanAmount = String(Math.round(Number(amount) || 0));
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: `${cleanAmount}|${cleanOrderId}`,
    label: "Payment Success SMS"
  });
};

/**
 * 9. Template ID 225927: Payment Unsuccessful
 * "Payment of rs {#VAR#} for your book vardi order {#VAR#} was unsuccessful . please try again . -BOOK VARDI"
 */
export const sendFast2SmsPaymentFailed = async (phone, amount, orderId) => {
  const messageId = process.env.FAST2SMS_PAYMENT_FAILED_MESSAGE_ID || "225927";
  const cleanOrderId = String(orderId || "").trim();
  const cleanAmount = String(Math.round(Number(amount) || 0));
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: `${cleanAmount}|${cleanOrderId}`,
    label: "Payment Failed SMS"
  });
};

/**
 * 10. Template ID 225926: Refund Initiated
 * "Refund of rs {#VAR#} for your book vardi order {#VAR#} has been initiated . -BOOK VARDI"
 */
export const sendFast2SmsRefundInitiated = async (phone, amount, orderId) => {
  const messageId = process.env.FAST2SMS_REFUND_INITIATED_MESSAGE_ID || "225926";
  const cleanOrderId = String(orderId || "").trim();
  const cleanAmount = String(Math.round(Number(amount) || 0));
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: `${cleanAmount}|${cleanOrderId}`,
    label: "Refund Initiated SMS"
  });
};

/**
 * 11. Template ID 225925: Back to School Promotional
 * "Back to school shopping is now easier with book vardi . Shop school uniforms and books today : {#VAR#} -BOOK VARDI"
 */
export const sendFast2SmsBackToSchoolPromo = async (phone, storeUrl = "https://bookvardi.in") => {
  const messageId = process.env.FAST2SMS_PROMO_BACK_TO_SCHOOL_MESSAGE_ID || "225925";
  const cleanUrl = String(storeUrl || "https://bookvardi.in").trim();
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: cleanUrl,
    label: "Back to School Promo SMS"
  });
};

/**
 * 12. Template ID 225924: Special Discount Promotional (Static Content)
 * "Book vardi special discount is available on school uniforms and books . shop now and save more . -BOOK VARDI"
 */
export const sendFast2SmsSpecialDiscountPromo = async (phone) => {
  const messageId = process.env.FAST2SMS_PROMO_SPECIAL_DISCOUNT_MESSAGE_ID || "225924";
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: "",
    label: "Special Discount Promo SMS"
  });
};

/**
 * 13. Template ID 228313: Return / Exchange Request Approved
 * "YOUR {#VAR#} REQUEST FOR BOOK VARDI ORDER {#VAR#} HAS BEEN APPROVED . OUR COURIER PARTNER WILL CONTACT YOU SOON FOR PICKUP . - BOOK VARDI -BOOK VARDI"
 */
export const sendFast2SmsReturnApproved = async (phone, requestType = "RETURN", orderId) => {
  const messageId = process.env.FAST2SMS_RETURN_APPROVED_MESSAGE_ID || "228313";
  const cleanOrderId = String(orderId || "").trim();
  const cleanType = String(requestType || "RETURN").toUpperCase().trim();
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: `${cleanType}|${cleanOrderId}`,
    label: "Return/Exchange Approved SMS"
  });
};

/**
 * 14. Template ID 228312: Refund Processed Successfully
 * "REFUND OF RS .{#VAR#} FOR YOUR BOOK VARDI ORDER {#VAR#} HAS BEEN PROCESSED SUCCESSFULLY . REF NO : {#VAR#} . IT WILL CREDIT IN 3-5 BANK DAYS . - BOOK VARDI -BOOK VARDI"
 */
export const sendFast2SmsRefundProcessed = async (phone, amount, orderId, refNo = "") => {
  const messageId = process.env.FAST2SMS_REFUND_PROCESSED_MESSAGE_ID || "228312";
  const cleanOrderId = String(orderId || "").trim();
  const cleanAmount = String(Math.round(Number(amount) || 0));
  const cleanRefNo = String(refNo || `REF-${cleanOrderId}`).trim();
  if (!cleanOrderId) {
    return { success: false, message: "Order ID is required" };
  }
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: `${cleanAmount}|${cleanOrderId}|${cleanRefNo}`,
    label: "Refund Processed SMS"
  });
};

/**
 * 15. Template ID 228310: Bulk School Inquiry Live for Bidding (Static Content)
 * "NEW BULK SCHOOL INQUIRY IS LIVE ON BOOK VARDI FOR BIDDING . LOGIN TO YOUR SELLER PORTAL TO SUMBIT YOUR QUOTATION . - BOOK VARDI -BOOK VARDI"
 */
export const sendFast2SmsBulkSchoolInquiryLive = async (phone) => {
  const messageId = process.env.FAST2SMS_BULK_SCHOOL_INQUIRY_MESSAGE_ID || "228310";
  return dispatchFast2Sms({
    phone,
    messageId,
    variablesValues: "",
    label: "Bulk School Inquiry Live SMS"
  });
};

/**
 * Unified Helper: Automatically dispatch the appropriate DLT SMS based on order status change
 */
export const sendOrderStatusSms = async (order, newStatus, extraData = {}) => {
  if (!order) return null;
  const rawPhone = order.customer?.phone || order.shippingAddress?.phone || order.phone || extraData.phone || "";
  const cleanPhone = String(rawPhone).replace(/\D/g, "").slice(-10);
  if (!cleanPhone || cleanPhone.length !== 10) return null;

  const orderId = order.orderId || order.referenceId || order._id;
  const statusKey = String(newStatus || "").toLowerCase().trim().replace(/[\s-]+/g, "_");

  try {
    switch (statusKey) {
      case "placed":
      case "order_placed":
        return await sendFast2SmsOrderPlaced(cleanPhone, orderId);

      case "confirmed":
      case "order_confirmed":
      case "accepted": {
        const isSelfDelivery = Boolean(
          extraData.deliveryMode === "self_delivery" ||
          extraData.deliveryMode === "self" ||
          order.deliveryMode === "self_delivery" ||
          order.deliveryMode === "self" ||
          order.selfDeliveryDetails?.deliveryPartnerToken ||
          order.selfDeliveryDetails?.deliveryPersonName ||
          (Array.isArray(order.items) && order.items.some(it => it.deliveryType === "self" || it.deliveryType === "self_delivery"))
        );
        const deliveryOtp = String(
          extraData.deliveryOtp ||
          order.deliveryOtp ||
          order.selfDeliveryDetails?.deliveryOtp ||
          (Array.isArray(order.items) && order.items[0]?.deliveryOtp) ||
          ""
        ).trim();

        if (isSelfDelivery && deliveryOtp) {
          return await sendFast2SmsOrderConfirmedWithOtp(cleanPhone, orderId, deliveryOtp);
        }
        return await sendFast2SmsOrderConfirmation(cleanPhone, orderId);
      }

      case "shipped":
      case "dispatched": {
        const trackingLink = extraData.trackingUrl || order.trackingUrl || order.selfDeliveryDetails?.trackingUrl || "";
        if (trackingLink && trackingLink.startsWith("http")) {
          return await sendFast2SmsOrderShippedWithTracking(cleanPhone, orderId, trackingLink);
        }
        return await sendFast2SmsOrderShipped(cleanPhone, orderId);
      }

      case "out_for_delivery":
        return await sendFast2SmsOutForDelivery(cleanPhone, orderId);

      case "delivered":
        return await sendFast2SmsOrderDelivered(cleanPhone, orderId);

      case "cancelled":
      case "canceled":
        return await sendFast2SmsOrderCancelled(cleanPhone, orderId);

      case "return_approved":
      case "exchange_approved":
      case "approved": {
        const reqType = (extraData.type || extraData.requestType || order.returnRequest?.type || "RETURN").toUpperCase();
        return await sendFast2SmsReturnApproved(cleanPhone, reqType, orderId);
      }

      case "refund_processed":
      case "refund_completed":
      case "refunded": {
        const refundAmt = Number(extraData.refundAmount ?? order.refundDetails?.amount ?? order.totalAmount ?? 0);
        const refNo = extraData.refundTxnId || extraData.refNo || order.refundDetails?.refundTxnId || `REF-${orderId}`;
        return await sendFast2SmsRefundProcessed(cleanPhone, refundAmt, orderId, refNo);
      }

      case "refund_initiated": {
        const refundAmt = Number(extraData.refundAmount ?? order.refundDetails?.amount ?? order.totalAmount ?? 0);
        return await sendFast2SmsRefundInitiated(cleanPhone, refundAmt, orderId);
      }

      default:
        return null;
    }
  } catch (err) {
    console.warn(`⚠️ [FAST2SMS] Status SMS dispatch error for Order #${orderId}:`, err.message);
    return null;
  }
};

export default {
  sendFast2SmsOtp,
  sendFast2SmsOrderPlaced,
  sendFast2SmsOrderConfirmation,
  sendFast2SmsOrderConfirmedWithOtp,
  sendFast2SmsSellerNewOrder,
  sendFast2SmsOrderShippedWithTracking,
  sendFast2SmsOrderShipped,
  sendFast2SmsOutForDelivery,
  sendFast2SmsOrderDelivered,
  sendFast2SmsOrderCancelled,
  sendFast2SmsPaymentSuccess,
  sendFast2SmsPaymentFailed,
  sendFast2SmsRefundInitiated,
  sendFast2SmsReturnApproved,
  sendFast2SmsRefundProcessed,
  sendFast2SmsBulkSchoolInquiryLive,
  sendFast2SmsBackToSchoolPromo,
  sendFast2SmsSpecialDiscountPromo,
  sendOrderStatusSms
};
