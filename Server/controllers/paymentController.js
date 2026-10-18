import Razorpay from "razorpay";
import crypto from "crypto";
import mongoose from "mongoose";
import Payment from "../models/Payment.js";
import Order from "../models/Order.js";
import { broadcastRealtimeEvent } from "../services/realtimeService.js";
import { 
  sendFast2SmsOrderConfirmation, 
  sendFast2SmsPaymentSuccess, 
  sendFast2SmsPaymentFailed 
} from "../services/smsService.js";

// Initialize Razorpay instance
const getRazorpayInstance = () => {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    console.warn("⚠️ Razorpay credentials not configured in environment variables.");
  }

  return new Razorpay({
    key_id: key_id || "dummy_key_id",
    key_secret: key_secret || "dummy_key_secret"
  });
};

// 1. Create Razorpay Order (POST /api/payments/create-order)
export const createPayment = async (req, res) => {
  try {
    const orderId = req.body.orderId || req.body.order_id;
    let amount = Number(req.body.amount);
    const { currency = "INR", notes = {}, customer } = req.body;

    let targetOrder = null;
    if (orderId) {
      if (mongoose.Types.ObjectId.isValid(orderId)) {
        targetOrder = await Order.findById(orderId);
      }
      if (!targetOrder) {
        targetOrder = await Order.findOne({ $or: [{ orderId }, { id: orderId }] });
      }

      // If order exists in DB, ensure payment amount matches actual server-verified order payable amount
      if (targetOrder) {
        const truePayable = Number(targetOrder.payableAmount ?? targetOrder.totalAmount ?? targetOrder.total ?? 0);
        if (truePayable > 0) {
          amount = truePayable;
        }
      }
    }

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ message: "Valid positive amount in INR is required" });
    }

    const key_id = process.env.RAZORPAY_KEY_ID || "";
    const receipt = `rcpt_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

    let razorpayOrder;
    try {
      const razorpay = getRazorpayInstance();
      // Razorpay expects amount in paise (1 INR = 100 paise)
      const options = {
        amount: Math.round(Number(amount) * 100),
        currency: currency.toUpperCase(),
        receipt,
        notes: {
          ...notes,
          orderId: orderId || "",
          userId: req.user ? req.user.id : ""
        }
      };
      razorpayOrder = await razorpay.orders.create(options);
    } catch (rzpErr) {
      console.warn("Razorpay API order creation error, falling back to simulated order:", rzpErr.message);
      razorpayOrder = {
        id: `order_${Date.now().toString(36)}`,
        entity: "order",
        amount: Math.round(Number(amount) * 100),
        currency: currency.toUpperCase(),
        receipt,
        status: "created",
        isSimulated: true
      };
    }

    // Save payment record in DB
    const payment = new Payment({
      orderId: targetOrder?._id || orderId || null,
      userId: req.user ? req.user.id : null,
      customer: customer || {
        name: req.user ? req.user.name : "Customer",
        phone: req.user ? req.user.phone : "",
        email: req.user ? req.user.email : ""
      },
      amount: Number(amount),
      currency: currency.toUpperCase(),
      paymentMethod: "razorpay",
      razorpayOrderId: razorpayOrder.id,
      status: "created",
      receipt,
      notes
    });
    await payment.save();

    // Link Razorpay Order ID to Order if targetOrder exists
    if (targetOrder) {
      targetOrder.razorpayOrderId = razorpayOrder.id;
      await targetOrder.save();
    }

    res.status(201).json({
      success: true,
      message: "Razorpay order created successfully",
      key: key_id,
      amount: razorpayOrder.amount, // in paise for Razorpay Checkout
      currency: razorpayOrder.currency,
      razorpayOrderId: razorpayOrder.id,
      receipt: razorpayOrder.receipt,
      isSimulated: Boolean(razorpayOrder.isSimulated),
      paymentDbId: payment._id
    });
  } catch (error) {
    console.error("Create payment error:", error);
    res.status(500).json({ success: false, message: "Failed to initialize payment", error: error.message });
  }
};

// 2. Verify Razorpay Payment Signature (POST /api/payments/verify)
export const verifyPayment = async (req, res) => {
  try {
    const razorpay_order_id = req.body.razorpay_order_id || req.body.razorpayOrderId;
    const razorpay_payment_id = req.body.razorpay_payment_id || req.body.razorpayPaymentId;
    const razorpay_signature = req.body.razorpay_signature || req.body.razorpaySignature;
    const orderId = req.body.orderId || req.body.order_id;
    const paymentId = req.body.paymentId || req.body.paymentDbId;

    if (!razorpay_order_id || !razorpay_payment_id) {
      return res.status(400).json({
        success: false,
        message: "razorpay_order_id and razorpay_payment_id are required"
      });
    }

    // 1. Check if the payment record exists in the database
    const payment = await Payment.findOne({
      $or: [
        { razorpayOrderId: razorpay_order_id },
        ...(paymentId ? [{ _id: paymentId }] : [])
      ]
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: `Payment record not found for Razorpay Order ID '${razorpay_order_id}' in database.`
      });
    }

    if (payment.status === "captured") {
      return res.status(400).json({
        success: false,
        message: "This payment has already been verified and captured."
      });
    }

    // 2. Strict Cryptographic HMAC SHA256 Signature Verification
    const key_secret = process.env.RAZORPAY_KEY_SECRET || "SMtig3JkAqFP7nIMpODyyuAL";

    if (!razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "razorpay_signature is required for payment verification."
      });
    }

    const generatedSignature = crypto
      .createHmac("sha256", key_secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      const customerPhone = payment.customer?.phone;
      const displayId = orderId || payment.orderId || razorpay_order_id;
      if (customerPhone && displayId) {
        sendFast2SmsPaymentFailed(customerPhone, payment.amount, displayId).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: "Invalid Razorpay payment signature. Verification failed."
      });
    }

    // 3. Double-check directly with Razorpay API (Ensure payment is genuine on Razorpay)
    const razorpay = getRazorpayInstance();
    try {
      const rzpPayment = await razorpay.payments.fetch(razorpay_payment_id);
      if (rzpPayment) {
        if (rzpPayment.order_id && rzpPayment.order_id !== razorpay_order_id) {
          return res.status(400).json({
            success: false,
            message: "Payment ID does not match the Razorpay Order ID on Razorpay servers."
          });
        }
        if (rzpPayment.status !== "captured" && rzpPayment.status !== "authorized") {
          return res.status(400).json({
            success: false,
            message: `Payment status on Razorpay is '${rzpPayment.status}'. Cannot confirm order.`
          });
        }
      }
    } catch (rzpFetchErr) {
      return res.status(400).json({
        success: false,
        message: `Payment ID '${razorpay_payment_id}' verification failed with Razorpay: ${rzpFetchErr.message}`
      });
    }

    // 4. Update payment record in database
    payment.razorpayPaymentId = razorpay_payment_id;
    payment.razorpaySignature = razorpay_signature;
    payment.status = "captured";
    await payment.save();

    // 5. Update associated main Order and any sub-orders to paid and processing
    const targetOrderId = orderId || payment.orderId;
    let updatedOrder = null;

    if (targetOrderId || razorpay_order_id) {
      const isMongoId = targetOrderId && mongoose.Types.ObjectId.isValid(targetOrderId);
      const orderQuery = [
        ...(isMongoId ? [{ _id: targetOrderId }] : []),
        ...(targetOrderId ? [{ orderId: targetOrderId }, { masterOrderId: targetOrderId }, { id: targetOrderId }] : []),
        ...(razorpay_order_id ? [{ razorpayOrderId: razorpay_order_id }] : [])
      ];

      await Order.updateMany(
        { $or: orderQuery },
        {
          $set: {
            paymentStatus: "paid",
            overallStatus: "processing",
            razorpayPaymentId: razorpay_payment_id,
            razorpayOrderId: razorpay_order_id
          }
        }
      );

      updatedOrder = await Order.findOne({ $or: orderQuery });

      try {
        if (updatedOrder) {
          broadcastRealtimeEvent({
            type: "ORDER_UPDATED",
            orderId: updatedOrder.orderId,
            masterOrderId: updatedOrder.masterOrderId,
            sellerId: updatedOrder.sellerId,
            total: updatedOrder.totalAmount,
            status: "processing",
            paymentStatus: "paid"
          });

          const targetPhone = updatedOrder.customer?.phone || updatedOrder.customerPhone || updatedOrder.phone || payment.customer?.phone;
          const displayOrderId = updatedOrder.orderId || updatedOrder.id;
          const paidAmt = updatedOrder.totalAmount || payment.amount || 0;

          if (targetPhone && displayOrderId) {
            // Template 225928: Payment of rs {#VAR#} for your book vardi order {#VAR#} was successful . -BOOK VARDI
            sendFast2SmsPaymentSuccess(targetPhone, paidAmt, displayOrderId).catch(err => {
              console.warn("⚠️ [FAST2SMS] Payment success SMS error:", err.message);
            });

            // Template 225934: Your BOOK VARDI order {#VAR#} has been confirmed successfully -BOOK VARDI
            if (!updatedOrder.orderConfirmationSmsSent) {
              sendFast2SmsOrderConfirmation(targetPhone, displayOrderId)
                .then(async (smsRes) => {
                  if (smsRes?.success) {
                    console.log(`📲 [FAST2SMS] Order confirmation SMS sent to +91 ${targetPhone} for Order ${displayOrderId}`);
                    await Order.updateOne(
                      { _id: updatedOrder._id },
                      {
                        $set: {
                          orderConfirmationSmsSent: true,
                          orderConfirmationSmsSentAt: new Date(),
                          orderConfirmationSmsRequestId: smsRes.requestId
                        }
                      }
                    ).catch(() => {});
                  }
                })
                .catch((smsErr) => {
                  console.warn("⚠️ [FAST2SMS] Order confirmation SMS dispatch error:", smsErr.message);
                });
            }
          }
        }
      } catch (rtErr) {}
    }

    const sanitizedOrder = updatedOrder?.toObject ? updatedOrder.toObject() : (updatedOrder ? { ...updatedOrder } : null);
    if (sanitizedOrder) {
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
    }

    res.json({
      success: true,
      message: "Payment verified successfully. Order confirmed!",
      payment,
      order: sanitizedOrder
    });
  } catch (error) {
    console.error("Verify payment error:", error);
    res.status(500).json({ success: false, message: "Payment verification failed", error: error.message });
  }
};

// 3. Get All Payments (Admin) - Paginated
export const getPayments = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      Payment.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Payment.countDocuments()
    ]);

    // Backwards compatibility: support both paginated array and pagination metadata
    if (req.query.paginated === "true") {
      res.json({
        payments,
        total,
        page,
        totalPages: Math.ceil(total / limit)
      });
    } else {
      res.json(payments);
    }
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch payments", error: error.message });
  }
};

// 4. Delete Payment
export const deletePayment = async (req, res) => {
  try {
    await Payment.findByIdAndDelete(req.params.id);
    res.json({ message: "Payment deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 5. Payment Stats (Admin Dashboard)
export const getPaymentStats = async (req, res) => {
  try {
    const totalPayments = await Payment.aggregate([
      { $match: { status: "captured" } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    res.json({ totalPayments: totalPayments[0]?.total || 0 });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};