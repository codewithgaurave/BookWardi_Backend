import mongoose from "mongoose";
import User from "../models/User.js";
import Seller from "../models/Seller.js";
import DeliveryBoy from "../models/DeliveryBoy.js";
import jwt from "jsonwebtoken";
import { saveBase64ToFile } from "./sellerAuthController.js";
import { sendFast2SmsOtp } from "../services/smsService.js";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

const otpStore = new Map();

export const normalizePhone = (phone) => {
  if (!phone) return "";
  const digitsOnly = String(phone).replace(/\D/g, "");
  return digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;
};

import { upsertFcmToken, removeFcmTokenFromDoc } from "../utils/fcmHelper.js";
export { upsertFcmToken, removeFcmTokenFromDoc };

const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role || "user"
    },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
};

// Helper to clean up expired OTPs from in-memory store
const cleanupExpiredOtps = () => {
  const now = Date.now();
  for (const [key, value] of otpStore.entries()) {
    if (value.expires < now) {
      otpStore.delete(key);
    }
  }
};

// Send OTP Function with DB user check
export const sendOtp = async (req, res) => {
  try {
    const { phone, purpose = "auth" } = req.body;
    if (!phone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    cleanupExpiredOtps();

    const cleanPhone = normalizePhone(phone);

    // Check DB for registered user by phone
    const userExists = await User.findOne({
      $or: [
        { phone: phone.trim() },
        { phone: { $regex: cleanPhone + "$" } }
      ]
    });

    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    otpStore.set(cleanPhone, {
      otp,
      expires: Date.now() + 15 * 60 * 1000,
      purpose
    });

    if (userExists) {
      try {
        userExists.otpCode = otp;
        userExists.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await userExists.save();
      } catch (err) {
        console.warn("Failed to persist OTP to user doc:", err.message);
      }
    }

    // Dispatch real DLT SMS via Fast2SMS API
    let smsDispatched = false;
    let smsResponse = null;
    try {
      smsResponse = await sendFast2SmsOtp(cleanPhone, otp);
      smsDispatched = Boolean(smsResponse?.success);
      if (smsDispatched) {
        console.log(`📲 [AUTH] Fast2SMS OTP successfully dispatched to +91 ${cleanPhone}`);
      } else {
        console.warn(`⚠️ [AUTH] Fast2SMS dispatch warning for +91 ${cleanPhone}:`, smsResponse?.error || smsResponse?.message);
      }
    } catch (smsErr) {
      console.warn("⚠️ [AUTH] Fast2SMS dispatch error:", smsErr.message);
    }

    return res.json({
      success: true,
      message: smsDispatched ? `OTP sent successfully to +91 ${cleanPhone}` : `OTP sent to +91 ${cleanPhone}`,
      smsSent: smsDispatched,
      requestId: smsResponse?.requestId || null,
      isRegistered: Boolean(userExists)
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to send OTP", error: error.message });
  }
};

// Verify OTP Function
export const verifyOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) {
      return res.status(400).json({ message: "Phone and OTP are required" });
    }

    const cleanPhone = normalizePhone(phone);
    const stored = otpStore.get(cleanPhone);

    const user = await User.findOne({
      $or: [
        { phone: phone.trim() },
        { phone: { $regex: cleanPhone + "$" } }
      ]
    });

    const inputOtp = String(otp).trim();
    const isValidStoredOtp = stored && stored.otp === inputOtp && Date.now() <= stored.expires;
    const isValidDbOtp = user && user.otpCode && user.otpCode === inputOtp && user.otpExpiresAt && new Date(user.otpExpiresAt) >= new Date();

    if (!isValidStoredOtp && !isValidDbOtp) {
      return res.status(400).json({ message: "Invalid or expired OTP. Please enter the correct OTP received on your mobile." });
    }

    // Clear used OTP once verified
    otpStore.delete(cleanPhone);

    // If existing user: login directly
    if (user) {
      try {
        user.otpCode = "";
        user.otpExpiresAt = null;
        user.phoneVerified = true;
        await user.save();
      } catch (e) {}

      const seller = await Seller.findOne({
        $or: [
          ...(user.phone ? [{ phone: user.phone }] : []),
          ...(user.email ? [{ email: user.email }] : [])
        ]
      });
      const isSeller = Boolean(user.isSeller || (seller && seller.status === "approved"));
      const sellerStatus = seller ? seller.status : (user.sellerStatus || "none");
      const token = generateToken(user);

      return res.json({
        success: true,
        message: "Login successful",
        verified: true,
        isRegistered: true,
        isNewUser: false,
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          avatar: user.avatar,
          isSeller,
          sellerStatus,
          institution: user.institution || "",
          studentId: user.studentId || "",
          standard: user.standard || "",
          addresses: user.addresses || []
        }
      });
    }

    // If new user: OTP verified, register flow follows
    return res.json({
      success: true,
      message: "OTP verified. New user registration required",
      verified: true,
      isRegistered: false,
      isNewUser: true,
      phone: cleanPhone,
      token: null,
      user: null
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to verify OTP", error: error.message });
  }
};

// Login with OTP Function
export const loginWithOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) {
      return res.status(400).json({ message: "Phone number and OTP are required" });
    }

    const cleanPhone = normalizePhone(phone);
    const stored = otpStore.get(cleanPhone);

    let user = await User.findOne({
      $or: [
        { phone: phone.trim() },
        { phone: { $regex: cleanPhone + "$" } }
      ]
    });

    const inputOtp = String(otp).trim();
    const isValidStoredOtp = stored && stored.otp === inputOtp && Date.now() <= stored.expires;
    const isValidDbOtp = user && user.otpCode && user.otpCode === inputOtp && user.otpExpiresAt && new Date(user.otpExpiresAt) >= new Date();

    if (!isValidStoredOtp && !isValidDbOtp) {
      return res.status(400).json({ message: "Invalid or expired OTP. Please enter the correct OTP received on your mobile." });
    }

    // Clear used OTP now that login is complete
    otpStore.delete(cleanPhone);
    if (user) {
      try {
        user.otpCode = "";
        user.otpExpiresAt = null;
        user.phoneVerified = true;
        await user.save();
      } catch (e) {}
    }

    if (!user) {
      return res.json({
        success: true,
        message: "OTP verified. User not found, please register",
        verified: true,
        isRegistered: false,
        isNewUser: true,
        phone: cleanPhone,
        token: null,
        user: null
      });
    }

    if (req.body.fcmToken) {
      upsertFcmToken(user, {
        fcmToken: req.body.fcmToken,
        platform: req.body.platform,
        deviceId: req.body.deviceId
      });
      await user.save();
    }

    const seller = await Seller.findOne({
      $or: [
        ...(user.phone ? [{ phone: user.phone }] : []),
        ...(user.email ? [{ email: user.email }] : [])
      ]
    });
    const isSeller = Boolean(user.isSeller || (seller && seller.status === "approved"));
    const sellerStatus = seller ? seller.status : (user.sellerStatus || "none");

    const token = generateToken(user);

    return res.json({
      success: true,
      message: "Login successful",
      verified: true,
      isRegistered: true,
      isNewUser: false,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        avatar: user.avatar,
        isSeller,
        sellerStatus,
        institution: user.institution || "",
        studentId: user.studentId || "",
        standard: user.standard || "",
        addresses: user.addresses || []
      }
    });
  } catch (error) {
    return res.status(500).json({ message: "Login failed", error: error.message });
  }
};

// 1. Register User
export const registerUser = async (req, res) => {
  try {
    const { name, email, password, phone, institution, studentId, standard } = req.body;
    const normalizedPhone = normalizePhone(phone);
    const normalizedEmail = email ? email.toLowerCase().trim() : "";

    if (!name) {
      return res.status(400).json({ message: "Name is required" });
    }

    const defaultPassword = password || "BookVardi@123";

    let user = await User.findOne({
      $or: [
        ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
        ...(normalizedPhone ? [{ phone: normalizedPhone }, { phone: { $regex: normalizedPhone + "$" } }] : [])
      ]
    });

    if (user) {
      user.name = name || user.name;
      if (normalizedEmail) user.email = normalizedEmail;
      if (institution) user.institution = institution;
      if (studentId) user.studentId = studentId;
      if (standard) user.standard = standard;
      user.phoneVerified = true;
      if (req.body.fcmToken) {
        upsertFcmToken(user, {
          fcmToken: req.body.fcmToken,
          platform: req.body.platform,
          deviceId: req.body.deviceId
        });
      }
      await user.save();
    } else {
      user = new User({
        name,
        email: normalizedEmail || `student${normalizedPhone.slice(-4)}@bookvardi.local`,
        password: defaultPassword,
        phone: normalizedPhone ? `+91${normalizedPhone}` : phone,
        institution: institution || "",
        studentId: studentId || "",
        standard: standard || "",
        phoneVerified: true
      });
      if (req.body.fcmToken) {
        upsertFcmToken(user, {
          fcmToken: req.body.fcmToken,
          platform: req.body.platform,
          deviceId: req.body.deviceId
        });
      }
      await user.save();
    }

    const token = generateToken(user);

    return res.status(201).json({
      success: true,
      message: "Registration successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role || "user",
        institution: user.institution || "",
        studentId: user.studentId || "",
        standard: user.standard || "",
        addresses: user.addresses || []
      }
    });
  } catch (error) {
    console.error("User registration error:", error);
    return res.status(500).json({ message: "Registration failed", error: error.message });
  }
};

// 2. Login User
export const loginUser = async (req, res) => {
  try {
    const { email, password, phone } = req.body;
    const normalizedPhone = normalizePhone(phone);
    const normalizedEmail = email ? email.toLowerCase().trim() : "";

    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }

    const user = normalizedEmail
      ? await User.findOne({ email: normalizedEmail })
      : normalizedPhone
        ? await User.findOne({ phone: normalizedPhone })
        : null;

    if (!user) {
      return res.status(401).json({ message: "Invalid phone or email and password combination" });
    }

    if (user.status === "blocked") {
      return res.status(403).json({ message: "Your account is suspended. Please contact support." });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid phone or email and password combination" });
    }

    if (req.body.fcmToken) {
      upsertFcmToken(user, {
        fcmToken: req.body.fcmToken,
        platform: req.body.platform,
        deviceId: req.body.deviceId
      });
      await user.save();
    }

    const seller = await Seller.findOne({
      $or: [
        ...(user.phone ? [{ phone: user.phone }] : []),
        ...(user.email ? [{ email: user.email }] : [])
      ]
    });
    const isSeller = Boolean(user.isSeller || (seller && seller.status === "approved"));
    const sellerStatus = seller ? seller.status : (user.sellerStatus || "none");

    const token = generateToken(user);

    console.log("[AUTH] User login successful:", {
      id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      timestamp: new Date().toISOString()
    });

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        avatar: user.avatar,
        isSeller,
        sellerStatus,
        institution: user.institution || "",
        studentId: user.studentId || "",
        standard: user.standard || "",
        addresses: user.addresses || []
      }
    });
  } catch (error) {
    res.status(500).json({ message: "Login failed", error: error.message });
  }
};

// 2.5 Get User By Phone
export const getUserByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) {
      return res.status(400).json({ message: "Phone number is required" });
    }
    const digitsOnly = String(phone).replace(/\D/g, "");
    const cleanPhone = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;

    const user = await User.findOne({
      $or: [
        { phone: phone.trim() },
        { phone: { $regex: cleanPhone + "$" } }
      ]
    }).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const seller = await Seller.findOne({
      $or: [
        ...(user.phone ? [{ phone: user.phone }] : []),
        ...(user.email ? [{ email: user.email }] : [])
      ]
    });
    const isSeller = Boolean(user.isSeller || (seller && seller.status === "approved"));
    const sellerStatus = seller ? seller.status : (user.sellerStatus || "none");

    return res.json({
      id: user._id,
      name: user.name || "",
      email: user.email || "",
      phone: user.phone || phone,
      role: user.role || "user",
      avatar: user.avatar || "",
      isSeller,
      sellerStatus,
      institution: user.institution || "",
      studentId: user.studentId || "",
      standard: user.standard || "",
      addresses: user.addresses || []
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch user by phone", error: error.message });
  }
};

// Helper to locate user document by ID, email, or phone
const findUserByIdentifier = async (req) => {
  const userId = req.user?.id || req.user?._id || req.body?.userId;
  const userPhone = req.user?.phone || req.headers?.["x-user-phone"] || req.body?.userPhone || req.body?.phone;
  const userEmail = req.user?.email || req.body?.userEmail || req.body?.email;

  const query = [];
  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    query.push({ _id: userId });
  }
  if (userPhone) {
    const cleanPhone = String(userPhone).replace(/\D/g, "");
    if (cleanPhone.length >= 10) {
      query.push({ phone: { $regex: cleanPhone.slice(-10) + "$" } });
    } else {
      query.push({ phone: userPhone.trim() });
    }
  }
  if (userEmail) {
    query.push({ email: userEmail.toLowerCase().trim() });
  }

  if (query.length === 0) return null;
  return await User.findOne({ $or: query });
};

// 3. Get User Profile
export const getUserProfile = async (req, res) => {
  try {
    let user = await findUserByIdentifier(req);
    if (!user) {
      const userPhone = req.headers?.["x-user-phone"] || req.user?.phone || req.query?.phone;
      if (userPhone) {
        const cleanPhone = normalizePhone(userPhone);
        if (cleanPhone) {
          user = new User({
            name: "Book Vardi User",
            email: `user_${cleanPhone}@bookvardi.local`,
            phone: `+91${cleanPhone}`,
            phoneVerified: true
          });
          await user.save();
        }
      }
    }

    if (!user) {
      return res.status(200).json({
        id: "guest-user",
        name: "Guest User",
        email: "",
        phone: req.headers?.["x-user-phone"] || "",
        role: "user",
        addresses: []
      });
    }

    const seller = await Seller.findOne({
      $or: [
        ...(user.phone ? [{ phone: user.phone }] : []),
        ...(user.email ? [{ email: user.email }] : [])
      ]
    });
    const isSeller = Boolean(user.isSeller || (seller && seller.status === "approved"));
    const sellerStatus = seller ? seller.status : (user.sellerStatus || "none");

    const userObj = typeof user.toObject === "function" ? user.toObject() : { ...user };
    userObj.isSeller = isSeller;
    userObj.sellerStatus = sellerStatus;

    return res.json(userObj);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch profile", error: error.message });
  }
};

// 4. Update User Profile
export const updateUserProfile = async (req, res) => {
  try {
    let user = await findUserByIdentifier(req);
    const { name, email, phone, avatar, institution, studentId, standard, password, addresses } = req.body;

    if (!user) {
      const targetPhone = phone || req.headers?.["x-user-phone"] || req.user?.phone || "1231231232";
      const cleanPhone = normalizePhone(targetPhone);
      user = new User({
        name: name || "Book Vardi User",
        email: email ? email.toLowerCase().trim() : `user_${cleanPhone}@bookvardi.local`,
        phone: targetPhone.startsWith("+91") ? targetPhone : `+91${cleanPhone}`,
        avatar: avatar || "",
        institution: institution || "",
        studentId: studentId || "",
        standard: standard || "",
        addresses: Array.isArray(addresses) ? addresses : []
      });
    } else {
      if (name !== undefined) user.name = name;
      if (email !== undefined && email.trim() !== "") user.email = email.toLowerCase().trim();
      if (phone !== undefined) user.phone = phone;
      if (avatar !== undefined) user.avatar = saveBase64ToFile(avatar, "avatars", "avatar");
      if (institution !== undefined) user.institution = institution;
      if (studentId !== undefined) user.studentId = studentId;
      if (standard !== undefined) user.standard = standard;
      if (password) user.password = password;
      if (Array.isArray(addresses)) user.addresses = addresses;
    }

    if (req.body.fcmToken) {
      upsertFcmToken(user, {
        fcmToken: req.body.fcmToken,
        platform: req.body.platform,
        deviceId: req.body.deviceId
      });
    }

    await user.save();

    return res.json({
      message: "Profile updated successfully in DB",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        avatar: user.avatar,
        institution: user.institution,
        studentId: user.studentId,
        standard: user.standard,
        role: user.role,
        addresses: user.addresses
      }
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update profile", error: error.message });
  }
};

// 5. Add Delivery Address
export const addAddress = async (req, res) => {
  try {
    const user = await findUserByIdentifier(req);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const addrData = req.body;

    const newAddr = {
      id: addrData.id || Date.now(),
      name: addrData.name || user.name || "",
      phone: addrData.phone || user.phone || "",
      addressLine: addrData.addressLine || addrData.street || "",
      street: addrData.street || addrData.addressLine || "",
      city: addrData.city || "",
      state: addrData.state || "",
      pincode: addrData.pincode || "",
      landmark: addrData.landmark || "",
      type: addrData.type || addrData.addressType || "Home",
      addressType: addrData.addressType || addrData.type || "Home",
      isDefault: Boolean(addrData.isDefault) || user.addresses.length === 0
    };

    if (newAddr.isDefault) {
      user.addresses.forEach((a) => (a.isDefault = false));
    }

    user.addresses.push(newAddr);
    await user.save();

    return res.status(201).json({ message: "Address saved in DB", addresses: user.addresses, user });
  } catch (error) {
    return res.status(500).json({ message: "Failed to add address", error: error.message });
  }
};

// 5.5 Update Delivery Address
export const updateAddress = async (req, res) => {
  try {
    const user = await findUserByIdentifier(req);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const { addressId } = req.params;
    const addrData = req.body;

    const targetIdx = user.addresses.findIndex((a) => String(a.id || a._id) === String(addressId));
    if (targetIdx === -1) {
      return res.status(404).json({ message: "Address not found" });
    }

    const currentObj = typeof user.addresses[targetIdx].toObject === "function"
      ? user.addresses[targetIdx].toObject()
      : user.addresses[targetIdx];

    const updatedAddr = {
      ...currentObj,
      ...addrData,
      id: currentObj.id || addressId,
      addressLine: addrData.addressLine || addrData.street || currentObj.addressLine || "",
      street: addrData.street || addrData.addressLine || currentObj.street || "",
      type: addrData.type || addrData.addressType || currentObj.type || "Home",
      addressType: addrData.addressType || addrData.type || currentObj.addressType || "Home",
      isDefault: addrData.isDefault !== undefined ? Boolean(addrData.isDefault) : currentObj.isDefault
    };

    if (updatedAddr.isDefault) {
      user.addresses.forEach((a, idx) => {
        if (idx !== targetIdx) a.isDefault = false;
      });
    }

    user.addresses[targetIdx] = updatedAddr;
    await user.save();

    return res.json({ message: "Address updated in DB", addresses: user.addresses, user });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update address", error: error.message });
  }
};

// 6. Delete Delivery Address
export const deleteAddress = async (req, res) => {
  try {
    const user = await findUserByIdentifier(req);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const { addressId } = req.params;
    user.addresses = user.addresses.filter((a) => String(a.id || a._id) !== String(addressId));
    await user.save();

    return res.json({ message: "Address deleted from DB", addresses: user.addresses });
  } catch (error) {
    return res.status(500).json({ message: "Failed to delete address", error: error.message });
  }
};

// 7. Forgot Password (Generate Reset Token / OTP)
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Return 200 for security to prevent email enumeration
      return res.json({
        message: "If an account exists with this email, a password reset token has been generated."
      });
    }

    // Generate 6-digit secure token or crypto string
    const resetToken = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins expiry
    await user.save();

    res.json({
      message: "Password reset OTP/token generated successfully (Valid for 15 mins).",
      resetToken: process.env.NODE_ENV === "development" ? resetToken : undefined
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to process forgot password", error: error.message });
  }
};

// 8. Reset Password with Token
export const resetPassword = async (req, res) => {
  try {
    const { email, resetToken, newPassword } = req.body;

    if (!email || !resetToken || !newPassword) {
      return res.status(400).json({ message: "Email, reset token, and new password are required." });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters long." });
    }

    const user = await User.findOne({
      email: email.toLowerCase().trim(),
      resetPasswordToken: resetToken,
      resetPasswordExpires: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired password reset token." });
    }

    user.password = newPassword;
    user.resetPasswordToken = "";
    user.resetPasswordExpires = null;
    await user.save();

    res.json({ message: "Password reset successful! You can now log in with your new password." });
  } catch (error) {
    res.status(500).json({ message: "Failed to reset password", error: error.message });
  }
};

// 10. Upload Profile Picture / Avatar
export const uploadUserAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No avatar image file provided" });
    }

    const avatarPath = `/uploads/avatars/${req.file.filename}`;
    const user = await findUserByIdentifier(req);

    if (user) {
      user.avatar = avatarPath;
      await user.save();
    }

    return res.json({
      message: "Profile photo uploaded and compressed to WebP successfully",
      avatarUrl: avatarPath,
      user: user
        ? {
            id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            avatar: user.avatar
          }
        : null
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to upload avatar photo", error: error.message });
  }
};

// 11. Register or Update FCM Device Token
export const saveFcmToken = async (req, res) => {
  try {
    const { fcmToken, token: bodyToken, platform = "android", deviceId = "", phone, role } = req.body;
    const targetToken = fcmToken || bodyToken;

    if (!targetToken || typeof targetToken !== "string" || !targetToken.trim()) {
      return res.status(400).json({ success: false, message: "fcmToken is required" });
    }

    const cleanToken = targetToken.trim();

    // 1. Identify User / Caller
    let user = await findUserByIdentifier(req);

    // If not found yet and a phone was supplied in body
    if (!user && phone) {
      const cleanPhone = normalizePhone(phone);
      user = await User.findOne({
        $or: [
          { phone: phone.trim() },
          { phone: { $regex: cleanPhone + "$" } }
        ]
      });
    }

    const updatedEntities = [];

    // 2. Update User document if found
    if (user) {
      upsertFcmToken(user, { fcmToken: cleanToken, platform, deviceId });
      await user.save();
      updatedEntities.push("User");
    }

    // 3. Update Seller document if found
    const sellerQuery = [];
    if (req.user?.id && mongoose.Types.ObjectId.isValid(req.user.id)) {
      sellerQuery.push({ _id: req.user.id });
    }
    const checkPhone = user?.phone || req.user?.phone || req.headers?.["x-user-phone"] || req.headers?.["x-seller-phone"] || phone;
    if (checkPhone) {
      const cleanPhone = normalizePhone(checkPhone);
      sellerQuery.push({ phone: checkPhone.trim() });
      if (cleanPhone.length >= 10) {
        sellerQuery.push({ phone: { $regex: cleanPhone + "$" } });
      }
    }
    if (sellerQuery.length > 0) {
      const seller = await Seller.findOne({ $or: sellerQuery });
      if (seller) {
        upsertFcmToken(seller, { fcmToken: cleanToken, platform, deviceId });
        await seller.save();
        updatedEntities.push("Seller");
      }
    }

    // 4. Update DeliveryBoy document if found
    if (role === "delivery" || role === "deliveryBoy" || checkPhone) {
      const cleanPhone = normalizePhone(checkPhone);
      const deliveryBoy = await DeliveryBoy.findOne({
        $or: [
          ...(checkPhone ? [{ phone: checkPhone.trim() }] : []),
          ...(cleanPhone ? [{ phone: { $regex: cleanPhone + "$" } }] : [])
        ]
      });
      if (deliveryBoy) {
        upsertFcmToken(deliveryBoy, { fcmToken: cleanToken, platform, deviceId });
        await deliveryBoy.save();
        updatedEntities.push("DeliveryBoy");
      }
    }

    // 5. If no entity found, auto-create a user if phone is provided
    if (updatedEntities.length === 0) {
      if (checkPhone) {
        const cleanPhone = normalizePhone(checkPhone);
        const newUser = new User({
          name: `User ${cleanPhone.slice(-4)}`,
          phone: `+91${cleanPhone}`,
          email: `user_${cleanPhone}@bookvardi.local`,
          phoneVerified: true,
          fcmToken: cleanToken,
          fcmTokens: [
            {
              token: cleanToken,
              platform,
              deviceId,
              lastActive: new Date()
            }
          ]
        });
        await newUser.save();
        return res.json({
          success: true,
          message: "FCM token saved successfully into new user document",
          entitiesUpdated: ["User"],
          fcmToken: cleanToken,
          platform
        });
      }

      return res.status(404).json({
        success: false,
        message: "No user, seller, or delivery profile found to link with this FCM token. Please authenticate or provide a phone number."
      });
    }

    return res.json({
      success: true,
      message: `FCM token saved successfully into ${updatedEntities.join(", ")}`,
      entitiesUpdated: updatedEntities,
      fcmToken: cleanToken,
      platform
    });
  } catch (error) {
    console.error("Error saving FCM token:", error);
    return res.status(500).json({ success: false, message: "Failed to save FCM token", error: error.message });
  }
};

// 12. Remove FCM Device Token (Logout / Invalidation)
export const removeFcmToken = async (req, res) => {
  try {
    const { fcmToken, token: bodyToken, phone } = req.body;
    const targetToken = fcmToken || bodyToken;

    if (!targetToken || typeof targetToken !== "string" || !targetToken.trim()) {
      return res.status(400).json({ success: false, message: "fcmToken is required to remove" });
    }

    const cleanToken = targetToken.trim();
    let user = await findUserByIdentifier(req);
    if (!user && phone) {
      const cleanPhone = normalizePhone(phone);
      user = await User.findOne({
        $or: [
          { phone: phone.trim() },
          { phone: { $regex: cleanPhone + "$" } }
        ]
      });
    }

    const removedEntities = [];
    if (user && removeFcmTokenFromDoc(user, cleanToken)) {
      await user.save();
      removedEntities.push("User");
    }

    const checkPhone = user?.phone || req.user?.phone || req.headers?.["x-user-phone"] || req.headers?.["x-seller-phone"] || phone;
    if (checkPhone) {
      const cleanPhone = normalizePhone(checkPhone);
      const seller = await Seller.findOne({
        $or: [
          { phone: checkPhone.trim() },
          { phone: { $regex: cleanPhone + "$" } }
        ]
      });
      if (seller && removeFcmTokenFromDoc(seller, cleanToken)) {
        await seller.save();
        removedEntities.push("Seller");
      }

      const deliveryBoy = await DeliveryBoy.findOne({
        $or: [
          { phone: checkPhone.trim() },
          { phone: { $regex: cleanPhone + "$" } }
        ]
      });
      if (deliveryBoy && removeFcmTokenFromDoc(deliveryBoy, cleanToken)) {
        await deliveryBoy.save();
        removedEntities.push("DeliveryBoy");
      }
    }

    return res.json({
      success: true,
      message: "FCM token removed successfully",
      entitiesUpdated: removedEntities
    });
  } catch (error) {
    console.error("Error removing FCM token:", error);
    return res.status(500).json({ success: false, message: "Failed to remove FCM token", error: error.message });
  }
};


