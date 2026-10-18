import mongoose from "mongoose";

const platformSettingSchema = new mongoose.Schema({
  key: { type: String, default: "global_settings", unique: true },
  schoolRadiusKm: { type: Number, default: 25 },
  defaultCommissionRate: { type: Number, default: 10 },
  gstOnCommissionRate: { type: Number, default: 18 },
  tdsRate: { type: Number, default: 0.1 },
  gstTcsRate: { type: Number, default: 0.5 },
  gstTaxRate: { type: Number, default: 18 },
  shippingFee: { type: Number, default: 49 },
  minOrderFreeShipping: { type: Number, default: 999 },
  freeShippingThreshold: { type: Number, default: 999 },
  maintenanceMode: { type: Boolean, default: false },
  supportEmail: { type: String, default: "support@bookvardi.in" },
  supportPhone: { type: String, default: "+91 98765 43210" },
  updatedBy: { type: String, default: "Super Admin" },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

export default mongoose.model("PlatformSetting", platformSettingSchema);
