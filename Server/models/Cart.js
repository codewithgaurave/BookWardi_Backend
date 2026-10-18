import mongoose from "mongoose";

const cartSchema = new mongoose.Schema(
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
        type: mongoose.Schema.Types.Mixed
      }
    ],
    totalAmount: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

cartSchema.pre("save", function (next) {
  this.totalAmount = (this.items || []).reduce(
    (total, item) => total + (Number(item?.price) || 0) * (Number(item?.quantity) || 1),
    0
  );
  next();
});

export default mongoose.model("Cart", cartSchema);
