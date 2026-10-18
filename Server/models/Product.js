import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: false
    },
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true
    },
    category: {
      type: String,
      required: [true, "Product category is required"],
      trim: true
    },
    subCategory: {
      type: String,
      trim: true,
      default: ""
    },
    schoolName: {
      type: String,
      trim: true,
      default: ""
    },
    schoolCode: {
      type: String,
      trim: true,
      default: "" // e.g. "DPS", "KV"
    },
    classGrade: {
      type: String,
      trim: true,
      default: "" // e.g. "Class 1-5", "Class 6-10"
    },
    gender: {
      type: String,
      enum: ["Boy", "Girl", "Boys", "Girls", "Unisex", "All"],
      default: "Unisex"
    },
    ageGroup: {
      type: String, // e.g. "3-5 Years", "6-8 Years", "9-12 Years", "13-16 Years", "16+ Years"
      trim: true,
      default: ""
    },
    ages: {
      type: [String], // e.g. ["3-4 Yrs", "5-6 Yrs", "7-8 Yrs"]
      default: []
    },
    sizes: {
      type: [String], // e.g. ["24", "26", "28", "30", "32", "34", "S", "M", "L", "XL"]
      default: []
    },
    sizeVariants: [
      {
        size: {
          type: String,
          trim: true
        },
        measureScale: {
          type: String,
          default: "size",
          trim: true // size, count, meter, kg, gram, box, piece, unit, pack, set, pair
        },
        measureValue: {
          type: String,
          trim: true
        },
        unit: {
          type: String,
          trim: true
        },
        price: {
          type: Number,
          default: 0,
          min: 0
        },
        mrp: {
          type: Number,
          default: 0,
          min: 0
        },
        originalPrice: {
          type: Number,
          default: 0,
          min: 0
        },
        stock: {
          type: Number,
          default: 0,
          min: 0
        },
        stockQuantity: {
          type: Number,
          default: 0,
          min: 0
        },
        image: {
          type: String,
          default: ""
        },
        images: {
          type: [String],
          default: []
        },
        sku: {
          type: String,
          default: ""
        }
      }
    ],
    colors: {
      type: [String], // e.g. ["White", "Navy Blue"]
      default: []
    },
    material: {
      type: String,
      trim: true,
      default: "" // e.g. "100% Premium Cotton"
    },
    brand: {
      type: String,
      trim: true,
      default: "" // e.g. "SchoolKart", "Sharma Uniforms"
    },
    gst: {
      type: Number, // e.g. 0, 5, 12, 18, 28
      default: 5
    },
    gstPercentage: {
      type: Number,
      default: 5
    },
    isGstInclusive: {
      type: Boolean,
      default: true
    },
    price: {
      type: Number,
      required: [true, "Selling Price is required"],
      min: 0
    },
    mrp: {
      type: Number,
      default: 0,
      min: 0
    },
    discountPercentage: {
      type: Number, // Discount % from MRP to Selling Price
      default: 0,
      min: 0,
      max: 100
    },
    stock: {
      type: Number,
      required: [true, "Stock quantity is required"],
      min: 0,
      default: 0
    },
    unit: {
      type: String,
      default: "piece",
      trim: true // piece, pair, set, pack, book, meter
    },
    isMeterBased: {
      type: Boolean,
      default: false
    },
    minMeter: {
      type: Number,
      default: 0.5
    },
    meterStep: {
      type: Number,
      default: 0.5
    },
    isReturnable: {
      type: Boolean,
      default: true
    },
    isRefundable: {
      type: Boolean,
      default: true
    },
    isExchangeable: {
      type: Boolean,
      default: true
    },
    returnWindowDays: {
      type: Number,
      default: 7
    },
    sizeChart: {
      chestInches: { type: String, default: "" },
      lengthInches: { type: String, default: "" },
      sleeveInches: { type: String, default: "" },
      waistInches: { type: String, default: "" },
      shoulderInches: { type: String, default: "" },
      sizeGuideText: { type: String, default: "" },
      rows: [
        {
          size: { type: String, default: "" },
          chest: { type: String, default: "" },
          length: { type: String, default: "" },
          sleeve: { type: String, default: "" },
          waist: { type: String, default: "" },
          shoulder: { type: String, default: "" }
        }
      ]
    },
    description: {
      type: String,
      trim: true,
      default: ""
    },
    images: {
      type: [String],
      default: []
    },
    tags: {
      type: [String], // e.g. ["Best Seller", "School Approved", "Pure Cotton"]
      default: []
    },
    // Per-Product Offer / Discount
    offer: {
      hasOffer: {
        type: Boolean,
        default: false
      },
      discountType: {
        type: String,
        enum: ["percentage", "flat"],
        default: "percentage"
      },
      discountValue: {
        type: Number,
        default: 0,
        min: 0
      },
      offerPrice: {
        type: Number,
        default: null
      },
      startDate: {
        type: Date,
        default: null
      },
      endDate: {
        type: Date,
        default: null
      },
      isActive: {
        type: Boolean,
        default: true
      }
    },
    averageRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    numReviews: {
      type: Number,
      default: 0,
      min: 0
    },
    status: {
      type: String,
      enum: ["available", "out-of-stock", "discontinued"],
      default: "available"
    },
    // Admin Approval Lifecycle
    approvalStatus: {
      type: String,
      enum: ["Approved", "Pending", "Rejected"],
      default: "Pending"
    },
    approvalComment: {
      type: String,
      default: ""
    },
    rejectionReason: {
      type: String,
      default: ""
    },
    // Payment Method Options decided by Seller / Admin
    paymentMethodAllowed: {
      type: String,
      enum: ["Both", "Online_Only", "COD_Only"],
      default: "Both"
    },
    paymentMethodsAllowed: {
      type: [String],
      default: ["COD", "Online"]
    },
    // Top-level extra details saved during product addition
    image: {
      type: String,
      default: ""
    },
    subtitle: {
      type: String,
      trim: true,
      default: ""
    },
    stockQuantity: {
      type: Number,
      min: 0,
      default: 0
    },
    originalPrice: {
      type: Number,
      min: 0,
      default: 0
    },
    discountBadge: {
      type: String,
      trim: true,
      default: ""
    },
    badgeTag: {
      type: String,
      trim: true,
      default: ""
    },
    badge: {
      type: String,
      trim: true,
      default: ""
    },
    bundleType: {
      type: String,
      trim: true,
      default: ""
    },
    sku: {
      type: String,
      trim: true,
      default: ""
    },
    kitItems: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },
    items: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },
    totalMrp: {
      type: Number,
      min: 0,
      default: 0
    },
    bundlePrice: {
      type: Number,
      min: 0,
      default: 0
    },
    sellerStoreName: {
      type: String,
      trim: true,
      default: ""
    },
    sellerName: {
      type: String,
      trim: true,
      default: ""
    },
    storeName: {
      type: String,
      trim: true,
      default: ""
    },
    legalBusinessName: {
      type: String,
      trim: true,
      default: ""
    },
    sellerAcceptsCod: {
      type: Boolean,
      default: true
    },
    sellerAcceptsOnline: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true,
    strict: false
  }
);

// Indexes
productSchema.index({ sellerId: 1 });
productSchema.index({ category: 1, approvalStatus: 1 });
productSchema.index({ status: 1, approvalStatus: 1 });
productSchema.index({ status: 1, approvalStatus: 1, createdAt: -1 });
productSchema.index({ averageRating: -1, numReviews: -1 });

// Pre-save hook to calculate discountPercentage, offerPrice automatically & set MRP fallback
productSchema.pre("save", function (next) {
  // 1. Calculate price from MRP & discount percentage if price not explicitly different
  if (this.mrp && this.mrp > 0 && this.discountPercentage > 0 && (!this.price || this.price === this.mrp)) {
    this.price = Math.max(0, Math.round((this.mrp - (this.mrp * this.discountPercentage) / 100) * 100) / 100);
  } else if (this.mrp && this.mrp > 0 && this.price && this.mrp > this.price) {
    // If MRP and Price are provided, auto-calculate discount percentage
    this.discountPercentage = Math.round(((this.mrp - this.price) / this.mrp) * 100);
  } else if (!this.mrp || this.mrp < this.price) {
    // If MRP is less than price or missing, set MRP equal to selling price
    this.mrp = this.price;
    this.discountPercentage = 0;
  }

  // 2. Calculate discount percentage for sizeVariants
  if (Array.isArray(this.sizeVariants)) {
    this.sizeVariants.forEach((v) => {
      const vMrp = Number(v.mrp || v.originalPrice || 0);
      const vPrice = Number(v.price || 0);
      if (vMrp > 0 && vPrice > 0 && vMrp >= vPrice) {
        v.discountPercentage = Math.round(((vMrp - vPrice) / vMrp) * 100);
      } else if (!vMrp || vMrp < vPrice) {
        v.mrp = vPrice;
        v.discountPercentage = 0;
      }
    });
  }

  // 3. Calculate promotional offer price
  if (this.offer && this.offer.hasOffer && this.offer.isActive && this.offer.discountValue > 0) {
    if (this.offer.discountType === "percentage") {
      const discount = (this.price * this.offer.discountValue) / 100;
      this.offer.offerPrice = Math.max(0, Math.round((this.price - discount) * 100) / 100);
    } else if (this.offer.discountType === "flat") {
      this.offer.offerPrice = Math.max(0, this.price - this.offer.discountValue);
    }
  } else if (this.offer) {
    this.offer.offerPrice = this.price;
  }

  // 4. Ensure clean SKU format (SC-XXXX)
  if (!this.sku || !String(this.sku).trim() || String(this.sku).includes("6ab") || String(this.sku).length > 20) {
    const idStr = String(this._id || this.id || "");
    const numericSuffix = idStr.length >= 6 ? (parseInt(idStr.slice(-6), 16) % 9000 + 1000) : Math.floor(1000 + Math.random() * 9000);
    this.sku = `SC-${numericSuffix}`;
  }
  next();
});

productSchema.index({ sellerId: 1 });
productSchema.index({ seller: 1 });
productSchema.index({ status: 1 });
productSchema.index({ approvalStatus: 1 });
productSchema.index({ category: 1 });
productSchema.index({ createdAt: -1 });

export default mongoose.model("Product", productSchema);