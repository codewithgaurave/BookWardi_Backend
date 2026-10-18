import express from "express";
import {
  addReview,
  getProductReviews,
  getAllReviews,
  getSellerReviews,
  updateReviewStatus,
  replyToSellerReview,
  deleteReview
} from "../controllers/reviewController.js";
import { optionalUserAuth } from "../middlewares/auth.js";

const router = express.Router();

// Admin / Moderation: Get all reviews
router.get("/", optionalUserAuth, getAllReviews);
router.get("/all", optionalUserAuth, getAllReviews);

// Seller: Get reviews for seller's products
router.get("/seller", optionalUserAuth, getSellerReviews);

// Public: Get reviews for a product
router.get("/product/:productId", getProductReviews);

// Customer: Add or update review
router.post("/", optionalUserAuth, addReview);

// Seller/Admin: Approve or reject review
router.patch("/:id/status", optionalUserAuth, updateReviewStatus);

// Seller: Reply to review
router.post("/:id/reply", optionalUserAuth, replyToSellerReview);

// Customer/Admin: Delete review
router.delete("/:id", optionalUserAuth, deleteReview);

export default router;
