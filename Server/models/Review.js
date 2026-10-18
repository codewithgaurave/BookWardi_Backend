import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    userId: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    userName: {
      type: String,
      default: "Verified Customer"
    },
    institution: {
      type: String,
      default: ""
    },
    rating: {
      type: Number,
      required: [true, "Rating is required (1-5)"],
      min: 1,
      max: 5
    },
    title: {
      type: String,
      default: ""
    },
    comment: {
      type: String,
      required: [true, "Comment is required"],
      trim: true
    },
    images: {
      type: [String],
      default: []
    },
    verifiedPurchase: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending"
    },
    reply: {
      type: String,
      default: ""
    },
    repliedAt: {
      type: Date,
      default: null
    },
    sellerId: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    }
  },
  {
    timestamps: true,
    strict: false
  }
);

export default mongoose.model("Review", reviewSchema);
