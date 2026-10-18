import express from "express";
import {
  getPayments,
  createPayment,
  verifyPayment,
  deletePayment,
  getPaymentStats
} from "../controllers/paymentController.js";
import { authenticateAdmin, optionalUserAuth } from "../middlewares/auth.js";

const router = express.Router();

router.post("/create-order", optionalUserAuth, createPayment);
router.post("/verify", optionalUserAuth, verifyPayment);
router.get("/", authenticateAdmin, getPayments);
router.get("/stats", authenticateAdmin, getPaymentStats);
router.delete("/:id", authenticateAdmin, deletePayment);

export default router;