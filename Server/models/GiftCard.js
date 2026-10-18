import mongoose from 'mongoose';

const giftCardSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  status: { 
    type: String, 
    enum: ['active', 'used', 'expired'], 
    default: 'active' 
  },
  expiryDate: { type: Date, required: true },
  usedBy: { type: String }
}, {
  timestamps: true
});

export default mongoose.model('GiftCard', giftCardSchema);