import mongoose from "mongoose";

const sellerOfferSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: [true, "Seller ID is required"]
    },
    title: {
      type: String,
      required: [true, "Offer title is required"],
      trim: true
    },
    code: {
      type: String,
      required: [true, "Coupon code is required"],
      uppercase: true,
      trim: true
    },
    description: {
      type: String,
      trim: true,
      default: ""
    },
    discountType: {
      type: String,
      enum: ["percentage", "flat"],
      default: "percentage"
    },
    discountValue: {
      type: Number,
      required: [true, "Discount value is required"],
      min: 0
    },
    minOrderAmount: {
      type: Number,
      default: 0,
      min: 0
    },
    maxDiscount: {
      type: Number,
      default: 0 // 0 means no cap
    },
    startDate: {
      type: Date,
      default: Date.now
    },
    endDate: {
      type: Date,
      required: [true, "Offer expiry date is required"]
    },
    status: {
      type: String,
      enum: ["active", "inactive", "expired"],
      default: "active"
    },
    createdRole: {
      type: String,
      enum: ["admin", "seller"],
      default: "seller"
    },
    applicableScope: {
      type: String,
      default: "storewide"
    },
    applicableProducts: {
      type: [String],
      default: []
    },
    applicableKits: {
      type: [String],
      default: []
    },
    specificProductId: { type: String, default: "" },
    specificProductName: { type: String, default: "" },
    specificKitId: { type: String, default: "" },
    specificKitTitle: { type: String, default: "" },
    specificKitImage: { type: String, default: "" },
    usageLimit: {
      type: Number,
      default: 0
    },
    usageCount: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

// Compound index to ensure unique coupon code per seller
sellerOfferSchema.index({ sellerId: 1, code: 1 }, { unique: true });

export default mongoose.model("SellerOffer", sellerOfferSchema);
