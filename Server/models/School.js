import mongoose from "mongoose";

const schoolSchema = new mongoose.Schema(
  {
    schoolId: { type: String },
    name: { type: String, required: true },
    shortName: { type: String, default: "" },
    code: { type: String, default: "" },
    board: { type: String, default: "CBSE" },
    city: { type: String, default: "General" },
    district: { type: String, default: "" },
    subdistrict: { type: String, default: "" },
    address: { type: String },
    pincode: { type: String },
    lat: { type: Number },
    lng: { type: Number },
    classes: { 
      type: [String], 
      default: ["Pre-Nursery", "Nursery", "LKG", "UKG", "Class 1", "Class 2", "Class 3", "Class 4", "Class 5", "Class 6", "Class 7", "Class 8", "Class 9", "Class 10", "Class 11", "Class 12"] 
    },
    studentCount: { type: Number, default: 1000 },
    contactPerson: { type: String },
    email: { type: String },
    phone: { type: String },
    status: { type: String, default: "Partner Active" },
    exclusiveKit: { type: Boolean, default: true }
  },
  { timestamps: true }
);

schoolSchema.pre("validate", function (next) {
  if (!this.shortName) {
    this.shortName = this.code || (this.name ? this.name.split(" ").map(w => w[0]).join("").slice(0, 8).toUpperCase() : "SCH");
  }
  if (!this.code) {
    this.code = this.shortName;
  }
  if (!this.schoolId) {
    this.schoolId = `SCH-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
  }
  next();
});

export default mongoose.model("School", schoolSchema);
