import mongoose from 'mongoose';

const deviceTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, trim: true },
    platform: { type: String, enum: ["android", "ios", "web", "unknown"], default: "android" },
    deviceId: { type: String, default: "" },
    lastActive: { type: Date, default: Date.now }
  },
  { _id: false }
);

const deliveryBoySchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  status: { 
    type: String, 
    enum: ['active', 'inactive'], 
    default: 'active' 
  },
  orders: { type: Number, default: 0 },
  fcmToken: { type: String, default: "" },
  fcmTokens: [deviceTokenSchema]
}, {
  timestamps: true
});

export default mongoose.model('DeliveryBoy', deliveryBoySchema);