import express from "express";
import {
  registerUser,
  loginUser,
  sendOtp,
  verifyOtp,
  loginWithOtp,
  getUserByPhone,
  getUserProfile,
  updateUserProfile,
  addAddress,
  updateAddress,
  deleteAddress,
  forgotPassword,
  resetPassword,
  uploadUserAvatar,
  saveFcmToken,
  removeFcmToken
} from "../controllers/userAuthController.js";
import { protectUser, optionalUserAuth } from "../middlewares/auth.js";
import { uploadAvatar } from "../middlewares/upload.js";

const router = express.Router();

// Public auth routes
router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/send-otp", sendOtp);
router.post("/verify-otp", verifyOtp);
router.post("/login-with-otp", loginWithOtp);
router.get("/by-phone/:phone", getUserByPhone);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

// FCM Push Notification Token routes (Supports JWT or x-user-phone or body phone)
router.post("/fcm-token", optionalUserAuth, saveFcmToken);
router.delete("/fcm-token", optionalUserAuth, removeFcmToken);

// Profile and Address routes (Supports both JWT and x-user-phone headers)
router.get("/profile", optionalUserAuth, getUserProfile);
router.put("/profile", optionalUserAuth, updateUserProfile);
router.post("/upload-avatar", optionalUserAuth, uploadAvatar, uploadUserAvatar);
router.post("/addresses", optionalUserAuth, addAddress);
router.put("/addresses/:addressId", optionalUserAuth, updateAddress);
router.delete("/addresses/:addressId", optionalUserAuth, deleteAddress);


export default router;

