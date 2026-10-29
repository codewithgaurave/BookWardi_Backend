import mongoose from "mongoose";
import Seller from "../models/Seller.js";
import User from "../models/User.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { upsertFcmToken } from "../utils/fcmHelper.js";

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { sendFast2SmsOtp } from "../services/smsService.js";
import { broadcastRealtimeEvent } from "../services/realtimeService.js";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const sellerOtpStore = new Map();

// Helper: Convert Base64 data URL to physical file on disk (deduplicated by content hash)
export const saveBase64ToFile = (dataUrl, folder = "documents", fieldName = "doc") => {
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return dataUrl || "";
  }
  try {
    const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (!matches) return dataUrl || "";

    const mime = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, "base64");

    let ext = ".png";
    if (mime.includes("pdf")) ext = ".pdf";
    else if (mime.includes("jpeg") || mime.includes("jpg")) ext = ".jpg";
    else if (mime.includes("webp")) ext = ".webp";

    const targetSubfolder = folder === "avatars" ? "avatars" : (folder === "products" ? "products" : "documents");
    const uploadDir = path.join(process.cwd(), "uploads", targetSubfolder);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Hash the buffer content so identical images produce the exact same filename
    const hash = crypto.createHash("md5").update(buffer).digest("hex").slice(0, 16);
    const prefix = folder === "products" ? "prod" : fieldName;
    const filename = `${prefix}-${hash}${ext}`;
    const filePath = path.join(uploadDir, filename);

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, buffer);
    }

    return `/uploads/${targetSubfolder}/${filename}`;
  } catch (err) {
    console.error("saveBase64ToFile error:", err);
    return dataUrl || "";
  }
};

// Seller Registration (with KYC Document Uploads, Location & Delivery Preferences)
export const registerSeller = async (req, res) => {
  try {
    const rawPhone = String(req.body.phone || req.body.sellerPhone || "").trim();
    const cleanDigits = rawPhone.replace(/\D/g, "");
    const digits10 = cleanDigits.slice(-10);
    const phone = rawPhone || (digits10 ? `+91 ${digits10}` : "");

    // Check if user exists in User collection to auto-populate any missing fields
    let existingUser = null;
    if (digits10 || req.body.email || req.body.sellerEmail) {
      try {
        existingUser = await User.findOne({
          $or: [
            ...(digits10 ? [
              { phone: { $regex: digits10 } }
            ] : []),
            ...(req.body.email || req.body.sellerEmail ? [
              { email: String(req.body.email || req.body.sellerEmail).toLowerCase().trim() }
            ] : [])
          ]
        });
      } catch (uErr) {
        console.warn("User lookup error during seller registration:", uErr.message);
      }
    }

    const defaultAddress = existingUser?.addresses?.[0] || {};
    const fallbackAddr = [defaultAddress.addressLine, defaultAddress.street, defaultAddress.landmark].filter(Boolean).join(", ");

    const name = String(req.body.name || req.body.sellerName || req.body.ownerFullName || existingUser?.name || "Partner Merchant").trim();
    const storeName = String(req.body.storeName || req.body.tradeName || req.body.legalBusinessName || `${name}'s Vardi Store`).trim();
    const email = String(req.body.email || req.body.sellerEmail || existingUser?.email || (digits10 ? `seller_${digits10}@bookvardi.in` : "")).toLowerCase().trim();
    const password = req.body.password || "BookVardiSeller@123";
    const address = String(req.body.address || req.body.addressLine1 || req.body.registeredAddress || fallbackAddr || `${defaultAddress.city || 'Mirzapur'}, Uttar Pradesh`).trim();
    const city = String(req.body.city || defaultAddress.city || "Mirzapur").trim();
    const state = String(req.body.state || defaultAddress.state || "Uttar Pradesh").trim();
    const pincode = String(req.body.pincode || defaultAddress.pincode || "231301").trim();
    const gstNumber = req.body.gstNumber || req.body.gstin || "";
    const msmeRegistrationNumber = req.body.msmeRegistrationNumber || req.body.msmeNumber || req.body.msme || "";
    const cinNumber = req.body.cinNumber || req.body.cinRegistration || req.body.cin || "";
    const accountHolderName = req.body.accountHolderName || req.body.bankAccountHolder || "";
    const accountNumber = req.body.accountNumber || req.body.bankAccountNumber || "";
    const ifscCode = req.body.ifscCode || req.body.bankIfscCode || "";
    const bankName = req.body.bankName || "";
    const branchName = req.body.branchName || req.body.bankBranch || "";
    const aadhaarNumber = req.body.aadhaarNumber || req.body.ownerAadhaarLast4 || "";
    const panNumber = req.body.panNumber || req.body.ownerPan || req.body.businessPan || "";
    const yearStarted = req.body.yearStarted || "";

    // Validate required fields (with fallback guarantee)
    if (!name || !storeName || !email || !phone || !address || !city || !state || !pincode) {
      return res.status(400).json({
        message: "Please fill all required personal, store, and address fields."
      });
    }

    // Extract uploaded documents paths (supports multipart files AND base64 data URLs)
    const files = req.files || {};
    const aadhaarDoc = files.aadhaarDoc?.[0] ? `/uploads/documents/${files.aadhaarDoc[0].filename}` : saveBase64ToFile(req.body.aadhaarDoc, "documents", "aadhaar");
    const panDoc = files.panDoc?.[0] ? `/uploads/documents/${files.panDoc[0].filename}` : saveBase64ToFile(req.body.panDoc, "documents", "pan");
    const passbookDoc = files.passbookDoc?.[0] ? `/uploads/documents/${files.passbookDoc[0].filename}` : saveBase64ToFile(req.body.passbookDoc, "documents", "passbook");
    const shopDoc = files.shopDoc?.[0] ? `/uploads/documents/${files.shopDoc[0].filename}` : saveBase64ToFile(req.body.shopDoc, "documents", "shop");
    const addressProofDoc = files.addressProofDoc?.[0] ? `/uploads/documents/${files.addressProofDoc[0].filename}` : saveBase64ToFile(req.body.addressProofDoc, "documents", "addressProof");
    const profilePhoto = files.profilePhoto?.[0] ? `/uploads/documents/${files.profilePhoto[0].filename}` : (files.avatar?.[0] ? `/uploads/avatars/${files.avatar[0].filename}` : saveBase64ToFile(req.body.profilePhoto || req.body.avatar, "avatars", "profilePhoto"));

    // Check if seller email or phone already exists (matching any standard format)
    const existingSeller = await Seller.findOne({
      $or: [
        { email: email.toLowerCase() },
        { phone },
        ...(digits10 ? [
          { phone: cleanDigits },
          { phone: digits10 },
          { phone: `+91${digits10}` },
          { phone: `+91 ${digits10}` },
          { phone: { $regex: digits10 } }
        ] : [])
      ]
    });

    const ownerDetailsObj = {
      ownerFullName: req.body.ownerFullName || name || "",
      ownerDesignation: req.body.ownerDesignation || "Proprietor",
      ownerPan: req.body.ownerPan || req.body.businessPan || panNumber || "",
      ownerAadhaarLast4: req.body.ownerAadhaarLast4 || aadhaarNumber || ""
    };

    const addressDetailsObj = {
      addressLine1: req.body.addressLine1 || address || "",
      addressLine2: req.body.addressLine2 || "",
      landmark: req.body.landmark || "",
      country: req.body.country || "India"
    };

    const addressProofDetailsObj = {
      addressProofType: req.body.addressProofType || "",
      addressProofDocNumber: req.body.addressProofDocNumber || ""
    };

    const storeDetailsObj = {
      storeTagline: req.body.storeTagline || "",
      storeDescription: req.body.storeDescription || "",
      storeLogo: req.body.storeLogo || profilePhoto || ""
    };

    const catalogInfoObj = {
      selectedCategories: Array.isArray(req.body.selectedCategories) ? req.body.selectedCategories : [],
      primaryBrands: Array.isArray(req.body.primaryBrands) ? req.body.primaryBrands : [],
      estimatedSkuCount: req.body.estimatedSkuCount || "",
      sampleProductTitle: req.body.sampleProductTitle || ""
    };

    const agreementsObj = {
      acceptedTerms: req.body.acceptedTerms === true || req.body.acceptedTerms === "true",
      acceptedCommissionRate: req.body.acceptedCommissionRate === true || req.body.acceptedCommissionRate === "true",
      acceptedReturnPolicy: req.body.acceptedReturnPolicy === true || req.body.acceptedReturnPolicy === "true",
      authorizedSignatoryConfirmation: req.body.authorizedSignatoryConfirmation === true || req.body.authorizedSignatoryConfirmation === "true"
    };

    if (!passbookDoc && !existingSeller?.documents?.passbookDoc && !req.body.passbookDoc) {
      return res.status(400).json({
        success: false,
        message: "Bank Passbook or Cancelled Cheque document is mandatory for seller onboarding."
      });
    }

    if (!agreementsObj.acceptedTerms || !agreementsObj.acceptedCommissionRate || !agreementsObj.acceptedReturnPolicy) {
      return res.status(400).json({
        success: false,
        message: "All mandatory merchant agreements (Terms of Service, Commission Schedule, and Student Exchange Assurance) must be accepted before submitting."
      });
    }

    if (existingSeller) {
      existingSeller.name = name || existingSeller.name;
      existingSeller.storeName = storeName || existingSeller.storeName;
      existingSeller.address = address || existingSeller.address;
      existingSeller.city = city || existingSeller.city;
      existingSeller.state = state || existingSeller.state;
      existingSeller.pincode = pincode || existingSeller.pincode;
      existingSeller.gstNumber = gstNumber || existingSeller.gstNumber;
      existingSeller.msmeRegistrationNumber = msmeRegistrationNumber || existingSeller.msmeRegistrationNumber;
      existingSeller.cinNumber = cinNumber || existingSeller.cinNumber;
      existingSeller.yearStarted = yearStarted || existingSeller.yearStarted;
      existingSeller.businessType = req.body.businessType || existingSeller.businessType || "Proprietorship";
      existingSeller.annualTurnoverEstimate = req.body.annualTurnoverEstimate || existingSeller.annualTurnoverEstimate || "";
      existingSeller.ownerDetails = { ...existingSeller.ownerDetails, ...ownerDetailsObj };
      existingSeller.addressDetails = { ...existingSeller.addressDetails, ...addressDetailsObj };
      existingSeller.addressProofDetails = { ...existingSeller.addressProofDetails, ...addressProofDetailsObj };
      existingSeller.storeDetails = { ...existingSeller.storeDetails, ...storeDetailsObj };
      existingSeller.catalogInfo = { ...existingSeller.catalogInfo, ...catalogInfoObj };
      existingSeller.agreements = { ...existingSeller.agreements, ...agreementsObj };
      existingSeller.status = "pending";
      existingSeller.bankDetails = {
        accountHolderName: accountHolderName || existingSeller.bankDetails?.accountHolderName || "",
        accountNumber: accountNumber || existingSeller.bankDetails?.accountNumber || "",
        ifscCode: ifscCode || existingSeller.bankDetails?.ifscCode || "",
        bankName: bankName || existingSeller.bankDetails?.bankName || "",
        branchName: branchName || existingSeller.bankDetails?.branchName || "",
        accountType: req.body.accountType || existingSeller.bankDetails?.accountType || "Savings Account"
      };
      existingSeller.documents = {
        ...existingSeller.documents,
        aadhaarNumber: aadhaarNumber || existingSeller.documents?.aadhaarNumber || "",
        panNumber: panNumber || existingSeller.documents?.panNumber || "",
        msmeRegistrationNumber: msmeRegistrationNumber || existingSeller.documents?.msmeRegistrationNumber || "",
        cinNumber: cinNumber || existingSeller.documents?.cinNumber || "",
        addressProofDoc: addressProofDoc || existingSeller.documents?.addressProofDoc || "",
        passbookDoc: passbookDoc || existingSeller.documents?.passbookDoc || "",
        profilePhoto: profilePhoto || existingSeller.documents?.profilePhoto || ""
      };
      await existingSeller.save();

      // Synchronize User.sellerStatus to pending
      if (digits10 || email) {
        try {
          await User.updateMany(
            {
              $or: [
                ...(digits10 ? [{ phone: { $regex: digits10 } }] : []),
                { email: email.toLowerCase() }
              ]
            },
            { $set: { sellerStatus: "pending" } }
          );
        } catch (uErr) {
          console.warn("User sellerStatus sync error on update:", uErr.message);
        }
      }

      try {
        broadcastRealtimeEvent({
          type: "SELLER_REGISTERED",
          sellerId: existingSeller._id,
          storeName: existingSeller.storeName,
          status: existingSeller.status,
          timestamp: new Date().toISOString()
        });
      } catch (sseErr) {
        console.warn("SSE broadcast error:", sseErr.message);
      }

      return res.status(200).json({
        message: "Seller application updated successfully! Pending Admin review.",
        sellerId: existingSeller._id,
        storeName: existingSeller.storeName,
        status: existingSeller.status
      });
    }

    // Validate self delivery radius if self delivery is chosen
    const { selfDelivery, maxDeliveryRadiusKm, thirdPartyDelivery, latitude, longitude, formattedAddress } = req.body;
    const isSelfDelivery = selfDelivery === undefined || selfDelivery === true || selfDelivery === "true";
    const parsedRadius = (maxDeliveryRadiusKm !== undefined && maxDeliveryRadiusKm !== null && String(maxDeliveryRadiusKm).trim() !== "") ? parseFloat(maxDeliveryRadiusKm) : 10;
    if (isSelfDelivery && (isNaN(parsedRadius) || parsedRadius <= 0)) {
      return res.status(400).json({
        message: "Please specify a valid self-delivery radius in KM (e.g. 5, 10, 15 km)."
      });
    }

    // Parse coordinates if provided
    const lat = latitude ? parseFloat(latitude) : null;
    const lng = longitude ? parseFloat(longitude) : null;
    const geoCoordinates = (lng !== null && lat !== null) ? [lng, lat] : [0, 0];

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const newSeller = new Seller({
      name,
      storeName,
      email: email.toLowerCase(),
      phone,
      password: hashedPassword,
      address,
      city,
      state,
      pincode,
      yearStarted: yearStarted || "",
      businessType: req.body.businessType || "Proprietorship",
      annualTurnoverEstimate: req.body.annualTurnoverEstimate || "",
      ownerDetails: ownerDetailsObj,
      addressDetails: addressDetailsObj,
      addressProofDetails: addressProofDetailsObj,
      storeDetails: storeDetailsObj,
      catalogInfo: catalogInfoObj,
      agreements: agreementsObj,
      location: {
        latitude: lat,
        longitude: lng,
        formattedAddress: formattedAddress || address,
        geo: {
          type: "Point",
          coordinates: geoCoordinates
        }
      },
      gstNumber: gstNumber || "",
      msmeRegistrationNumber: msmeRegistrationNumber || "",
      cinNumber: cinNumber || "",
      deliveryPreferences: {
        selfDelivery: isSelfDelivery,
        maxDeliveryRadiusKm: parsedRadius,
        thirdPartyDelivery: thirdPartyDelivery === undefined ? true : (thirdPartyDelivery === true || thirdPartyDelivery === "true")
      },
      bankDetails: {
        accountHolderName: accountHolderName || "",
        accountNumber: accountNumber || "",
        ifscCode: ifscCode || "",
        bankName: bankName || "",
        branchName: branchName || "",
        accountType: req.body.accountType || "Savings Account"
      },
      documents: {
        aadhaarNumber: aadhaarNumber || "",
        aadhaarDoc,
        panNumber: panNumber || "",
        panDoc,
        msmeRegistrationNumber: msmeRegistrationNumber || "",
        cinNumber: cinNumber || "",
        passbookDoc,
        shopDoc,
        addressProofDoc,
        profilePhoto
      },
      status: "pending" // Default state: waiting for Admin review
    });

    await newSeller.save();

    // Synchronize User.sellerStatus to pending
    if (digits10 || email) {
      try {
        await User.updateMany(
          {
            $or: [
              ...(digits10 ? [{ phone: { $regex: digits10 } }] : []),
              { email: email.toLowerCase() }
            ]
          },
          { $set: { sellerStatus: "pending" } }
        );
      } catch (uErr) {
        console.warn("User sellerStatus sync error on register:", uErr.message);
      }
    }

    try {
      broadcastRealtimeEvent({
        type: "SELLER_REGISTERED",
        sellerId: newSeller._id,
        storeName: newSeller.storeName,
        status: newSeller.status,
        timestamp: new Date().toISOString()
      });
    } catch (sseErr) {
      console.warn("SSE broadcast error:", sseErr.message);
    }

    res.status(201).json({
      message: "Seller registered successfully! Your account is currently pending Admin review and approval.",
      sellerId: newSeller._id,
      storeName: newSeller.storeName,
      status: newSeller.status,
      location: newSeller.location,
      deliveryPreferences: newSeller.deliveryPreferences
    });
  } catch (error) {
    console.error("Seller registration error:", error);
    res.status(500).json({ message: "Registration failed", error: error.message });
  }
};

// Seller Login (Strict verification check: only approved sellers allowed)
export const loginSeller = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const seller = await Seller.findOne({ email: email.toLowerCase() });
    if (!seller) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const isMatch = await bcrypt.compare(password, seller.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    // Check Seller Approval Status
    if (seller.status === "pending") {
      return res.status(403).json({
        message: "Your seller account is pending admin approval. You will be able to log in once verified.",
        status: "pending"
      });
    }

    if (seller.status === "rejected") {
      return res.status(403).json({
        message: `Your seller application has been rejected. Reason: ${seller.rejectionReason || "Documents could not be verified."}`,
        status: "rejected",
        rejectionReason: seller.rejectionReason
      });
    }

    if (seller.status === "suspended") {
      return res.status(403).json({
        message: "Your seller account is suspended. Please contact support.",
        status: "suspended"
      });
    }

    if (req.body.fcmToken) {
      upsertFcmToken(seller, {
        fcmToken: req.body.fcmToken,
        platform: req.body.platform,
        deviceId: req.body.deviceId
      });
      await seller.save();
    }

    // If Approved, generate JWT Token
    const token = jwt.sign(
      {
        id: seller._id,
        email: seller.email,
        storeName: seller.storeName,
        role: "seller"
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful",
      token,
      seller: {
        id: seller._id,
        name: seller.name,
        storeName: seller.storeName,
        email: seller.email,
        phone: seller.phone,
        status: seller.status,
        role: "seller",
        location: seller.location,
        commissionRate: Number(seller.commissionRate ?? seller.commissionPercentage ?? 5),
        commissionPercentage: Number(seller.commissionPercentage ?? seller.commissionRate ?? 5)
      }
    });
  } catch (error) {
    console.error("Seller login error:", error);
    res.status(500).json({ message: "Login failed", error: error.message });
  }
};

// Get Logged-in Seller Profile
export const getSellerProfile = async (req, res) => {
  try {
    const isValidId = req.user?.id && mongoose.Types.ObjectId.isValid(req.user.id);
    let seller = isValidId ? await Seller.findById(req.user.id).select("-password") : null;

    if (!seller && req.headers["x-seller-id"] && mongoose.Types.ObjectId.isValid(req.headers["x-seller-id"])) {
      seller = await Seller.findById(req.headers["x-seller-id"]).select("-password");
    }

    if (!seller) {
      const phone = req.user?.phone || req.headers["x-seller-phone"] || req.headers["x-user-phone"] || req.query?.phone;
      if (phone) {
        const cleanPhone = String(phone).replace(/\D/g, "").slice(-10);
        if (cleanPhone) {
          seller = await Seller.findOne({
            $or: [
              { phone: cleanPhone },
              { phone: `+91${cleanPhone}` },
              { phone: `+91 ${cleanPhone}` },
              { phone: cleanPhone.slice(-10) }
            ]
          }).select("-password");
        }
      }
    }

    if (seller) {
      const sellerObj = seller.toObject ? seller.toObject() : { ...seller };
      let modified = false;
      if (sellerObj.documents) {
        ["aadhaarDoc", "panDoc", "passbookDoc", "shopDoc", "addressProofDoc", "profilePhoto"].forEach((key) => {
          if (sellerObj.documents[key] && typeof sellerObj.documents[key] === "string" && sellerObj.documents[key].startsWith("data:")) {
            sellerObj.documents[key] = saveBase64ToFile(sellerObj.documents[key], "documents", key);
            seller.documents[key] = sellerObj.documents[key];
            modified = true;
          }
        });
      }
      if (sellerObj.avatar && typeof sellerObj.avatar === "string" && sellerObj.avatar.startsWith("data:")) {
        sellerObj.avatar = saveBase64ToFile(sellerObj.avatar, "avatars", "avatar");
        seller.avatar = sellerObj.avatar;
        modified = true;
      }
      if (modified) {
        seller.markModified("documents");
        seller.save().catch(() => {});
      }
      sellerObj.commissionRate = Number(sellerObj.commissionRate ?? sellerObj.commissionPercentage ?? 5);
      sellerObj.commissionPercentage = sellerObj.commissionRate;
      return res.json(sellerObj);
    }

    if (req.seller) {
      const respSeller = req.seller.toObject ? req.seller.toObject() : { ...req.seller };
      respSeller.commissionRate = Number(respSeller.commissionRate ?? respSeller.commissionPercentage ?? 5);
      respSeller.commissionPercentage = respSeller.commissionRate;
      return res.json(respSeller);
    }

    // Unauthenticated or unverified fallback: return status: pending (NEVER auto-approve as guest)
    const requestPhone = req.headers["x-seller-phone"] || req.headers["x-user-phone"] || "";
    return res.status(200).json({
      _id: req.user?.id || "guest-seller",
      name: "Pending Applicant",
      storeName: "Pending Vardi Store",
      email: "applicant@bookvardi.in",
      phone: requestPhone || "",
      status: "pending",
      address: "Registration Address",
      city: "Lucknow",
      state: "Uttar Pradesh",
      pincode: "226001",
      commissionRate: 5,
      commissionPercentage: 5,
      deliveryPreferences: { selfDelivery: true, maxDeliveryRadiusKm: 10, thirdPartyDelivery: true }
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch seller profile", error: error.message });
  }
};

// Update Seller Profile (Store, Address, Location, Bank details, Avatar & Documents)
export const updateSellerProfile = async (req, res) => {
  try {
    const files = req.files || {};
    const {
      name,
      sellerName,
      ownerFullName,
      storeName,
      tradeName,
      legalBusinessName,
      phone,
      sellerPhone,
      email,
      sellerEmail,
      address,
      addressLine1,
      city,
      state,
      pincode,
      latitude,
      longitude,
      formattedAddress,
      deliveryPreferences,
      gstNumber,
      gstin,
      msmeRegistrationNumber,
      cinNumber,
      bankDetails,
      bankAccountHolder,
      bankAccountNumber,
      bankIfscCode,
      bankName,
      bankBranch,
      branchName,
      yearStarted,
      designation,
      ownerDesignation,
      avatar,
      profilePhoto,
      documents
    } = req.body;

    const seller = await Seller.findById(req.user.id);
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    const updates = {};
    const finalName = name || sellerName || ownerFullName;
    if (finalName) updates.name = finalName;
    const finalStoreName = storeName || tradeName || legalBusinessName;
    if (finalStoreName) updates.storeName = finalStoreName;
    const finalPhone = phone || sellerPhone;
    if (finalPhone) updates.phone = finalPhone;
    const finalEmail = email || sellerEmail;
    if (finalEmail) updates.email = finalEmail.toLowerCase();
    const finalAddress = address || addressLine1;
    if (finalAddress) updates.address = finalAddress;
    if (city) updates.city = city;
    if (state) updates.state = state;
    if (pincode) updates.pincode = pincode;
    if (gstNumber !== undefined || gstin !== undefined) updates.gstNumber = gstNumber || gstin || "";
    if (msmeRegistrationNumber !== undefined) {
      updates.msmeRegistrationNumber = msmeRegistrationNumber;
    }
    if (cinNumber !== undefined) {
      updates.cinNumber = cinNumber;
    }
    const finalYearStarted = yearStarted || req.body.establishedYear || req.body.yearEstablished;
    if (finalYearStarted) updates.yearStarted = finalYearStarted;
    if (req.body.businessType) updates.businessType = req.body.businessType;
    if (req.body.annualTurnoverEstimate) updates.annualTurnoverEstimate = req.body.annualTurnoverEstimate;

    // Detailed Address Info (Line 1, Line 2 / Colony, Landmark)
    const finalLine1 = addressLine1 || address || seller.addressDetails?.addressLine1 || seller.address || "";
    const finalLine2 = req.body.addressLine2 || req.body.colony || seller.addressDetails?.addressLine2 || "";
    const finalLandmark = req.body.landmark || seller.addressDetails?.landmark || "";

    updates.addressDetails = {
      addressLine1: finalLine1,
      addressLine2: finalLine2,
      landmark: finalLandmark,
      country: req.body.country || seller.addressDetails?.country || "India"
    };

    if (ownerFullName || designation || ownerDesignation || req.body.ownerPan || req.body.ownerAadhaarLast4) {
      updates.ownerDetails = {
        ownerFullName: ownerFullName || finalName || seller.ownerDetails?.ownerFullName || seller.name || "",
        ownerDesignation: designation || ownerDesignation || seller.ownerDetails?.ownerDesignation || "Proprietor",
        ownerPan: req.body.ownerPan || req.body.businessPan || seller.ownerDetails?.ownerPan || "",
        ownerAadhaarLast4: req.body.ownerAadhaarLast4 || req.body.aadhaarNumber || seller.ownerDetails?.ownerAadhaarLast4 || ""
      };
    }

    // Bank Details update & Critical KYC verification check
    let isCriticalDetailChanged = false;

    if (bankDetails || bankAccountHolder || bankAccountNumber || bankIfscCode || bankName || bankBranch || branchName || req.body.accountType) {
      const newBankDetails = {
        accountHolderName: bankDetails?.accountHolderName || bankDetails?.bankAccountHolder || bankAccountHolder || seller.bankDetails?.accountHolderName || "",
        accountNumber: bankDetails?.accountNumber || bankDetails?.bankAccountNumber || bankAccountNumber || seller.bankDetails?.accountNumber || "",
        ifscCode: bankDetails?.ifscCode || bankDetails?.bankIfscCode || bankIfscCode || seller.bankDetails?.ifscCode || "",
        bankName: bankDetails?.bankName || bankName || seller.bankDetails?.bankName || "",
        branchName: bankDetails?.branchName || bankDetails?.bankBranch || bankBranch || branchName || seller.bankDetails?.branchName || "",
        accountType: bankDetails?.accountType || req.body.accountType || seller.bankDetails?.accountType || "Savings Account"
      };

      const oldAcct = String(seller.bankDetails?.accountNumber || "").trim();
      const newAcct = String(newBankDetails.accountNumber || "").trim();
      const oldIfsc = String(seller.bankDetails?.ifscCode || "").trim().toUpperCase();
      const newIfsc = String(newBankDetails.ifscCode || "").trim().toUpperCase();
      const oldHolder = String(seller.bankDetails?.accountHolderName || "").trim().toLowerCase();
      const newHolder = String(newBankDetails.accountHolderName || "").trim().toLowerCase();

      // If bank account was already present and payout destination details changed, or new bank details added:
      if (newAcct && (!oldAcct || newAcct !== oldAcct || newIfsc !== oldIfsc || (newHolder && newHolder !== oldHolder))) {
        isCriticalDetailChanged = true;
      }

      updates.bankDetails = newBankDetails;
    }

    if (deliveryPreferences) updates.deliveryPreferences = deliveryPreferences;

    // Documents & Images processing (supports multipart attachments AND base64 data URLs)
    const docUpdates = { ...(seller.documents || {}) };

    let uploadedAvatar = files.avatar?.[0] ? `/uploads/avatars/${files.avatar[0].filename}` : (files.profilePhoto?.[0] ? `/uploads/documents/${files.profilePhoto[0].filename}` : null);
    if (!uploadedAvatar && avatar) uploadedAvatar = saveBase64ToFile(avatar, "avatars", "avatar");
    if (!uploadedAvatar && profilePhoto) uploadedAvatar = saveBase64ToFile(profilePhoto, "avatars", "profilePhoto");
    if (!uploadedAvatar && documents?.profilePhoto) uploadedAvatar = saveBase64ToFile(documents.profilePhoto, "avatars", "profilePhoto");

    if (uploadedAvatar) {
      updates.avatar = uploadedAvatar;
      docUpdates.profilePhoto = uploadedAvatar;
    }

    let uploadedAddressProof = files.addressProofDoc?.[0] ? `/uploads/documents/${files.addressProofDoc[0].filename}` : null;
    if (!uploadedAddressProof && req.body.addressProofDoc) uploadedAddressProof = saveBase64ToFile(req.body.addressProofDoc, "documents", "addressProof");
    if (!uploadedAddressProof && documents?.addressProofDoc) uploadedAddressProof = saveBase64ToFile(documents.addressProofDoc, "documents", "addressProof");
    if (uploadedAddressProof) {
      docUpdates.addressProofDoc = uploadedAddressProof;
    }

    let uploadedPassbook = files.passbookDoc?.[0] ? `/uploads/documents/${files.passbookDoc[0].filename}` : null;
    if (!uploadedPassbook && req.body.passbookDoc) uploadedPassbook = saveBase64ToFile(req.body.passbookDoc, "documents", "passbook");
    if (!uploadedPassbook && documents?.passbookDoc) uploadedPassbook = saveBase64ToFile(documents.passbookDoc, "documents", "passbook");
    if (uploadedPassbook) {
      docUpdates.passbookDoc = uploadedPassbook;
      isCriticalDetailChanged = true;
    }

    let uploadedAadhaar = files.aadhaarDoc?.[0] ? `/uploads/documents/${files.aadhaarDoc[0].filename}` : null;
    if (!uploadedAadhaar && req.body.aadhaarDoc) uploadedAadhaar = saveBase64ToFile(req.body.aadhaarDoc, "documents", "aadhaar");
    if (uploadedAadhaar) docUpdates.aadhaarDoc = uploadedAadhaar;

    let uploadedPan = files.panDoc?.[0] ? `/uploads/documents/${files.panDoc[0].filename}` : null;
    if (!uploadedPan && req.body.panDoc) uploadedPan = saveBase64ToFile(req.body.panDoc, "documents", "pan");
    if (uploadedPan) docUpdates.panDoc = uploadedPan;

    if (req.body.aadhaarNumber || req.body.ownerAadhaarLast4) {
      docUpdates.aadhaarNumber = req.body.aadhaarNumber || req.body.ownerAadhaarLast4;
    }
    if (req.body.panNumber || req.body.ownerPan || req.body.businessPan || req.body.pan) {
      const oldPan = String(seller.documents?.panNumber || "").trim().toUpperCase();
      const newPan = String(req.body.panNumber || req.body.ownerPan || req.body.businessPan || req.body.pan || "").trim().toUpperCase();
      if (oldPan && newPan && oldPan !== newPan) isCriticalDetailChanged = true;
      docUpdates.panNumber = newPan;
    }
    if (msmeRegistrationNumber !== undefined) docUpdates.msmeRegistrationNumber = msmeRegistrationNumber;
    if (cinNumber !== undefined) docUpdates.cinNumber = cinNumber;

    // Check if GSTIN changed
    const oldGst = String(seller.gstNumber || "").trim().toUpperCase();
    const newGst = String(updates.gstNumber || "").trim().toUpperCase();
    if (oldGst && newGst && oldGst !== newGst) {
      isCriticalDetailChanged = true;
    }

    updates.documents = docUpdates;

    // If Bank Details, Cheque / Passbook, GSTIN, or PAN changed on an active seller,
    // require Admin Approval before activating the new payout credentials!
    if (isCriticalDetailChanged) {
      updates.status = "pending";
      updates.bankVerificationStatus = "pending";
      updates.rejectionReason = "";
    }

    // Location update
    if (latitude !== undefined && longitude !== undefined) {
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      updates.location = {
        latitude: lat,
        longitude: lng,
        formattedAddress: formattedAddress || address || seller.address || "",
        geo: {
          type: "Point",
          coordinates: [lng, lat]
        }
      };
    }

    const updatedSeller = await Seller.findByIdAndUpdate(req.user.id, updates, {
      new: true
    }).select("-password");

    // Also synchronize user.sellerStatus if status was changed to pending
    if (updates.status === "pending") {
      try {
        const cleanDigits = String(updatedSeller.phone || "").replace(/\D/g, "").slice(-10);
        await User.updateMany(
          {
            $or: [
              ...(cleanDigits ? [{ phone: { $regex: cleanDigits } }] : []),
              { email: updatedSeller.email.toLowerCase() }
            ]
          },
          { $set: { sellerStatus: "pending" } }
        );
      } catch (uErr) {
        console.warn("User sellerStatus sync error on bank update:", uErr.message);
      }
    }

    try {
      broadcastRealtimeEvent({
        type: updates.status === "pending" ? "SELLER_STATUS_CHANGED" : "SELLER_UPDATED",
        sellerId: updatedSeller._id,
        storeName: updatedSeller.storeName,
        status: updatedSeller.status,
        timestamp: new Date().toISOString()
      });
    } catch (sseErr) {
      console.warn("SSE broadcast error:", sseErr.message);
    }

    const responseMessage = updates.status === "pending"
      ? "Bank account / KYC details updated! Your account is now pending Admin approval before payout settlements are activated."
      : "Profile updated successfully";

    res.json({
      success: true,
      message: responseMessage,
      requiresAdminApproval: updates.status === "pending",
      seller: updatedSeller
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update profile", error: error.message });
  }
};

// Get Seller Store Operations Settings
export const getSellerSettings = async (req, res) => {
  try {
    const isValidId = req.user?.id && mongoose.Types.ObjectId.isValid(req.user.id);
    let seller = isValidId ? await Seller.findById(req.user.id).select(
      "storeName name email phone address city state pincode gstNumber deliveryPreferences bankDetails storeDetails"
    ) : null;

    if (!seller) {
      const phone = req.user?.phone || req.headers["x-seller-phone"] || req.headers["x-user-phone"] || req.query?.phone;
      if (phone) {
        const cleanPhone = String(phone).replace(/\D/g, "").slice(-10);
        if (cleanPhone) {
          seller = await Seller.findOne({
            $or: [
              { phone: cleanPhone },
              { phone: `+91${cleanPhone}` },
              { phone: `+91 ${cleanPhone}` },
              { phone: cleanPhone.slice(-10) },
              { phone: { $regex: cleanPhone } }
            ]
          }).select(
            "storeName name email phone address city state pincode gstNumber deliveryPreferences bankDetails storeDetails"
          );
        }
      }
    }

    if (seller) {
      return res.json({
        storeName: seller.storeName,
        legalName: seller.name,
        email: seller.email,
        phone: seller.phone,
        gstin: seller.gstNumber,
        address: seller.address,
        city: seller.city,
        pincode: seller.pincode,
        yearStarted: seller.yearStarted || "",
        deliveryPreferences: seller.deliveryPreferences,
        bankDetails: seller.bankDetails,
        storeDetails: seller.storeDetails || {}
      });
    }

    if (req.seller) {
      return res.json({
        storeName: req.seller.storeName || "",
        legalName: req.seller.name || "",
        email: req.seller.email || "",
        phone: req.seller.phone || "",
        gstin: req.seller.gstNumber || "",
        address: req.seller.address || "",
        city: req.seller.city || "",
        pincode: req.seller.pincode || "",
        deliveryPreferences: req.seller.deliveryPreferences || {},
        bankDetails: req.seller.bankDetails || {},
        storeDetails: req.seller.storeDetails || {}
      });
    }

    // Default settings response for unauthenticated / pending sellers
    const reqPhone = req.headers["x-seller-phone"] || req.headers["x-user-phone"] || "";
    return res.json({
      storeName: "Pending Vardi Store",
      legalName: "Pending Merchant",
      email: "applicant@bookvardi.in",
      phone: reqPhone || "",
      gstin: "",
      address: "Registration Address",
      city: "Lucknow",
      pincode: "226001",
      deliveryPreferences: { selfDelivery: true, maxDeliveryRadiusKm: 10, thirdPartyDelivery: true },
      bankDetails: {},
      storeDetails: {}
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch seller settings", error: error.message });
  }
};

// Update Seller Store Operations Settings
export const updateSellerSettings = async (req, res) => {
  try {
    const seller = await Seller.findById(req.user.id);
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    const {
      storeName,
      storeTagline,
      sellerLegalName,
      gstin,
      email,
      phone,
      warehouseAddress,
      address,
      city,
      pincode,
      pickupContact,
      deliveryPreferences,
      storeDetails,
      autoAcceptOrders,
      emailNotifications,
      smsNotifications
    } = req.body;

    const requestedUpdates = {
      storeName: storeName !== undefined ? storeName : (seller.storeName || ""),
      storeTagline: storeTagline !== undefined ? storeTagline : (seller.storeDetails?.storeTagline || ""),
      sellerLegalName: sellerLegalName !== undefined ? sellerLegalName : (seller.ownerDetails?.ownerFullName || seller.name || ""),
      gstin: gstin !== undefined ? gstin : (seller.gstNumber || ""),
      email: email !== undefined ? email : (seller.email || ""),
      phone: phone !== undefined ? phone : (seller.phone || ""),
      warehouseAddress: warehouseAddress !== undefined ? warehouseAddress : (address || seller.address || ""),
      address: address !== undefined ? address : (warehouseAddress || seller.address || ""),
      pickupContact: pickupContact !== undefined ? pickupContact : "",
      city: city || seller.city || "",
      pincode: pincode || seller.pincode || "",
      deliveryPreferences: deliveryPreferences || seller.deliveryPreferences || {},
      storeDetails: storeDetails || seller.storeDetails || {},
      autoAcceptOrders: autoAcceptOrders !== undefined ? autoAcceptOrders : true,
      emailNotifications: emailNotifications !== undefined ? emailNotifications : true,
      smsNotifications: smsNotifications !== undefined ? smsNotifications : true,
      submittedAt: new Date(),
      previousData: {
        storeName: seller.storeName || "",
        storeTagline: seller.storeDetails?.storeTagline || "",
        sellerLegalName: seller.ownerDetails?.ownerFullName || seller.name || "",
        gstin: seller.gstNumber || "",
        email: seller.email || "",
        phone: seller.phone || "",
        warehouseAddress: seller.address || ""
      }
    };

    // If seller is already approved, changes REQUIRE ADMIN APPROVAL!
    if (seller.status === "approved") {
      seller.pendingUpdates = requestedUpdates;
      seller.pendingUpdatesSubmittedAt = new Date();
      seller.pendingUpdatesStatus = "pending_review";
      await seller.save();

      return res.json({
        success: true,
        requiresApproval: true,
        message: "Aapki profile update request submit ho gayi hai aur approval ke liye Admin Portal par bhej di gayi hai. Admin verify karne ke baad ye changes live ho jayenge.",
        pendingUpdates: requestedUpdates,
        seller: await Seller.findById(seller._id).select("-password")
      });
    }

    // For unverified/pending onboarding sellers, updates apply directly
    if (storeName) seller.storeName = storeName;
    if (phone) seller.phone = phone;
    if (gstin) seller.gstNumber = gstin;
    if (address || warehouseAddress) seller.address = address || warehouseAddress;
    if (city) seller.city = city;
    if (pincode) seller.pincode = pincode;
    if (deliveryPreferences) seller.deliveryPreferences = deliveryPreferences;
    if (storeDetails) seller.storeDetails = storeDetails;
    if (storeTagline) {
      if (!seller.storeDetails) seller.storeDetails = {};
      seller.storeDetails.storeTagline = storeTagline;
    }
    if (sellerLegalName) {
      if (!seller.ownerDetails) seller.ownerDetails = {};
      seller.ownerDetails.ownerFullName = sellerLegalName;
    }

    await seller.save();

    res.json({
      success: true,
      requiresApproval: false,
      message: "Store settings updated successfully",
      seller: await Seller.findById(seller._id).select("-password")
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update seller settings", error: error.message });
  }
};

// Find Nearby Approved Sellers (Geo Proximity Search)
export const getNearbySellers = async (req, res) => {
  try {
    const { lat, lng, radiusInKm = 15 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({
        message: "Customer latitude (lat) and longitude (lng) query parameters are required."
      });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const maxDistanceInMeters = parseFloat(radiusInKm) * 1000; // convert km to meters

    // Find sellers near customer coordinates with 2dsphere near query
    const nearbySellers = await Seller.find({
      status: "approved",
      "location.geo": {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [longitude, latitude]
          },
          $maxDistance: maxDistanceInMeters
        }
      }
    }).select("name storeName email phone address city state pincode location");

    res.json({
      count: nearbySellers.length,
      radiusInKm: parseFloat(radiusInKm),
      sellers: nearbySellers
    });
  } catch (error) {
    console.error("Nearby sellers error:", error);
    res.status(500).json({ message: "Failed to search nearby sellers", error: error.message });
  }
};

// Send Phone OTP for Seller Login & Onboarding (Requires existing registered seller phone)
export const sendSellerPhoneOtp = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: "Phone number is required." });
    }
    const cleanPhone = String(phone).replace(/\D/g, "");
    if (!cleanPhone || cleanPhone.length < 8) {
      return res.status(400).json({ success: false, message: "Please enter a valid seller mobile phone number." });
    }

    const digits10 = cleanPhone.slice(-10);
    const isRegistration = Boolean(req.body.isRegistration);
    const seller = await Seller.findOne({
      $or: [
        { phone: cleanPhone },
        { phone: `+91${digits10}` },
        { phone: `+91 ${digits10}` },
        { phone: digits10 },
        { phone: { $regex: digits10 } }
      ]
    }).select("status storeName name phone rejectionReason otpCode otpExpiresAt");

    if (!seller && !isRegistration) {
      return res.status(404).json({
        success: false,
        exists: false,
        message: `No seller account found with mobile number +91 ${digits10}. Please register as a new seller first.`
      });
    }

    // Generate real 4-digit OTP
    const freshOtp = Math.floor(1000 + Math.random() * 9000).toString();
    sellerOtpStore.set(digits10, {
      otp: freshOtp,
      expires: Date.now() + 15 * 60 * 1000 // 15 mins
    });

    if (seller) {
      try {
        seller.otpCode = freshOtp;
        seller.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await seller.save();
      } catch (err) {
        console.warn("Failed to persist OTP to seller doc:", err.message);
      }
    }

    let smsDispatched = false;
    try {
      const smsRes = await sendFast2SmsOtp(digits10, freshOtp);
      smsDispatched = Boolean(smsRes?.success);
      if (smsDispatched) {
        console.log(`📲 [SELLER AUTH] Fast2SMS OTP dispatched to +91 ${digits10}`);
      } else {
        console.warn(`⚠️ [SELLER AUTH] Fast2SMS dispatch warning for +91 ${digits10}:`, smsRes?.error || smsRes?.message);
      }
    } catch (smsErr) {
      console.warn("⚠️ [SELLER AUTH] Fast2SMS dispatch error:", smsErr.message);
    }

    const maskedPhone = digits10.slice(-4).padStart(10, 'X');
    res.json({
      success: true,
      exists: Boolean(seller),
      status: seller ? seller.status : "registration",
      message: `OTP sent successfully to registered mobile +91 ${maskedPhone}`,
      smsSent: smsDispatched
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to send OTP", error: error.message });
  }
};

// Verify Phone OTP & Authenticate Seller
export const verifySellerPhoneOtp = async (req, res) => {
  try {
    const { phone, otp, isRegistration } = req.body;
    const cleanPhone = (phone || "").replace(/\D/g, "");

    if (!cleanPhone || cleanPhone.length < 8) {
      return res.status(400).json({ message: "Please enter a valid mobile number." });
    }

    if (!otp) {
      return res.status(400).json({ message: "OTP code is required." });
    }

    const inputOtp = String(otp).trim();
    const digits10 = cleanPhone.slice(-10);

    const storedOtpObj = sellerOtpStore.get(digits10);
    const isValidStoredOtp = storedOtpObj && storedOtpObj.otp === inputOtp && Date.now() <= storedOtpObj.expires;

    let seller = await Seller.findOne({
      $or: [
        { phone: cleanPhone },
        { phone: `+91${digits10}` },
        { phone: `+91 ${digits10}` },
        { phone: digits10 },
        { phone: { $regex: digits10 } }
      ]
    }).select("-password -documents");

    const isValidDbOtp = seller && seller.otpCode && seller.otpCode === inputOtp && seller.otpExpiresAt && new Date(seller.otpExpiresAt) >= new Date();

    if (!isValidStoredOtp && !isValidDbOtp) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP. Please enter the correct OTP received on your mobile."
      });
    }

    // Clear used OTP
    sellerOtpStore.delete(digits10);
    if (seller) {
      try {
        seller.otpCode = "";
        seller.otpExpiresAt = null;
        await seller.save();
      } catch (err) {}
    }

    if (isRegistration || !seller) {
      return res.json({
        success: true,
        verified: true,
        message: "Mobile number verified successfully via OTP!"
      });
    }

    const token = jwt.sign(
      { id: seller._id, email: seller.email, storeName: seller.storeName, role: "seller" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      message: "Phone OTP verified successfully",
      token,
      status: seller.status,
      sellerStatus: seller.status,
      approvalStatus: seller.status,
      seller: {
        id: seller._id,
        name: seller.name,
        storeName: seller.storeName,
        email: seller.email,
        phone: seller.phone,
        status: seller.status,
        approvalStatus: seller.status
      }
    });
  } catch (error) {
    res.status(500).json({ message: "OTP verification failed", error: error.message });
  }
};

// Get Application Status for Logged-in Seller
export const getSellerApplicationStatus = async (req, res) => {
  try {
    let seller = null;
    const isValidId = req.user?.id && mongoose.Types.ObjectId.isValid(req.user.id);
    if (isValidId) {
      seller = await Seller.findById(req.user.id).select("status storeName name phone commissionRate commissionPercentage rejectionReason");
    }

    if (!seller && req.headers["x-seller-id"] && mongoose.Types.ObjectId.isValid(req.headers["x-seller-id"])) {
      seller = await Seller.findById(req.headers["x-seller-id"]).select("status storeName name phone commissionRate commissionPercentage rejectionReason");
    }

    let rawPhone = req.query?.phone || req.body?.phone || req.user?.phone || req.seller?.phone || req.headers["x-seller-phone"] || req.headers["x-user-phone"];
    if (rawPhone === "undefined" || rawPhone === "null" || rawPhone === "[object Object]") rawPhone = null;
    const phone = rawPhone;
    if (!seller && phone) {
      const cleanPhone = String(phone).trim();
      const rawDigits = cleanPhone.replace(/\D/g, "");
      const digits10 = rawDigits.slice(-10);
      seller = await Seller.findOne({
        $or: [
          { phone: cleanPhone },
          { phone: rawDigits },
          ...(digits10 ? [{ phone: { $regex: digits10 + "$" } }] : [])
        ]
      }).select("status storeName name phone commissionRate commissionPercentage rejectionReason");
    }

    if (!seller && req.seller) {
      seller = req.seller;
    }

    if (seller) {
      const currentStatus = seller.status || seller.submissionStatus || "pending";
      const commRate = Number(seller.commissionRate ?? seller.commissionPercentage ?? 5);
      return res.json({
        success: true,
        status: currentStatus,
        sellerStatus: currentStatus,
        approvalStatus: currentStatus,
        storeName: seller.storeName || "",
        name: seller.name || "",
        phone: seller.phone || "",
        commissionRate: commRate,
        commissionPercentage: commRate,
        rejectionReason: seller.rejectionReason || null
      });
    }

    // Default status to prevent 404 console errors
    return res.json({
      success: true,
      status: "pending",
      sellerStatus: "pending",
      approvalStatus: "pending",
      storeName: "Partner Merchant",
      name: "Partner Merchant",
      phone: phone || "",
      rejectionReason: null
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch status", error: error.message });
  }
};

// Instant Admin Approval Testing Shortcut
export const adminApproveSellerTest = async (req, res) => {
  try {
    const sellerId = req.user ? req.user.id : req.body.sellerId;
    const seller = await Seller.findByIdAndUpdate(
      sellerId,
      { status: "approved", approvedAt: new Date() },
      { new: true }
    );
    if (!seller) return res.status(404).json({ message: "Seller not found" });

    res.json({
      success: true,
      message: "Seller status updated to approved!",
      sellerStatus: seller.status
    });
  } catch (error) {
    res.status(500).json({ message: "Approval failed", error: error.message });
  }
};

// Update Pending/Unapproved Seller 12-Step Application Details
export const updateSellerApplication = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const {
      sellerName,
      legalBusinessName,
      tradeName,
      sellerPhone,
      sellerEmail,
      ownerFullName,
      ownerDesignation,
      ownerPan,
      businessPan,
      gstin,
      addressLine1,
      city,
      state,
      pincode,
      bankAccountHolder,
      bankAccountNumber,
      bankIfscCode,
      bankName,
      bankBranch,
      branchName,
      yearStarted
    } = req.body;

    const files = req.files || {};
    const updates = {
      name: sellerName || ownerFullName,
      storeName: tradeName || legalBusinessName,
      email: sellerEmail ? sellerEmail.toLowerCase() : undefined,
      phone: sellerPhone,
      address: addressLine1,
      city,
      state,
      pincode,
      gstNumber: gstin,
      yearStarted,
      status: "pending" // Resubmit resets status to pending for review
    };

    // Clean undefined fields
    Object.keys(updates).forEach(key => updates[key] === undefined && delete updates[key]);

    if (bankAccountHolder || bankAccountNumber || bankIfscCode || bankName || bankBranch || branchName) {
      updates.bankDetails = {
        accountHolderName: bankAccountHolder || req.body.accountHolderName || "",
        accountNumber: bankAccountNumber || req.body.accountNumber || "",
        ifscCode: bankIfscCode || req.body.ifscCode || "",
        bankName: bankName || req.body.bankName || "",
        branchName: branchName || bankBranch || req.body.branchName || req.body.bankBranch || ""
      };
    }

    const existingSeller = await Seller.findById(sellerId);
    if (!existingSeller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    if (req.body.businessType) updates.businessType = req.body.businessType;
    if (req.body.annualTurnoverEstimate) updates.annualTurnoverEstimate = req.body.annualTurnoverEstimate;

    updates.ownerDetails = {
      ownerFullName: ownerFullName || req.body.name || existingSeller.ownerDetails?.ownerFullName || existingSeller.name || "",
      ownerDesignation: ownerDesignation || existingSeller.ownerDetails?.ownerDesignation || "Proprietor",
      ownerPan: ownerPan || businessPan || req.body.pan || existingSeller.ownerDetails?.ownerPan || "",
      ownerAadhaarLast4: req.body.ownerAadhaarLast4 || req.body.aadhaarNumber || existingSeller.ownerDetails?.ownerAadhaarLast4 || ""
    };

    updates.addressDetails = {
      addressLine1: addressLine1 || req.body.address || existingSeller.addressDetails?.addressLine1 || existingSeller.address || "",
      addressLine2: req.body.addressLine2 || existingSeller.addressDetails?.addressLine2 || "",
      landmark: req.body.landmark || existingSeller.addressDetails?.landmark || "",
      country: req.body.country || existingSeller.addressDetails?.country || "India"
    };

    if (req.body.addressProofType || req.body.addressProofDocNumber) {
      updates.addressProofDetails = {
        addressProofType: req.body.addressProofType || existingSeller.addressProofDetails?.addressProofType || "",
        addressProofDocNumber: req.body.addressProofDocNumber || existingSeller.addressProofDetails?.addressProofDocNumber || ""
      };
    }

    if (tradeName || legalBusinessName || req.body.storeTagline || req.body.storeDescription || req.body.storeLogo) {
      updates.storeDetails = {
        storeTagline: req.body.storeTagline || existingSeller.storeDetails?.storeTagline || "",
        storeDescription: req.body.storeDescription || existingSeller.storeDetails?.storeDescription || "",
        storeLogo: req.body.storeLogo || existingSeller.storeDetails?.storeLogo || ""
      };
    }

    if (req.body.selectedCategories || req.body.primaryBrands || req.body.estimatedSkuCount || req.body.sampleProductTitle) {
      updates.catalogInfo = {
        selectedCategories: Array.isArray(req.body.selectedCategories) ? req.body.selectedCategories : (existingSeller.catalogInfo?.selectedCategories || []),
        primaryBrands: Array.isArray(req.body.primaryBrands) ? req.body.primaryBrands : (existingSeller.catalogInfo?.primaryBrands || []),
        estimatedSkuCount: req.body.estimatedSkuCount || existingSeller.catalogInfo?.estimatedSkuCount || "",
        sampleProductTitle: req.body.sampleProductTitle || existingSeller.catalogInfo?.sampleProductTitle || ""
      };
    }

    if (req.body.acceptedTerms !== undefined || req.body.acceptedCommissionRate !== undefined) {
      updates.agreements = {
        acceptedTerms: req.body.acceptedTerms === true || req.body.acceptedTerms === "true" || Boolean(existingSeller.agreements?.acceptedTerms),
        acceptedCommissionRate: req.body.acceptedCommissionRate === true || req.body.acceptedCommissionRate === "true" || Boolean(existingSeller.agreements?.acceptedCommissionRate),
        acceptedReturnPolicy: req.body.acceptedReturnPolicy === true || req.body.acceptedReturnPolicy === "true" || Boolean(existingSeller.agreements?.acceptedReturnPolicy),
        authorizedSignatoryConfirmation: req.body.authorizedSignatoryConfirmation === true || req.body.authorizedSignatoryConfirmation === "true" || Boolean(existingSeller.agreements?.authorizedSignatoryConfirmation)
      };
    }

    if (bankAccountHolder || bankAccountNumber || bankIfscCode || bankName || bankBranch || branchName || req.body.accountType) {
      updates.bankDetails = {
        accountHolderName: bankAccountHolder || req.body.accountHolderName || existingSeller.bankDetails?.accountHolderName || "",
        accountNumber: bankAccountNumber || req.body.accountNumber || existingSeller.bankDetails?.accountNumber || "",
        ifscCode: bankIfscCode || req.body.ifscCode || existingSeller.bankDetails?.ifscCode || "",
        bankName: bankName || req.body.bankName || existingSeller.bankDetails?.bankName || "",
        branchName: branchName || bankBranch || req.body.branchName || req.body.bankBranch || existingSeller.bankDetails?.branchName || "",
        accountType: req.body.accountType || existingSeller.bankDetails?.accountType || "Savings Account"
      };
    }

    const docUpdates = { ...(existingSeller?.documents || {}) };

    let uploadedProfile = files.profilePhoto?.[0] ? `/uploads/documents/${files.profilePhoto[0].filename}` : (files.avatar?.[0] ? `/uploads/avatars/${files.avatar[0].filename}` : saveBase64ToFile(req.body.profilePhoto || req.body.avatar, "avatars", "profilePhoto"));
    if (uploadedProfile) {
      docUpdates.profilePhoto = uploadedProfile;
      updates.avatar = uploadedProfile;
    }

    let uploadedAddressProof = files.addressProofDoc?.[0] ? `/uploads/documents/${files.addressProofDoc[0].filename}` : saveBase64ToFile(req.body.addressProofDoc, "documents", "addressProof");
    if (uploadedAddressProof) docUpdates.addressProofDoc = uploadedAddressProof;

    if (ownerPan || businessPan) docUpdates.panNumber = ownerPan || businessPan;
    updates.documents = docUpdates;

    const updatedSeller = await Seller.findByIdAndUpdate(sellerId, updates, { new: true });

    try {
      broadcastRealtimeEvent({
        type: "SELLER_UPDATED",
        sellerId: updatedSeller._id,
        storeName: updatedSeller.storeName,
        status: updatedSeller.status,
        timestamp: new Date().toISOString()
      });
    } catch (sseErr) {
      console.warn("SSE broadcast error:", sseErr.message);
    }

    res.json({
      success: true,
      message: "Seller application updated successfully! Pending review.",
      sellerStatus: updatedSeller.status,
      seller: updatedSeller
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update application", error: error.message });
  }
};

// Upload Base64 File directly to Physical Server Disk (uploads/avatars or uploads/documents)
export const uploadBase64Document = async (req, res) => {
  try {
    const dataUrl = req.body.dataUrl || req.body.base64Data || req.body.fileData || req.body.file;
    const fieldName = req.body.fieldName || req.body.fieldType || "doc";
    const folder = req.body.folder || (fieldName.toLowerCase().includes("avatar") || fieldName.toLowerCase().includes("photo") || fieldName.toLowerCase().includes("logo") ? "avatars" : "documents");

    if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      return res.status(400).json({ message: "Invalid base64 data URL provided" });
    }

    const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ message: "Invalid base64 format" });
    }

    const mime = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, "base64");

    let ext = ".png";
    if (mime.includes("pdf")) ext = ".pdf";
    else if (mime.includes("jpeg") || mime.includes("jpg")) ext = ".jpg";
    else if (mime.includes("webp")) ext = ".webp";

    const targetSubfolder = folder === "avatars" ? "avatars" : (folder === "products" ? "products" : "documents");
    const uploadDir = path.join(process.cwd(), "uploads", targetSubfolder);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filename = `${fieldName}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, buffer);

    const relativeUrl = `/uploads/${targetSubfolder}/${filename}`;
    console.log(`Saved file to disk: ${filePath} => ${relativeUrl}`);

    res.json({
      success: true,
      url: relativeUrl,
      fileName: filename
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to save file to disk", error: error.message });
  }
};


