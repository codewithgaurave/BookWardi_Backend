import express from "express";
import {
  getCart,
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart
} from "../controllers/cartController.js";
import { optionalUserAuth } from "../middlewares/auth.js";

const router = express.Router();

router.use(optionalUserAuth);

router.get("/", getCart);
router.post("/add", addToCart);
router.put("/item/:itemId", updateCartItem);
router.delete("/item/:itemId", removeFromCart);
router.delete("/clear", clearCart);
router.post("/clear", clearCart);

export default router;
