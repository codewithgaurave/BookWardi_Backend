import mongoose from "mongoose";

const wishlistItemSchema = new mongoose.Schema(
  {
    id: {
      type: mongoose.Schema.Types.Mixed
    },
    productId: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    name: {
      type: String,
      default: ""
    },
    subtitle: {
      type: String,
      default: ""
    },
    image: {
      type: String,
      default: ""
    },
    price: {
      type: Number,
      default: 0
    },
    originalPrice: {
      type: Number,
      default: 0
    },
    category: {
      type: String,
      default: ""
    },
    rating: {
      type: Number,
      default: 4.5
    },
    reviewsCount: {
      type: Number,
      default: 0
    },
    badge: {
      type: String,
      default: ""
    },
    inStock: {
      type: Boolean,
      default: true
    }
  },
  { _id: false }
);

const wishlistSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    userPhone: {
      type: String,
      default: ""
    },
    items: [
      {
        type: String
      }
    ],
    products: [
      {
        type: mongoose.Schema.Types.Mixed
      }
    ]
  },
  {
    timestamps: true
  }
);

export default mongoose.model("Wishlist", wishlistSchema);
