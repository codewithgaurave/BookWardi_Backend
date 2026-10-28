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
  codFee: { type: Number, default: 0 },
  companyName: { type: String, default: "BOOK VARDI" },
  companyAddress: { type: String, default: "Lucknow, Uttar Pradesh - 226001" },
  companyGstin: { type: String, default: "09AAACB1234F1Z9" },
  maintenanceMode: { type: Boolean, default: false },
  supportEmail: { type: String, default: "support@bookvardi.in" },
  supportPhone: { type: String, default: "+91 98765 43210" },
  customerCareEmail: { type: String, default: "support@bookvardi.in" },
  customerCarePhone: { type: String, default: "+91 98765 43210" },
  supportHours: { type: String, default: "Mon - Sat (9:00 AM - 6:00 PM)" },
  updatedBy: { type: String, default: "Super Admin" },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

export default mongoose.model("PlatformSetting", platformSettingSchema);
