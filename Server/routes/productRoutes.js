import express from "express";
import {
  getProducts,
  getRecentlyViewedProducts,
  getFeaturedProducts,
  getSpecialOffers,
  getRecommendedProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct
} from "../controllers/productController.js";
import { authenticateToken } from "../middlewares/auth.js";
import { cacheMiddleware } from "../utils/cache.js";

const router = express.Router();

// Carousel Special Endpoints (must come before /:id)
router.get("/recently-viewed", cacheMiddleware(60), getRecentlyViewedProducts);
router.get("/featured", cacheMiddleware(60), getFeaturedProducts);
router.get("/special-offers", cacheMiddleware(60), getSpecialOffers);
router.get("/recommended", cacheMiddleware(60), getRecommendedProducts);

// Publicly browse products
router.get("/", cacheMiddleware(60), getProducts);
router.get("/:id", cacheMiddleware(60), getProductById);

// Admin / Authenticated endpoints
router.post("/", authenticateToken, createProduct);
router.put("/:id", authenticateToken, updateProduct);
router.delete("/:id", authenticateToken, deleteProduct);

export default router;