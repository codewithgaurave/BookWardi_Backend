import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order"
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    customer: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" }
    },
    amount: {
      type: Number,
      required: true
    },
    currency: {
      type: String,
      default: "INR"
    },
    paymentMethod: {
      type: String,
      enum: ["razorpay", "upi", "card", "netbanking", "wallet", "cod", "cash"],
      default: "razorpay"
    },
    razorpayOrderId: {
      type: String,
      default: ""
    },
    razorpayPaymentId: {
      type: String,
      default: ""
    },
    razorpaySignature: {
      type: String,
      default: ""
    },
    status: {
      type: String,
      enum: ["created", "authorized", "captured", "failed", "refunded", "pending"],
      default: "created"
    },
    receipt: {
      type: String,
      default: ""
    },
    notes: {
      type: Map,
      of: String,
      default: {}
    }
  },
  {
    timestamps: true
  }
);

export default mongoose.model("Payment", paymentSchema);