import mongoose from 'mongoose';

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  discount: { type: Number, required: true },
  type: { 
    type: String, 
    enum: ['percentage', 'fixed', 'flat'], 
    default: 'percentage',
    required: true 
  },
  minAmount: { type: Number, default: 0 },
  maxDiscount: { type: Number, default: 0 },
  usageLimit: { type: Number, default: 0 },
  usageCount: { type: Number, default: 0 },
  status: { 
    type: String, 
    enum: ['active', 'inactive', 'expired'], 
    default: 'active' 
  },
  expiryDate: { type: Date, required: true },
  storeId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Store' 
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller'
  },
  createdRole: {
    type: String,
    enum: ['admin', 'seller'],
    default: 'admin'
  },
  applicableScope: {
    type: String,
    enum: ['storewide', 'all', 'specific_product', 'specific_kit', 'all_kits', 'category'],
    default: 'storewide'
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
  specificKitImage: { type: String, default: "" }
}, {
  timestamps: true
});

export default mongoose.model('Coupon', couponSchema);