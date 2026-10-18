import mongoose from "mongoose";

const contactMsgSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    subject: {
      type: String,
      required: true,
      trim: true
    },
    message: {
      type: String,
      required: true,
      trim: true
    },
    phone: {
      type: String,
      trim: true,
      default: ""
    },
    status: {
      type: String,
      enum: ["unread", "read", "replied"],
      default: "unread"
    }
  },
  {
    collection: "contactsmsg",
    timestamps: true
  }
);

const ContactMsg = mongoose.model("ContactMsg", contactMsgSchema);

export default ContactMsg;
