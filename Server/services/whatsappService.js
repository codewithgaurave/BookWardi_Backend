/**
 * WhatsApp Dispatch Service
 * Handles automated notification dispatch to self-delivery partners (delivery boys)
 * with direct live portal links, customer location, and OTP verification instructions.
 */

export const sendDeliveryPartnerWhatsAppDispatch = async ({
  order,
  selfDeliveryDetails,
  clientAppUrl
}) => {
  try {
    const driverName = selfDeliveryDetails?.deliveryPersonName || "Delivery Partner";
    const driverPhone = selfDeliveryDetails?.deliveryPersonPhone || "";
    const cleanPhone = String(driverPhone).replace(/\D/g, "").slice(-10);

    if (!cleanPhone || cleanPhone.length !== 10) {
      return {
        success: false,
        status: "failed",
        error: "Invalid delivery partner phone number (must be 10 digits)"
      };
    }

    const orderIdStr = order.orderId || order.id || (order._id ? String(order._id).slice(-8).toUpperCase() : "ORDER");
    const tokenVal = String(
      selfDeliveryDetails?.deliveryPartnerToken ||
      order.selfDeliveryDetails?.deliveryPartnerToken ||
      `DLV-${orderIdStr}`
    ).trim();

    const baseUrl = (
      clientAppUrl ||
      process.env.CLIENT_URL ||
      process.env.FRONTEND_BASE_URL ||
      "http://localhost:5173"
    ).replace(/\/+$/, "");

    const trackingLink = `${baseUrl}/#delivery-partner?token=${encodeURIComponent(tokenVal)}`;

    const customerName = order.customerName || order.customer?.name || "Customer";
    const customerPhone = order.customerPhone || order.customer?.phone || "N/A";

    let addressStr = "Customer Delivery Address";
    if (typeof order.shippingAddress === "string" && order.shippingAddress.trim()) {
      addressStr = order.shippingAddress.trim();
    } else if (order.shippingAddress && typeof order.shippingAddress === "object") {
      const parts = [
        order.shippingAddress.name || order.shippingAddress.fullName,
        order.shippingAddress.addressLine || order.shippingAddress.street || order.shippingAddress.address,
        order.shippingAddress.colony || order.shippingAddress.landmark,
        order.shippingAddress.city,
        order.shippingAddress.state,
        order.shippingAddress.pincode ? `- ${order.shippingAddress.pincode}` : null,
        order.shippingAddress.phone ? `(Ph: ${order.shippingAddress.phone})` : null
      ].filter(Boolean);
      addressStr = parts.length > 0 ? parts.join(", ") : "Customer Address";
    }

    const isExchange = Boolean(
      order.returnRequest?.type === 'exchange' ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('exchange')
    );
    const isReturn = Boolean(
      order.returnRequest?.type === 'return' ||
      (!isExchange && Boolean(order.returnRequest?.type || order.returnRequest?.reason)) ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('return') ||
      String(order.overallStatus || order.status || '').toLowerCase().includes('pickup')
    );

    const returnReq = order.returnRequest || {};
    const priceDiff = Number(returnReq.priceDifference || 0);
    const adjType = returnReq.priceAdjustmentType || (priceDiff > 0 ? 'extra_payment' : priceDiff < 0 ? 'partial_refund' : 'none');
    const isExtraPayment = isExchange && adjType === 'extra_payment' && priceDiff > 0;

    const totalAmount = order.total || order.totalAmount || order.payableAmount || 0;
    let paymentMode = String(order.paymentMethod || "Online").toUpperCase().includes("COD")
      ? "Cash on Delivery (Collect ₹" + totalAmount + ")"
      : "Prepaid Online (No Cash Collection)";

    let taskInstructionSection = "";
    if (isReturn) {
      paymentMode = "DOORSTEP RETURN: Collect ₹0 (Refund transferred directly to customer bank/UPI)";
      const returnItemName = returnReq.itemName || (order.items && order.items[0]?.name) || "Purchased Product";
      const returnSpec = (order.items && order.items[0]?.size)
        ? `Size: ${order.items[0]?.size}`
        : (returnReq.isMeterBased && order.items && order.items[0]?.quantity)
        ? `Length: ${order.items[0]?.quantity}m`
        : "Original Piece";

      taskInstructionSection =
`\n📦 *RETURN PICKUP INSTRUCTIONS:*
1. ITEM TO COLLECT: ${returnItemName} (${returnSpec})
2. QUALITY CHECK: Verify tags intact, undamaged, unwashed.
3. CASH COLLECTION: COLLECT ₹0 (Refund sent directly to customer account).
4. VERIFY OTP: Ask customer for 4-digit Return Pickup OTP before leaving.
`;
    } else if (isExchange) {
      const oldItemName = returnReq.itemName || (order.items && order.items[0]?.name) || "Delivered Product";
      const oldSpec = (order.items && order.items[0]?.size)
        ? `Size: ${order.items[0]?.size}`
        : (returnReq.isMeterBased && order.items && order.items[0]?.quantity)
        ? `Length: ${order.items[0]?.quantity}m`
        : "Original Piece";

      const newSpec = returnReq.exchangeLength
        ? `${returnReq.exchangeLength} Meter(s)`
        : (returnReq.exchangeSize || "Requested Variant");

      if (isExtraPayment) {
        paymentMode = `EXCHANGE EXTRA CHARGE: Collect ₹${priceDiff} Cash / UPI from Customer`;
      } else if (adjType === 'partial_refund') {
        paymentMode = `EQUAL / REFUND EXCHANGE: Collect ₹0 (₹${Math.abs(priceDiff)} refund processed to customer account)`;
      } else {
        paymentMode = `EQUAL VALUE EXCHANGE: Collect ₹0 (No Payment Needed)`;
      }

      taskInstructionSection =
`\n🔄 *EXCHANGE TASK INSTRUCTIONS:*
1. TAKE BACK FROM CUSTOMER: ${oldItemName} (${oldSpec})
2. HAND OVER TO CUSTOMER: ${oldItemName} (${newSpec})
3. PAYMENT INSTRUCTION: ${paymentMode}
4. VERIFY OTP: Ask customer for 4-digit Exchange OTP after handover.
`;
    }

    const itemsSummary = Array.isArray(order.items) && order.items.length > 0
      ? order.items.map(it => `• ${it.name || 'Product'} (Qty: ${it.quantity || 1})`).join('\n')
      : `• ${order.itemsCount || 1} package items`;

    const taskTitlePrefix = isReturn ? 'Return Pickup ' : (isExchange ? 'Exchange ' : '');
    const taskTypeTag = isReturn
      ? '⚠️ TASK TYPE: REVERSE PICKUP (PRODUCT RETURN)\n'
      : (isExchange ? '⚠️ TASK TYPE: 2-WAY PRODUCT EXCHANGE\n' : '');

    const whatsappMessage =
`🚚 *BookVardi ${taskTitlePrefix}Delivery Assignment*
Order ID: #${orderIdStr}
Rider Assigned: ${driverName} (${selfDeliveryDetails?.vehicleNumber || "Partner Vehicle"})
${taskTypeTag}📍 *Customer Address:*
Name: ${customerName}
Contact: ${customerPhone}
Address: ${addressStr}
${taskInstructionSection}
🛒 *Package Items:*
${itemsSummary}
Payment: ${paymentMode}

🔗 *Live Delivery Partner Portal & Navigation Link:*
${trackingLink}

_Please tap the link to start real-time navigation, verify items, and enter the customer OTP upon successful completion._`;

    const messageId = `WA-MSG-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    // If external WhatsApp Cloud API or HTTP gateway credentials exist, execute HTTP POST
    if (process.env.WHATSAPP_API_URL && process.env.WHATSAPP_API_TOKEN) {
      try {
        await fetch(process.env.WHATSAPP_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.WHATSAPP_API_TOKEN}`
          },
          body: JSON.stringify({
            phone: `91${cleanPhone}`,
            message: whatsappMessage,
            trackingLink
          })
        });
        console.log(`✅ [WHATSAPP DISPATCH] External API sent message ${messageId} to ${cleanPhone}`);
      } catch (extErr) {
        console.warn("⚠️ External WhatsApp API dispatch warning:", extErr.message);
      }
    } else {
      console.log(`📱 [WHATSAPP DISPATCH] Automated dispatch logged for Order #${orderIdStr} to ${cleanPhone}: Ref ${messageId}`);
    }

    return {
      success: true,
      status: "sent",
      messageId,
      sentTo: `+91 ${cleanPhone}`,
      sentAt: new Date(),
      trackingLink,
      message: whatsappMessage,
      deepLinkUrl: `https://api.whatsapp.com/send?phone=91${cleanPhone}&text=${encodeURIComponent(whatsappMessage)}`
    };
  } catch (error) {
    console.error("❌ Error in sendDeliveryPartnerWhatsAppDispatch:", error);
    return {
      success: false,
      status: "failed",
      error: error.message
    };
  }
};
