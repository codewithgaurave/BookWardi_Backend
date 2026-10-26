import express from "express";
import {
  registerSeller,
  loginSeller,
  getSellerProfile,
  updateSellerProfile,
  getNearbySellers,
  sendSellerPhoneOtp,
  verifySellerPhoneOtp,
  getSellerApplicationStatus,
  adminApproveSellerTest,
  updateSellerApplication,
  getSellerSettings,
  updateSellerSettings,
  uploadBase64Document
} from "../controllers/sellerAuthController.js";
import {
  getSellerProducts,
  getSellerProductCategories,
  createProduct,
  updateProduct,
  deleteProduct,
  setProductOffer,
  removeProductOffer,
  updateInventoryStock
} from "../controllers/sellerProductController.js";
import {
  getSellerKits,
  getSellerKitById,
  createKit,
  updateKit,
  deleteKit
} from "../controllers/sellerKitController.js";
import {
  getSellerOrders,
  getSellerCustomers,
  updateSellerOrderItemStatus,
  updateSellerOrderStatus,
  downloadSellerInvoice,
  downloadSellerCreditNote,
  downloadSellerExchangeInvoice,
  resendSellerDeliveryBoyWhatsApp
} from "../controllers/sellerOrderController.js";
import { updateReturnExchangeStatus } from "../controllers/orderController.js";
import { downloadSellerFinancialStatement } from "../controllers/adminSellerController.js";
import {
  getSellerOffers,
  createSellerOffer,
  updateSellerOffer,
  deleteSellerOffer,
  toggleSellerOfferStatus
} from "../controllers/sellerOfferController.js";
import {
  getSellerWalletOverview,
  requestPayout
} from "../controllers/payoutController.js";
import { exportSellerOrders } from "../controllers/exportController.js";
import { uploadSellerDocs, uploadProductImages } from "../middlewares/upload.js";
import { authenticateSeller } from "../middlewares/auth.js";
import { saveFcmToken, removeFcmToken } from "../controllers/userAuthController.js";

const router = express.Router();

// ==========================================
// 1. Public & Location-based Routes
// ==========================================
// Nearby Sellers Search (by customer lat/lng)
router.get("/nearby", getNearbySellers);

// Phone OTP Authentication Routes
router.post("/auth/send-otp", sendSellerPhoneOtp);
router.post("/auth/verify-otp", verifySellerPhoneOtp);
router.get("/auth/status", authenticateSeller, getSellerApplicationStatus);
router.put("/auth/application", authenticateSeller, uploadSellerDocs, updateSellerApplication);
router.post("/auth/admin-approve-test", authenticateSeller, adminApproveSellerTest);

// ==========================================
// 2. Seller Authentication & Profile
// ==========================================
// Seller Registration with KYC Documents upload & Location
router.post("/register", uploadSellerDocs, registerSeller);
router.post("/upload-base64", uploadBase64Document);

// Seller Login (Only Approved Sellers)
router.post("/login", loginSeller);

// Protected Seller Profile & Settings
router.get("/profile", authenticateSeller, getSellerProfile);
router.put("/profile", authenticateSeller, uploadSellerDocs, updateSellerProfile);
router.get("/settings", authenticateSeller, getSellerSettings);
router.put("/settings", authenticateSeller, updateSellerSettings);
router.post("/fcm-token", authenticateSeller, saveFcmToken);
router.delete("/fcm-token", authenticateSeller, removeFcmToken);

// ==========================================
// 3. Seller Single Product Management & Offers
// ==========================================
router.get("/products/categories", authenticateSeller, getSellerProductCategories);
router.get("/products", authenticateSeller, getSellerProducts);
router.post("/products", authenticateSeller, uploadProductImages, createProduct);
router.put("/products/:id", authenticateSeller, uploadProductImages, updateProduct);
router.delete("/products/:id", authenticateSeller, deleteProduct);
router.patch("/inventory/:id/stock", authenticateSeller, updateInventoryStock);

// Per-Product Specific Offer Management
router.post("/products/:id/offer", authenticateSeller, setProductOffer);
router.delete("/products/:id/offer", authenticateSeller, removeProductOffer);

// ==========================================
// 4. Seller Complete Uniform Kit Bundles
// ==========================================
router.get("/kits", authenticateSeller, getSellerKits);
router.get("/kits/:id", authenticateSeller, getSellerKitById);
router.post("/kits", authenticateSeller, uploadProductImages, createKit);
router.put("/kits/:id", authenticateSeller, uploadProductImages, updateKit);
router.delete("/kits/:id", authenticateSeller, deleteKit);

import {
  getSellerSchoolOrders,
  createSellerSchoolOrder,
  updateSellerSchoolOrder,
  deleteSellerSchoolOrder,
  acceptSchoolOrderDirect,
  submitSellerQuotation,
  acceptBuyerCounterDemand,
  confirmSellerAcceptance,
  reviseSellerQuotation
} from "../controllers/schoolBulkOrderController.js";

// ==========================================
// 5. Seller Order Management & School B2B Orders
// ==========================================
router.get("/customers", authenticateSeller, getSellerCustomers);
router.get("/orders", authenticateSeller, getSellerOrders);
router.get("/orders/export", authenticateSeller, exportSellerOrders);
router.get("/orders/:orderId/invoice", authenticateSeller, downloadSellerInvoice);
router.get("/orders/:orderId/credit-note", authenticateSeller, downloadSellerCreditNote);
router.get("/orders/:orderId/exchange-invoice", authenticateSeller, downloadSellerExchangeInvoice);
router.patch("/orders/:orderId/status", authenticateSeller, updateSellerOrderStatus);
router.put("/orders/:orderId/status", authenticateSeller, updateSellerOrderStatus);
router.post("/orders/:orderId/resend-whatsapp", authenticateSeller, resendSellerDeliveryBoyWhatsApp);
router.patch("/orders/:id/return-exchange/status", authenticateSeller, updateReturnExchangeStatus);
router.put("/orders/:id/return-exchange/status", authenticateSeller, updateReturnExchangeStatus);
router.put(
  "/orders/:orderId/items/:itemId/status",
  authenticateSeller,
  updateSellerOrderItemStatus
);
router.patch(
  "/orders/:orderId/items/:itemId/status",
  authenticateSeller,
  updateSellerOrderItemStatus
);

// School Bulk Orders (B2B Requisitions)
router.get("/school-orders", authenticateSeller, getSellerSchoolOrders);
router.post("/school-orders", authenticateSeller, createSellerSchoolOrder);
router.patch("/school-orders/:id", authenticateSeller, updateSellerSchoolOrder);
router.patch("/school-orders/:id/status", authenticateSeller, updateSellerSchoolOrder);
router.delete("/school-orders/:id", authenticateSeller, deleteSellerSchoolOrder);
router.post("/school-orders/:id/accept", authenticateSeller, acceptSchoolOrderDirect);
router.post("/school-orders/:id/quote", authenticateSeller, submitSellerQuotation);
router.post("/school-orders/:id/confirm-seller-acceptance", authenticateSeller, confirmSellerAcceptance);
router.post("/school-orders/:id/quotations/:quoteId/accept-counter", authenticateSeller, acceptBuyerCounterDemand);
router.post("/school-orders/:id/quotations/:quoteId/revise", authenticateSeller, reviseSellerQuotation);


// ==========================================
// 6. Seller Store-wide Coupons & Offers
// ==========================================
router.get("/offers", authenticateSeller, getSellerOffers);
router.get("/promotions", authenticateSeller, getSellerOffers);
router.post("/offers", authenticateSeller, createSellerOffer);
router.post("/promotions", authenticateSeller, createSellerOffer);
router.put("/offers/:id", authenticateSeller, updateSellerOffer);
router.put("/promotions/:id", authenticateSeller, updateSellerOffer);
router.delete("/offers/:id", authenticateSeller, deleteSellerOffer);
router.delete("/promotions/:id", authenticateSeller, deleteSellerOffer);
router.patch("/offers/:id/status", authenticateSeller, toggleSellerOfferStatus);
router.patch("/promotions/:id/status", authenticateSeller, toggleSellerOfferStatus);

// ==========================================
// 7. Seller Financials & Wallet Payouts
// ==========================================
router.get("/wallet", authenticateSeller, getSellerWalletOverview);
router.post("/payout-request", authenticateSeller, requestPayout);
router.get("/finance-statement/pdf", authenticateSeller, downloadSellerFinancialStatement);

import {
  getSellerReviews,
  updateReviewStatus,
  replyToSellerReview
} from "../controllers/reviewController.js";

// ==========================================
// 8. Seller Customer Reviews Moderation
// ==========================================
router.get("/reviews", authenticateSeller, getSellerReviews);
router.patch("/reviews/:id/approve", authenticateSeller, updateReviewStatus);
router.post("/reviews/:id/reply", authenticateSeller, replyToSellerReview);

export default router;

