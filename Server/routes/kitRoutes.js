import express from "express";
import { getKits, getKitById } from "../controllers/kitController.js";
import { cacheMiddleware } from "../utils/cache.js";

const router = express.Router();

// Public Kit Browsing Endpoints
router.get("/", cacheMiddleware(120), getKits);
router.get("/:id", cacheMiddleware(120), getKitById);

export default router;
