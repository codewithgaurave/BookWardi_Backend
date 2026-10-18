import multer from "multer";
import path from "path";
import fs from "fs";

// Ensure upload directories exist
const createDirIfNotExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

// Storage for Seller Documents (Aadhaar, PAN, Passbook, Shop Doc)
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), "uploads", "documents");
    createDirIfNotExists(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    const field = file.fieldname || "doc";
    cb(null, `${field}-${uniqueSuffix}${ext}`);
  }
});

// Storage for Product Images
const productStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), "uploads", "products");
    createDirIfNotExists(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `product-${uniqueSuffix}${ext}`);
  }
});

// File filter for documents (PDF, JPG, JPEG, PNG, WEBP)
const documentFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "application/pdf"
  ];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid document format. Only PDF, JPG, PNG, and WEBP files are allowed."), false);
  }
};

// File filter for product images (JPG, JPEG, PNG, WEBP)
const imageFileFilter = (req, file, cb) => {
  const allowedMimeTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid image format. Only JPG, PNG, and WEBP images are allowed."), false);
  }
};

// Storage for User Avatar Photos
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), "uploads", "avatars");
    createDirIfNotExists(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname).toLowerCase();
    const finalExt = ext === ".webp" ? ".webp" : ext || ".webp";
    cb(null, `avatar-${uniqueSuffix}${finalExt}`);
  }
});

// Multer upload instances
export const uploadSellerDocs = multer({
  storage: documentStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit per document
  fileFilter: documentFileFilter
}).fields([
  { name: "aadhaarDoc", maxCount: 1 },
  { name: "panDoc", maxCount: 1 },
  { name: "passbookDoc", maxCount: 1 },
  { name: "shopDoc", maxCount: 1 },
  { name: "addressProofDoc", maxCount: 1 },
  { name: "profilePhoto", maxCount: 1 },
  { name: "avatar", maxCount: 1 },
  { name: "storeLogo", maxCount: 1 }
]);

export const uploadProductImages = multer({
  storage: productStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit per image
  fileFilter: imageFileFilter
}).array("images", 5); // Up to 5 product images

export const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: imageFileFilter
}).single("avatar");

