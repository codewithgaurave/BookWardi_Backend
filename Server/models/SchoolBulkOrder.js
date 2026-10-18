import mongoose from "mongoose";

const requirementItemSchema = new mongoose.Schema(
  {
    category: { type: String, default: "General Bulk Procurement" },
    itemName: { type: String, default: "Bulk Stationery / Uniform" },
    quantity: { type: Number, default: 100 },
    budgetPerUnit: { type: Number, default: 0 },
    sellerPricePerUnit: { type: Number, default: 0 },
    sampleImage: { type: String, default: "" },
    sampleImages: [{ type: String }],
    customizations: { type: String, default: "" },
    notes: { type: String, default: "" }
  },
  { _id: true }
);

const negotiationRoundSchema = new mongoose.Schema(
  {
    round: { type: Number, required: true },
    version: { type: Number, required: true },
    senderRole: { type: String, enum: ["seller", "buyer"], required: true },
    senderName: { type: String, default: "" },
    senderId: { type: String, default: "" },
    quoteAmount: { type: Number, default: 0 },
    unitPrice: { type: Number, default: 0 },
    itemPrices: [
      {
        itemId: { type: String, default: "" },
        itemName: { type: String, default: "" },
        quantity: { type: Number, default: 1 },
        sellerPrice: { type: Number, default: 0 },
        pricePerUnit: { type: Number, default: 0 },
        sellerPricePerUnit: { type: Number, default: 0 },
        targetUnitPrice: { type: Number, default: 0 },
        totalPrice: { type: Number, default: 0 },
        discountTierNote: { type: String, default: "" }
      }
    ],
    estimatedDeliveryDays: { type: Number, default: 7 },
    proposedDeliveryDate: { type: String, default: "" },
    prepaymentType: {
      type: String,
      enum: ["percentage", "amount"],
      default: "percentage"
    },
    prepaymentPercentage: { type: Number, default: 0 },
    prepaymentAmount: { type: Number, default: 0 },
    prepaymentRaised: { type: Boolean, default: false },
    deliveryDaysRaised: { type: Boolean, default: false },
    notes: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const quotationSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", required: true },
    sellerName: { type: String, required: true },
    sellerStoreName: { type: String, default: "" },
    sellerPhone: { type: String, default: "" },
    sellerCity: { type: String, default: "" },

    quoteAmount: { type: Number, required: true },
    unitPrice: { type: Number, default: 0 },
    itemPrices: [
      {
        itemId: { type: String },
        itemName: { type: String },
        category: { type: String, default: "" },
        quantity: { type: Number, default: 1 },
        customerBudget: { type: Number, default: 0 },
        pricePerUnit: { type: Number, default: 0 },
        totalPrice: { type: Number, default: 0 },
        discountTierNote: { type: String, default: "" }
      }
    ],
    volumeDiscountNote: { type: String, default: "" },
    estimatedDeliveryDays: { type: Number, default: 7 },
    proposedDeliveryDate: { type: String, default: "" },
    notes: { type: String, default: "" },

    // Seller Demand for Prepayment / Advance Payment
    sellerAdvanceType: {
      type: String,
      enum: ["percentage", "amount"],
      default: "percentage"
    },
    sellerAdvancePercentage: { type: Number, default: 0 },
    sellerAdvanceAmount: { type: Number, default: 0 },
    sellerAdvanceTerms: { type: String, default: "" },

    prepaymentType: {
      type: String,
      enum: ["percentage", "amount"],
      default: "percentage"
    },
    prepaymentPercentage: { type: Number, default: 0 },
    prepaymentAmount: { type: Number, default: 0 },
    prepaymentTerms: { type: String, default: "" },

    // Multi-round negotiation and version tracking
    currentVersion: { type: Number, default: 1 },
    negotiationStage: {
      type: String,
      enum: [
        "seller_quoted",
        "buyer_countered",
        "seller_accepted_counter",
        "revised_by_seller",
        "buyer_accepted_quote",
        "approved",
        "rejected"
      ],
      default: "seller_quoted"
    },
    latestBuyerCounter: {
      targetBudget: { type: Number, default: 0 },
      requestedDeliveryDays: { type: Number, default: 0 },
      proposedAdvancePercentage: { type: Number, default: 0 },
      proposedAdvanceAmount: { type: Number, default: 0 },
      notes: { type: String, default: "" },
      itemDemands: [
        {
          itemId: { type: String, default: "" },
          itemName: { type: String, default: "" },
          quantity: { type: Number, default: 1 },
          targetUnitPrice: { type: Number, default: 0 },
          targetTotalPrice: { type: Number, default: 0 },
          notes: { type: String, default: "" }
        }
      ],
      counteredAt: { type: Date }
    },
    negotiationHistory: [negotiationRoundSchema],

    status: {
      type: String,
      enum: ["submitted", "under_review", "approved", "rejected", "buyer_accepted"],
      default: "submitted"
    },
    acceptanceMode: {
      type: String,
      default: "standard"
    },
    acceptedAtTargetBudget: {
      type: Boolean,
      default: false
    },
    submittedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

const schoolBulkOrderSchema = new mongoose.Schema(
  {
    referenceId: { type: String, required: true, unique: true },
    institutionName: { type: String, required: true },
    schoolId: { type: String, default: "" },
    institutionType: { type: String, default: "K-12 School" },

    contactName: { type: String, required: true },
    contactEmail: { type: String, default: "" },
    contactPhone: { type: String, required: true },
    designation: { type: String, default: "Administrator" },

    // Private User Ownership
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    customUserId: { type: String, default: "", index: true },
    userPhone: { type: String, default: "", index: true },
    userEmail: { type: String, default: "" },

    address: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    pincode: { type: String, default: "" },

    requirements: [requirementItemSchema],

    totalQuantity: { type: Number, default: 0 },
    overallBudget: { type: Number, default: 0 },
    targetDeliveryDate: { type: String, default: "" },
    expectedQuotationDate: { type: String, default: "" },
    logoEmbroideryRequired: { type: Boolean, default: false },
    targetBudgetPerKit: { type: String, default: "" },
    additionalNotes: { type: String, default: "" },

    // Buyer Advance Payment Offer (Deprecated / 0 by default - prepayment is not initiated by buyer)
    buyerAdvanceType: {
      type: String,
      enum: ["percentage", "amount"],
      default: "percentage"
    },
    buyerAdvancePercentage: { type: Number, default: 0 },
    buyerAdvanceAmount: { type: Number, default: 0 },
    buyerAdvanceNote: { type: String, default: "" },

    // Seller Counter Demand for Advance Payment (Agreed / Final)
    sellerAdvanceType: {
      type: String,
      enum: ["percentage", "amount"],
      default: "percentage"
    },
    sellerAdvancePercentage: { type: Number, default: 0 },
    sellerAdvanceAmount: { type: Number, default: 0 },
    sellerAdvanceTerms: { type: String, default: "" },

    // Agreed Advance & Receipt State
    advancePaymentStatus: {
      type: String,
      enum: ["pending", "offered", "demanded", "agreed", "paid_partially", "paid"],
      default: "pending"
    },
    advancePaidAmount: { type: Number, default: 0 },
    advancePaidAt: { type: Date },
    advancePaymentMode: { type: String, default: "Online / Bank Transfer" },
    advanceTransactionId: { type: String, default: "" },
    advanceReceiptNumber: { type: String, default: "" },

    // Remaining Settlement & Final Payment State
    remainingPaymentStatus: {
      type: String,
      enum: ["pending", "paid"],
      default: "pending"
    },
    remainingPaidAmount: { type: Number, default: 0 },
    remainingPaidAt: { type: Date },
    remainingPaymentMode: { type: String, default: "Online (Razorpay / UPI)" },
    remainingTransactionId: { type: String, default: "" },
    remainingReceiptNumber: { type: String, default: "" },

    // Distribution & Assignment Options: unassigned, direct, selected, broadcast
    assignmentMode: {
      type: String,
      enum: ["unassigned", "direct", "selected", "broadcast"],
      default: "unassigned"
    },
    isGlobalRfq: { type: Boolean, default: false },
    isGlobal: { type: Boolean, default: false },
    isPublic: { type: Boolean, default: false },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", index: true }, // Assigned seller
    invitedSellerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Seller" }],

    // Seller Quotations & Counter Offers
    quotations: [quotationSchema],
    acceptedQuoteId: { type: mongoose.Schema.Types.ObjectId },
    acceptanceMode: { type: String, default: "standard" },
    acceptedAtTargetBudget: { type: Boolean, default: false },
    acceptedPrice: { type: Number, default: 0 },

    // Delivery & Tracking Details (Seller Bulk Orders - Self Delivery Fleet)
    deliveryMode: {
      type: String,
      default: "self_delivery"
    },
    deliveryDetails: {
      deliveryBoyName: { type: String, default: "" },
      deliveryBoyPhone: { type: String, default: "" },
      vehicleNumber: { type: String, default: "" },
      trackingId: { type: String, default: "" },
      trackingUrl: { type: String, default: "" },
      deliveryPartnerToken: { type: String, default: "" },
      deliveryOtp: { type: String, default: "" },
      driverLocation: {
        type: mongoose.Schema.Types.Mixed,
        default: null
      },
      dispatchedAt: { type: Date },
      deliveredAt: { type: Date },
      notes: { type: String, default: "" }
    },

    // Status: pending, under_review, published, assigned, quoted, quote_accepted, accepted, packed, out for delivery, completed, received, fulfilled, rejected
    status: { type: String, default: "pending" }
  },
  { timestamps: true }
);

export default mongoose.model("SchoolBulkOrder", schoolBulkOrderSchema);
