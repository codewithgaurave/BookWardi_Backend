import mongoose from "mongoose";

const payoutSchema = new mongoose.Schema(
  {
    payoutId: {
      type: String,
      unique: true,
      default: () => "PAY-" + Date.now().toString(36).toUpperCase()
    },
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true
    },
    amount: {
      type: Number,
      required: true,
      min: [100, "Minimum payout request is ₹100"]
    },
    bankDetails: {
      accountHolderName: { type: String, required: true },
      accountNumber: { type: String, required: true },
      ifscCode: { type: String, required: true },
      bankName: { type: String, default: "" }
    },
    status: {
      type: String,
      enum: ["pending", "approved", "processed", "rejected"],
      default: "pending"
    },
    transactionReference: {
      type: String,
      default: "" // UTR / IMPS reference number
    },
    rejectionReason: {
      type: String,
      default: ""
    },
    processedAt: {
      type: Date
    },
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin"
    },
    notes: {
      type: String,
      default: ""
    }
  },
  {
    timestamps: true
  }
);

export default mongoose.model("Payout", payoutSchema);
