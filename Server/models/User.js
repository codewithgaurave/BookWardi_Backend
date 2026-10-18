import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const addressSchema = new mongoose.Schema({
  id: { type: mongoose.Schema.Types.Mixed },
  name: { type: String, default: "" },
  phone: { type: String, default: "" },
  addressLine: { type: String, default: "" },
  street: { type: String, default: "" },
  city: { type: String, default: "" },
  state: { type: String, default: "" },
  pincode: { type: String, default: "" },
  landmark: { type: String, default: "" },
  type: { type: String, default: "Home" },
  addressType: { type: String, default: "Home" },
  isDefault: { type: Boolean, default: false }
});

const deviceTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, trim: true },
    platform: { type: String, enum: ["android", "ios", "web", "unknown"], default: "android" },
    deviceId: { type: String, default: "" },
    lastActive: { type: Date, default: Date.now }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", trim: true },
    email: { type: String, default: "", lowercase: true, trim: true },
    password: { type: String, default: "BookVardi@123" },
    phone: { type: String, default: "", trim: true },
    avatar: { type: String, default: "" },
    institution: { type: String, default: "", trim: true },
    studentId: { type: String, default: "", trim: true },
    standard: { type: String, default: "", trim: true },
    role: { type: String, default: "user" },
    status: { type: String, enum: ["active", "inactive", "blocked"], default: "active" },
    isSeller: { type: Boolean, default: false },
    sellerStatus: { type: String, default: "none" },
    phoneVerified: { type: Boolean, default: false },
    otpCode: { type: String, default: "" },
    otpExpiresAt: { type: Date, default: null },
    resetPasswordToken: { type: String, default: "" },
    resetPasswordExpires: { type: Date, default: null },
    fcmToken: { type: String, default: "" },
    fcmTokens: [deviceTokenSchema],
    addresses: [addressSchema]
  },
  {
    timestamps: true
  }
);

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password helper
userSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

userSchema.index({ phone: 1 });
userSchema.index({ email: 1 });

export default mongoose.model("User", userSchema);