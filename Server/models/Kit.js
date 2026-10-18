import mongoose from "mongoose";
import "./Product.js";
import "./Seller.js";

const kitItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: false
  },
  name: {
    type: String,
    required: [true, "Item name is required"], // e.g. "White Shirt", "Navy Blue Pant"
    trim: true
  },
  quantity: {
    type: Number,
    required: [true, "Item quantity is required"],
    min: 1,
    default: 1
  },
  unitPrice: {
    type: Number,
    required: true,
    min: 0
  },
  totalPrice: {
    type: Number,
    required: true,
    min: 0
  },
  originalPrice: {
    type: Number,
    default: 0
  },
  size: {
    type: String,
    default: ""
  },
  color: {
    type: String,
    default: ""
  },
  image: {
    type: String,
    default: ""
  }
});

const kitSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: false
    },
    title: {
      type: String,
      required: [true, "Kit bundle title is required"],
      trim: true
    },
    name: {
      type: String,
      trim: true,
      default: ""
    },
    subtitle: {
      type: String,
      trim: true,
      default: ""
    },
    category: {
      type: String,
      trim: true,
      default: "kits"
    },
    subCategory: {
      type: String,
      trim: true,
      default: "School Uniform Kit"
    },
    sku: {
      type: String,
      trim: true,
      default: ""
    },
    schoolName: {
      type: String,
      required: [true, "School name is required"],
      trim: true
    },
    schoolCode: {
      type: String,
      trim: true,
      default: ""
    },
    gender: {
      type: String,
      enum: ["Boy", "Girl", "Boys", "Girls", "Unisex", "All"],
      default: "Unisex"
    },
    classGrade: {
      type: String,
      required: [true, "Target class/grade is required"],
      trim: true
    },
    badgeTag: {
      type: String,
      enum: ["Best Seller", "New Arrival", "Verified KV", "School Approved", "Trending", "Special Offer", ""],
      default: "School Approved"
    },
    badge: {
      type: String,
      trim: true,
      default: "School Approved"
    },
    items: {
      type: [kitItemSchema],
      validate: {
        validator: function (v) {
          return Array.isArray(v) && v.length > 0;
        },
        message: "Kit bundle must contain at least one item."
      }
    },
    totalMrp: {
      type: Number,
      required: true,
      min: 0
    },
    mrp: {
      type: Number,
      min: 0,
      default: 0
    },
    originalPrice: {
      type: Number,
      min: 0,
      default: 0
    },
    bundlePrice: {
      type: Number,
      required: [true, "Bundle/Kit discounted price is required"],
      min: 0
    },
    price: {
      type: Number,
      min: 0,
      default: 0
    },
    savingsAmount: {
      type: Number,
      default: 0
    },
    discountPercentage: {
      type: Number,
      default: 0
    },
    stock: {
      type: Number,
      required: [true, "Kit stock is required"],
      min: 0,
      default: 10
    },
    stockQuantity: {
      type: Number,
      min: 0,
      default: 10
    },
    inventoryMode: {
      type: String,
      enum: ["fixed", "dynamic"],
      default: "fixed"
    },
    lowStockThreshold: {
      type: Number,
      default: 5
    },
    image: {
      type: String,
      default: ""
    },
    images: {
      type: [String],
      default: []
    },
    description: {
      type: String,
      trim: true,
      default: ""
    },
    gst: {
      type: Number,
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
    rating: {
      type: Number,
      default: 4.8,
      min: 0,
      max: 5
    },
    ratingCount: {
      type: Number,
      default: 0
    },
    status: {
      type: String,
      enum: ["available", "out-of-stock", "inactive", "deleted", "pending", "active", "draft"],
      default: "available"
    },
    approvalStatus: {
      type: String,
      enum: ["Approved", "Pending", "Rejected", "approved", "pending", "rejected"],
      default: "Pending"
    },
    isApproved: {
      type: Boolean,
      default: false
    },
    approvalComment: {
      type: String,
      default: ""
    },
    rejectionReason: {
      type: String,
      default: ""
    },
    paymentMethodAllowed: {
      type: String,
      enum: ["Both", "Online_Only", "COD_Only"],
      default: "Both"
    },
    paymentMethodsAllowed: {
      type: [String],
      default: ["COD", "Online"]
    },
    isDeleted: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

// Indexes
kitSchema.index({ sellerId: 1 });
kitSchema.index({ schoolName: 1 });
kitSchema.index({ classGrade: 1 });
kitSchema.index({ status: 1, approvalStatus: 1, isApproved: 1 });

// Calculate totalMrp, savingsAmount, and discountPercentage automatically before saving
kitSchema.pre("save", function (next) {
  // Normalize and sync approvalStatus & isApproved
  if (this.approvalStatus) {
    const s = String(this.approvalStatus).toLowerCase();
    this.approvalStatus = s === "approved" ? "Approved" : (s === "rejected" ? "Rejected" : "Pending");
  }
  this.isApproved = (this.approvalStatus === "Approved");

  if (this.status) {
    const st = String(this.status).toLowerCase();
    if (st === "active") this.status = "available";
  }

  // Sync name with title
  if (!this.name && this.title) {
    this.name = this.title;
  }
  if (!this.title && this.name) {
    this.title = this.name;
  }

  // Calculate totalMrp from constituent items if present
  if (this.items && this.items.length > 0) {
    const calculatedTotalMrp = this.items.reduce((sum, item) => {
      const itemTotal = item.totalPrice || (item.unitPrice * (item.quantity || 1));
      item.totalPrice = itemTotal;
      return sum + itemTotal;
    }, 0);

    this.totalMrp = calculatedTotalMrp;
    this.mrp = calculatedTotalMrp;
    this.originalPrice = calculatedTotalMrp;

    if (this.bundlePrice && this.bundlePrice < this.totalMrp) {
      this.savingsAmount = Math.max(0, this.totalMrp - this.bundlePrice);
      this.discountPercentage = Math.round((this.savingsAmount / this.totalMrp) * 100);
    } else {
      if (!this.bundlePrice || this.bundlePrice === 0) {
        this.bundlePrice = this.totalMrp;
      }
      this.savingsAmount = Math.max(0, this.totalMrp - this.bundlePrice);
      this.discountPercentage = this.totalMrp > 0 ? Math.round((this.savingsAmount / this.totalMrp) * 100) : 0;
    }
  }

  this.price = this.bundlePrice;
  this.stockQuantity = this.stock;

  // Primary image fallback
  if (Array.isArray(this.images) && this.images.length > 0) {
    this.image = this.images[0];
  } else if (this.image && (!this.images || this.images.length === 0)) {
    this.images = [this.image];
  }

  // Auto-generate SKU if not provided
  if (!this.sku) {
    const cleanSch = (this.schoolCode || this.schoolName || "KIT").replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase();
    const cleanGrd = (this.classGrade || "ALL").replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase();
    this.sku = `KIT-${cleanSch}-${cleanGrd}-${Date.now().toString().slice(-4)}`;
  }

  next();
});

export default mongoose.model("Kit", kitSchema);
