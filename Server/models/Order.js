import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema({
  id: { type: mongoose.Schema.Types.Mixed },
  productId: {
    type: mongoose.Schema.Types.Mixed
  },
  sellerId: {
    type: mongoose.Schema.Types.Mixed
  },
  sellerName: { type: String, default: "" },
  storeName: { type: String, default: "" },
  sellerPhone: { type: String, default: "" },
  sellerEmail: { type: String, default: "" },
  sellerAddress: { type: String, default: "" },
  sellerCity: { type: String, default: "" },
  sellerDetails: {
    sellerId: { type: mongoose.Schema.Types.Mixed },
    storeName: { type: String, default: "" },
    sellerName: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    address: { type: String, default: "" },
    city: { type: String, default: "" }
  },
  gst: { type: Number, default: 5 },
  gstPercent: { type: Number, default: 5 },
  gstPercentage: { type: Number, default: 5 },
  gstRate: { type: Number, default: 5 },
  commissionRate: { type: Number, default: 5 },
  commissionPercentage: { type: Number, default: 5 },
  sellerCommissionRate: { type: Number, default: 5 },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  image: {
    type: mongoose.Schema.Types.Mixed,
    default: "",
    set: function (v) {
      if (Array.isArray(v)) return v[0] || "";
      if (typeof v === "object" && v !== null) return v.url || v.dataUrl || v.src || "";
      return typeof v === "string" ? v : String(v || "");
    }
  },
  category: { type: String, default: "Stationery" },
  size: {
    type: mongoose.Schema.Types.Mixed,
    default: "",
    set: function (v) {
      if (typeof v === "object" && v !== null) return v.size || v.name || v.label || "";
      return typeof v === "string" ? v : String(v || "");
    }
  },
  age: { type: String, default: "" },
  color: {
    type: mongoose.Schema.Types.Mixed,
    default: "",
    set: function (v) {
      if (typeof v === "object" && v !== null) return v.color || v.name || "";
      return typeof v === "string" ? v : String(v || "");
    }
  },
  discountPercentage: { type: Number, default: 0 },
  offerDiscount: { type: Number, default: 0 },
  couponCode: { type: String, default: "" },
  appliedCoupon: { type: String, default: "" },
  finalPrice: { type: Number, default: function () { return this.price; } },
  quantity: { type: Number, required: true, min: 0.01, default: 1 },
  total: { type: Number, default: function () { return Math.round(((this.price || 0) * (this.quantity || 1)) * 100) / 100; } },
  isReturnable: { type: Boolean, default: true },
  isRefundable: { type: Boolean, default: true },
  isExchangeable: { type: Boolean, default: true },
  unit: { type: String, default: "piece" },
  isMeterBased: { type: Boolean, default: false },
  minMeter: { type: Number, default: 0.5 },
  meterStep: { type: Number, default: 0.5 },
  subCategory: { type: String, default: "" },
  returnWindowDays: { type: Number, default: 7 },
  returnPolicy: { type: String, default: "" },
  deliveryType: {
    type: String,
    default: "pending_choice"
  },
  deliveryRadiusKm: {
    type: Number,
    default: 0
  },
  distanceFromSellerKm: {
    type: Number,
    default: null
  },
  thirdPartyDetails: {
    courierName: { type: String, default: "" },
    trackingNumber: { type: String, default: "" },
    trackingUrl: { type: String, default: "" },
    estimatedDeliveryDate: { type: Date, default: null }
  },
  selfDeliveryDetails: {
    deliveryPersonName: { type: String, default: "" },
    deliveryPersonPhone: { type: String, default: "" },
    vehicleNumber: { type: String, default: "" },
    deliveryOtp: { type: String, default: "" },
    deliveryPartnerToken: { type: String, default: "" },
    trackingUrl: { type: String, default: "" },
    driverLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      updatedAt: { type: Date, default: null }
    },
    otpLastSentAt: { type: Date, default: null },
    otpExpiresAt: { type: Date, default: null },
    whatsappStatus: { type: String, default: "" },
    whatsappSentAt: { type: Date, default: null },
    whatsappMessageId: { type: String, default: "" },
    whatsappSentTo: { type: String, default: "" }
  },
  status: {
    type: String,
    default: "pending"
  },
  commissionRate: { type: Number, default: 10 },
  commissionAmount: { type: Number, default: 0 },
  gstOnCommissionRate: { type: Number, default: 18 },
  gstOnCommissionAmount: { type: Number, default: 0 },
  tdsRate: { type: Number, default: 0.1 },
  tdsAmount: { type: Number, default: 0 },
  gstTcsRate: { type: Number, default: 0.5 },
  gstTcsAmount: { type: Number, default: 0 },
  deliveryChargeAmount: { type: Number, default: 0 },
  gstOnDeliveryRate: { type: Number, default: 5 },
  gstOnDeliveryAmount: { type: Number, default: 0 },
  totalDeliveryDeduction: { type: Number, default: 0 },
  deliveryChargeBorneBy: { type: String, default: "admin" },
  totalDeductions: { type: Number, default: 0 },
  netSettlementAmount: { type: Number, default: 0 },
  settlementStatus: { 
    type: String, 
    enum: [
      "pending", 
      "pending_return_window", 
      "in_return_window", 
      "pending_exchange_buffer", 
      "in_exchange_buffer", 
      "credited", 
      "settled", 
      "matured",
      "refunded", 
      "on_hold"
    ], 
    default: "pending" 
  },
  settlementRule: { type: String, default: "ONLINE_SELF_DELIVERY" },
  settlementDueDate: { type: Date, default: null },
  settlementMaturedAt: { type: Date, default: null },
  isSettlementMatured: { type: Boolean, default: false }
});

const timelineEventSchema = new mongoose.Schema({
  status: {
    type: String,
    required: true
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ""
  },
  location: {
    type: String,
    default: ""
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  updatedBy: {
    type: String,
    default: "System"
  }
});

export const generateProductOrderId = () => {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let prefix = "";
  for (let i = 0; i < 3; i++) {
    prefix += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  const num = Math.floor(100000 + Math.random() * 900000);
  return `${prefix}${num}`;
};

const orderSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      default: generateProductOrderId
    },
    id: { type: String },
    invoiceNumber: { type: String, default: "" },
    sellerInvoiceNo: { type: String, default: "" },
    sellerSequence: { type: Number, default: 0 },
    creditNoteNumber: { type: String, default: "" },
    sellerCreditNoteNo: { type: String, default: "" },
    sellerCreditNoteSequence: { type: Number, default: 0 },
    masterOrderId: { type: String, default: "" },
    isSubOrder: { type: Boolean, default: false },
    subOrderIndex: { type: Number, default: 1 },
    subOrdersCount: { type: Number, default: 1 },
    sellerId: { type: mongoose.Schema.Types.Mixed },
    sellerStoreName: { type: String, default: "" },
    userId: {
      type: mongoose.Schema.Types.Mixed,
      ref: "User"
    },
    customer: {
      name: { type: String, default: "" },
      email: { type: String, default: "" },
      phone: { type: String, default: "" }
    },
    items: [orderItemSchema],
    subtotal: { type: Number, default: 0 },
    shippingCost: { type: Number, default: 0 },
    shippingFee: { type: Number, default: 0 },
    freeDeliveryThreshold: { type: Number, default: 401 },
    codFee: { type: Number, default: 0 },
    appliedCodFee: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    couponCode: { type: String, default: "" },
    appliedCoupon: { type: String, default: "" },
    couponDetails: { type: mongoose.Schema.Types.Mixed, default: null },
    commissionRate: { type: Number, default: 10 },
    commissionPercentage: { type: Number, default: 10 },
    sellerCommissionRate: { type: Number, default: 10 },
    totalAmount: {
      type: Number,
      required: true,
      min: 0
    },
    total: { type: Number, default: 0 },
    date: { type: String, default: "" },
    shippingAddress: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    paymentMethod: {
      type: String,
      default: "UPI"
    },
    paymentStatus: {
      type: String,
      default: "paid"
    },
    razorpayOrderId: {
      type: String,
      default: ""
    },
    razorpayPaymentId: {
      type: String,
      default: ""
    },
    overallStatus: {
      type: String,
      default: "Pending"
    },
    deliveryMode: {
      type: String,
      enum: ["third_party", "self_delivery", "pending_choice", "standard", "express", ""],
      default: "pending_choice"
    },
    courierName: { type: String, default: "" },
    carrier: { type: String, default: "" },
    trackingNumber: { type: String, default: "" },
    trackingUrl: { type: String, default: "" },
    sellerDetails: {
      sellerId: { type: mongoose.Schema.Types.Mixed },
      storeName: { type: String, default: "" },
      sellerName: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      address: { type: String, default: "" },
      city: { type: String, default: "" }
    },
    selfDeliveryDetails: {
      deliveryPersonName: { type: String, default: "" },
      deliveryPersonPhone: { type: String, default: "" },
      vehicleNumber: { type: String, default: "" },
      deliveryOtp: { type: String, default: "" },
      deliveryPartnerToken: { type: String, default: "" },
      trackingUrl: { type: String, default: "" },
      driverLocation: {
        lat: { type: Number, default: null },
        lng: { type: Number, default: null },
        updatedAt: { type: Date, default: null }
      },
      otpLastSentAt: { type: Date, default: null },
      otpExpiresAt: { type: Date, default: null },
      whatsappStatus: { type: String, default: "" },
      whatsappSentAt: { type: Date, default: null },
      whatsappMessageId: { type: String, default: "" },
      whatsappSentTo: { type: String, default: "" }
    },
    deliveryOtp: {
      type: String,
      default: ""
    },
    orderPlacedSmsSent: {
      type: Boolean,
      default: false
    },
    orderPlacedSmsSentAt: {
      type: Date,
      default: null
    },
    orderPlacedSmsRequestId: {
      type: String,
      default: ""
    },
    orderConfirmationSmsSent: {
      type: Boolean,
      default: false
    },
    orderConfirmationSmsSentAt: {
      type: Date,
      default: null
    },
    orderConfirmationSmsRequestId: {
      type: String,
      default: ""
    },
    estimatedDeliveryDate: {
      type: Date,
      default: () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    },
    estimatedDelivery: { type: String, default: "3-5 Business Days" },
    cancellationReason: {
      type: String,
      default: ""
    },
    cancelledBy: {
      type: String,
      default: ""
    },
    refundStatus: {
      type: String,
      default: ""
    },
    refundDetails: {
      method: { type: String, enum: ["UPI", "BANK", ""], default: "" },
      upiId: { type: String, default: "" },
      bankName: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      ifscCode: { type: String, default: "" },
      accountHolderName: { type: String, default: "" },
      submittedAt: { type: Date, default: null }
    },
    cancelledAt: {
      type: Date,
      default: null
    },
    deliveredAt: {
      type: Date,
      default: null
    },
    settlementDueDate: {
      type: Date,
      default: null
    },
    settlementMaturedAt: {
      type: Date,
      default: null
    },
    settlementStatus: {
      type: String,
      enum: ["pending", "pending_return_window", "in_return_window", "credited", "settled", "refunded", "on_hold"],
      default: "pending"
    },
    codCollectedAt: {
      type: Date,
      default: null
    },
    codCollectedBy: {
      type: String,
      default: ""
    },
    returnRequest: {
      type: {
        type: String,
        enum: ["return", "exchange", null],
        default: null
      },
      reason: { type: String, default: "" },
      comment: { type: String, default: "" },
      exchangeSize: { type: String, default: "" },
      exchangeLength: { type: Number, default: null },
      isMeterBased: { type: Boolean, default: false },
      exchangeColor: { type: String, default: "" },
      priceDifference: { type: Number, default: 0 },
      priceAdjustmentType: { type: String, enum: ["extra_payment", "partial_refund", "none", ""], default: "none" },
      originalItemPrice: { type: Number, default: 0 },
      replacementItemPrice: { type: Number, default: 0 },
      refundMethod: { type: String, default: "Original Payment Method" },
      refundDetails: {
        method: { type: String, enum: ["UPI", "BANK", ""], default: "" },
        upiId: { type: String, default: "" },
        bankName: { type: String, default: "" },
        accountNumber: { type: String, default: "" },
        ifscCode: { type: String, default: "" },
        accountHolderName: { type: String, default: "" }
      },
      requestedAt: { type: Date, default: null },
      updatedAt: { type: Date, default: null },
      pickupDate: { type: Date, default: null },
      rejectionReason: { type: String, default: "" },
      refundTxnId: { type: String, default: "" },
      exchangeAwb: { type: String, default: "" },
      exchangeCourier: { type: String, default: "" },
      status: {
        type: String,
        enum: [
          "no_request",
          "requested",
          "return_requested",
          "exchange_requested",
          "approved",
          "return_approved",
          "exchange_approved",
          "rejected",
          "return_rejected",
          "exchange_rejected",
          "pickup_scheduled",
          "product_received",
          "product_return_received",
          "refund_initiated",
          "refund_processed",
          "refund_completed",
          "refunded",
          "exchange_dispatched",
          "exchanged"
        ],
        default: "no_request"
      },
      returnEligibleUntil: { type: Date, default: null }
    },
    timeline: [timelineEventSchema],
    address: { type: String },
    product: { type: String },
    quantity: { type: Number },
    amount: { type: Number },
    status: { type: String, default: "Pending" },
    deliveryBoy: { type: String }
  },
  {
    timestamps: true,
    strict: false
  }
);

// Pre-save hook to initialize first timeline entry and unify delivery OTP
orderSchema.pre("save", function (next) {
  const existingOtpCandidate = String(
    this.deliveryOtp ||
    this.selfDeliveryDetails?.deliveryOtp ||
    (this.items?.[0]?.selfDeliveryDetails?.deliveryOtp) ||
    (this.items?.[0]?.deliveryOtp) ||
    ""
  ).trim();

  const hasValidOtp = /^\d{4}$/.test(existingOtpCandidate);
  const statusStr = String(this.overallStatus || this.status || "").toLowerCase().trim();
  const isOrderTerminal = statusStr === "delivered" || statusStr === "exchanged" || statusStr === "product_received";
  const isReturnOrExchange = Boolean(
    this.returnRequest?.type ||
    statusStr.includes("return") ||
    statusStr.includes("exchange") ||
    statusStr.includes("pickup")
  );

  const isSelfDeliveryMode = this.deliveryMode === "self_delivery" ||
    Boolean(this.selfDeliveryDetails?.deliveryPersonName || this.selfDeliveryDetails?.deliveryPartnerToken) ||
    hasValidOtp ||
    isReturnOrExchange;

  if (isSelfDeliveryMode) {
    if (!this.deliveryMode || this.deliveryMode === "pending_choice") {
      this.deliveryMode = "self_delivery";
    }
    let canonicalOtp = "";

    // If order was already successfully verified and finished, keep OTP cleared
    if (isOrderTerminal && !hasValidOtp) {
      canonicalOtp = "";
    } else if (this.isModified && this.isModified("selfDeliveryDetails.deliveryOtp") && this.selfDeliveryDetails?.deliveryOtp) {
      canonicalOtp = String(this.selfDeliveryDetails.deliveryOtp).trim();
    } else if (this.isModified && this.isModified("deliveryOtp") && this.deliveryOtp) {
      canonicalOtp = String(this.deliveryOtp).trim();
    } else if (hasValidOtp) {
      canonicalOtp = existingOtpCandidate;
    } else {
      canonicalOtp = String(
        this.deliveryOtp ||
        this.selfDeliveryDetails?.deliveryOtp ||
        (this.items?.[0]?.selfDeliveryDetails?.deliveryOtp) ||
        (this.items?.[0]?.deliveryOtp) ||
        ""
      ).trim();
    }

    // Generate secure 4-digit OTP for confirmed delivery/exchange if not finished
    if (!isOrderTerminal && (!canonicalOtp || !/^\d{4}$/.test(canonicalOtp))) {
      canonicalOtp = Math.floor(1000 + Math.random() * 9000).toString();
    }

    this.deliveryOtp = canonicalOtp;
    if (!this.selfDeliveryDetails) {
      this.selfDeliveryDetails = {};
    }
    this.selfDeliveryDetails.deliveryOtp = canonicalOtp;

    // Ensure OTP timestamps remain active (24-hour validity window)
    if (canonicalOtp && /^\d{4}$/.test(canonicalOtp)) {
      if (!this.selfDeliveryDetails.otpLastSentAt) {
        this.selfDeliveryDetails.otpLastSentAt = this.updatedAt || this.createdAt || new Date();
      }
      if (!this.selfDeliveryDetails.otpExpiresAt) {
        this.selfDeliveryDetails.otpExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      }
    }

    if (Array.isArray(this.items)) {
      this.items.forEach(it => {
        it.deliveryOtp = canonicalOtp;
        if (!it.selfDeliveryDetails) it.selfDeliveryDetails = {};
        it.selfDeliveryDetails.deliveryOtp = canonicalOtp;
        if (canonicalOtp && /^\d{4}$/.test(canonicalOtp)) {
          if (!it.selfDeliveryDetails.otpLastSentAt) it.selfDeliveryDetails.otpLastSentAt = this.selfDeliveryDetails.otpLastSentAt;
          if (!it.selfDeliveryDetails.otpExpiresAt) it.selfDeliveryDetails.otpExpiresAt = this.selfDeliveryDetails.otpExpiresAt;
        }
      });
    }
  } else if (this.deliveryMode === "third_party" && !isReturnOrExchange) {
    // 3rd-party forward courier uses carrier AWB, no store doorstep OTP
    this.deliveryOtp = "";
    if (this.selfDeliveryDetails) {
      this.selfDeliveryDetails.deliveryOtp = "";
    }
    if (Array.isArray(this.items)) {
      this.items.forEach(it => {
        it.deliveryOtp = "";
        if (it.selfDeliveryDetails) {
          it.selfDeliveryDetails.deliveryOtp = "";
        }
      });
    }
  } else {
    // pending_choice or unconfirmed: keep existing OTP if already set, do not blank it!
    this.deliveryMode = this.deliveryMode || "pending_choice";
    if (!this.deliveryOtp && !this.selfDeliveryDetails?.deliveryOtp) {
      this.deliveryOtp = "";
      if (this.selfDeliveryDetails) {
        this.selfDeliveryDetails.deliveryOtp = "";
      }
      if (Array.isArray(this.items)) {
        this.items.forEach(it => {
          if (!it.deliveryOtp) it.deliveryOtp = "";
          if (it.selfDeliveryDetails && !it.selfDeliveryDetails.deliveryOtp) {
            it.selfDeliveryDetails.deliveryOtp = "";
          }
        });
      }
    }
  }

  if (this.isNew && (!this.timeline || this.timeline.length === 0)) {
    this.timeline = [
      {
        status: "placed",
        title: "Order Placed",
        description: "Your order has been received and is waiting for confirmation.",
        timestamp: new Date(),
        updatedBy: "System"
      }
    ];
  }
  if (!this.orderId || /^[0-9a-fA-F]{24}$/.test(this.orderId)) {
    this.orderId = generateProductOrderId();
  }
  if (!this.id || /^[0-9a-fA-F]{24}$/.test(this.id)) {
    this.id = this.orderId;
  }
  if (!this.date) {
    this.date = new Date().toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata'
    });
  }
  next();
});

orderSchema.index({ orderId: 1 });
orderSchema.index({ id: 1 });
orderSchema.index({ userId: 1 });
orderSchema.index({ "customer.phone": 1 });
orderSchema.index({ "customer.email": 1 });
orderSchema.index({ masterOrderId: 1 });
orderSchema.index({ sellerId: 1 });
orderSchema.index({ seller: 1 });
orderSchema.index({ "items.sellerId": 1 });
orderSchema.index({ createdAt: -1 });

export default mongoose.model("Order", orderSchema);