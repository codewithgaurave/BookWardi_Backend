import express from "express";
import {
  getWishlist,
  toggleWishlist,
  removeFromWishlist
} from "../controllers/wishlistController.js";
import { optionalUserAuth } from "../middlewares/auth.js";

const router = express.Router();

router.use(optionalUserAuth);

router.get("/", getWishlist);
router.post("/toggle", toggleWishlist);
router.delete("/remove/:productId", removeFromWishlist);

export default router;
