import mongoose from "mongoose";

const announcementSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: [true, "Announcement text is required"],
      trim: true
    },
    badge: {
      type: String,
      trim: true,
      default: ""
    },
    link: {
      type: String,
      trim: true,
      default: ""
    },
    priority: {
      type: Number,
      default: 1
    },
    isActive: {
      type: Boolean,
      default: true
    },
    expiryDate: {
      type: Date,
      default: null
    },
    bgColor: {
      type: String,
      default: "#0f766e"
    },
    textColor: {
      type: String,
      default: "#ffffff"
    }
  },
  {
    timestamps: true
  }
);

// Helper method or pre-find middleware to check for auto-expiry
announcementSchema.methods.isExpired = function () {
  if (!this.expiryDate) return false;
  return new Date(this.expiryDate) < new Date();
};

export default mongoose.model("Announcement", announcementSchema);
