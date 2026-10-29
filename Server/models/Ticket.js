import mongoose from "mongoose";

const ticketSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    ticketId: { type: String, required: true },
    userType: { type: String, enum: ["seller", "customer", "school"], default: "seller" },
    sellerId: { type: mongoose.Schema.Types.Mixed, default: null },
    userId: { type: mongoose.Schema.Types.Mixed, default: null },
    storeName: { type: String, default: "" },
    customerName: { type: String, default: "" },
    email: { type: String, required: true },
    phone: { type: String, default: "" },
    category: { type: String, default: "payout" },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    lastMessage: { type: String, default: "" },
    priority: { type: String, enum: ["Low", "Medium", "High"], default: "Medium" },
    status: { type: String, enum: ["Open", "In Progress", "Resolved", "Closed"], default: "Open" },
    adminReplies: [
      {
        reply: { type: String, default: "" },
        repliedAt: { type: Date, default: Date.now },
        repliedBy: { type: String, default: "Admin" }
      }
    ]
  },
  { timestamps: true }
);

ticketSchema.index({ sellerId: 1 });
ticketSchema.index({ email: 1 });
ticketSchema.index({ status: 1 });
ticketSchema.index({ createdAt: -1 });

export default mongoose.model("Ticket", ticketSchema);

