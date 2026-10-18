import mongoose from "mongoose";

const deviceTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, trim: true },
    platform: { type: String, enum: ["android", "ios", "web", "unknown"], default: "android" },
    deviceId: { type: String, default: "" },
    lastActive: { type: Date, default: Date.now }
  },
  { _id: false }
);

const sellerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Seller name is required"],
      trim: true
    },
    storeName: {
      type: String,
      required: [true, "Store/Shop name is required"],
      trim: true
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true
    },
    phone: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 6
    },
    // Store Address
    address: {
      type: String,
      required: [true, "Store address is required"]
    },
    city: {
      type: String,
      required: [true, "City is required"]
    },
    state: {
      type: String,
      required: [true, "State is required"]
    },
    pincode: {
      type: String,
      required: [true, "Pincode is required"]
    },
    gstNumber: {
      type: String,
      trim: true,
      default: ""
    },
    msmeRegistrationNumber: {
      type: String,
      trim: true,
      default: ""
    },
    cinNumber: {
      type: String,
      trim: true,
      default: ""
    },
    yearStarted: {
      type: String,
      trim: true,
      default: ""
    },
    businessType: {
      type: String,
      trim: true,
      default: "Proprietorship"
    },
    annualTurnoverEstimate: {
      type: String,
      trim: true,
      default: ""
    },

    // Owner / Authorized Signatory Details
    ownerDetails: {
      ownerFullName: { type: String, default: "" },
      ownerDesignation: { type: String, default: "" },
      ownerPan: { type: String, default: "" },
      ownerAadhaarLast4: { type: String, default: "" }
    },

    // Detailed Address Info
    addressDetails: {
      addressLine1: { type: String, default: "" },
      addressLine2: { type: String, default: "" },
      landmark: { type: String, default: "" },
      country: { type: String, default: "India" }
    },

    // Address Proof Details
    addressProofDetails: {
      addressProofType: { type: String, default: "" },
      addressProofDocNumber: { type: String, default: "" }
    },

    // Geo-Location (Google Maps Lat/Long & Proximity Search)
    location: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      formattedAddress: { type: String, default: "" },
      geo: {
        type: {
          type: String,
          enum: ["Point"],
          default: "Point"
        },
        coordinates: {
          type: [Number], // [longitude, latitude]
          default: [0, 0]
        }
      }
    },

    // Bank Account Details for Payouts
    bankDetails: {
      accountHolderName: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      ifscCode: { type: String, default: "" },
      bankName: { type: String, default: "" },
      branchName: { type: String, default: "" },
      accountType: { type: String, default: "Savings Account" }
    },

    // Store Branding & Profile
    storeDetails: {
      storeTagline: { type: String, default: "" },
      storeDescription: { type: String, default: "" },
      storeLogo: { type: String, default: "" }
    },

    // Catalog & Product Capabilities
    catalogInfo: {
      selectedCategories: [{ type: String }],
      primaryBrands: [{ type: String }],
      estimatedSkuCount: { type: String, default: "" },
      sampleProductTitle: { type: String, default: "" }
    },

    // Terms & Legal Compliance Agreements
    agreements: {
      acceptedTerms: { type: Boolean, default: false },
      acceptedCommissionRate: { type: Boolean, default: false },
      acceptedReturnPolicy: { type: Boolean, default: false },
      authorizedSignatoryConfirmation: { type: Boolean, default: false }
    },

    // KYC & Business Documents
    documents: {
      aadhaarNumber: { type: String, default: "" },
      aadhaarDoc: { type: String, default: "" }, // local file path / URL
      panNumber: { type: String, default: "" },
      panDoc: { type: String, default: "" }, // local file path / URL
      msmeRegistrationNumber: { type: String, default: "" },
      cinNumber: { type: String, default: "" },
      passbookDoc: { type: String, default: "" }, // passbook / cancelled cheque
      shopDoc: { type: String, default: "" }, // Trade License / Shop Act / Registration
      addressProofDoc: { type: String, default: "" }, // Electricity bill / rent agreement
      profilePhoto: { type: String, default: "" } // Seller avatar / profile picture
    },

    // Delivery Capabilities & Preferences
    deliveryPreferences: {
      selfDelivery: {
        type: Boolean,
        default: true
      },
      maxDeliveryRadiusKm: {
        type: Number,
        default: 10,
        min: 1
      },
      thirdPartyDelivery: {
        type: Boolean,
        default: true
      }
    },

    // Financials, Wallet & Commission
    commissionPercentage: {
      type: Number,
      default: 10, // Default platform fee: 10%
      min: 0,
      max: 100
    },
    commissionRate: {
      type: Number,
      default: 10, // Default platform fee: 10%
      min: 0,
      max: 100
    },
    walletBalance: {
      type: Number,
      default: 0,
      min: 0
    },
    pendingSettlementBalance: {
      type: Number,
      default: 0
    },
    totalEarnings: {
      type: Number,
      default: 0
    },
    totalWithdrawn: {
      type: Number,
      default: 0,
      min: 0
    },

    // Approval & Account Status
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "suspended"],
      default: "pending"
    },
    rejectionReason: {
      type: String,
      default: ""
    },
    approvedAt: {
      type: Date
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin"
    },
    role: {
      type: String,
      default: "seller"
    },
    fcmToken: {
      type: String,
      default: ""
    },
    fcmTokens: [deviceTokenSchema],
    otpCode: { type: String, default: "" },
    otpExpiresAt: { type: Date, default: null }
  },
  {
    timestamps: true
  }
);

// 2dsphere index for nearby store location queries
sellerSchema.index({ "location.geo": "2dsphere" });
sellerSchema.index({ phone: 1 });
sellerSchema.index({ email: 1 });
sellerSchema.index({ status: 1 });

export default mongoose.model("Seller", sellerSchema);
