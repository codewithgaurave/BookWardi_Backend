import mongoose from "mongoose";

const deliveryPartnerSchema = new mongoose.Schema(
  {
    partnerId: { type: String, required: true, unique: true }, // e.g., 'shiprocket', 'delhivery', 'bluedart', 'local_express'
    name: { type: String, required: true },
    code: { type: String, required: true },
    active: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    avgDays: { type: String, default: "2-4 Business Days" },
    baseRate: { type: Number, default: 45 },
    perKgRate: { type: Number, default: 20 },
    apiKey: { type: String, default: "" },
    apiSecret: { type: String, default: "" },
    merchantId: { type: String, default: "" },
    sandboxMode: { type: Boolean, default: true }, // Sandbox / Mock mode by default
    apiEndpoint: { type: String, default: "" }
  },
  { timestamps: true }
);

const deliveryPartnerConfigSchema = new mongoose.Schema(
  {
    platformDefaultPartner: { type: String, default: "shiprocket" },
    freeShippingThreshold: { type: Number, default: 999 },
    baseCodFee: { type: Number, default: 40 },
    partners: [deliveryPartnerSchema]
  },
  { timestamps: true }
);

export default mongoose.model("DeliveryPartnerConfig", deliveryPartnerConfigSchema);
