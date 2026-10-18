import express from "express";
import {
  getOrders,
  getMyOrders,
  getOrderById,
  trackOrder,
  createOrder,
  updateOrder,
  deleteOrder,
  downloadInvoice,
  downloadCreditNote,
  downloadExchangeInvoice,
  cancelOrder,
  requestReturnExchange,
  updateReturnExchangeStatus,
  resendAdminDeliveryBoyWhatsApp
} from "../controllers/orderController.js";
import { authenticateToken, protectUser, optionalUserAuth } from "../middlewares/auth.js";

const router = express.Router();

router.get("/my-orders", optionalUserAuth, getMyOrders);
router.get("/track/:orderId", trackOrder); // Public & User order tracking by Order ID
router.get("/:id/tracking", optionalUserAuth, trackOrder);
router.get("/:id/invoice", optionalUserAuth, downloadInvoice);
router.get("/:id/credit-note", optionalUserAuth, downloadCreditNote);
router.get("/:id/exchange-invoice", optionalUserAuth, downloadExchangeInvoice);

router.get("/admin/all", optionalUserAuth, getOrders);
router.get("/all", optionalUserAuth, getOrders);
router.get("/", optionalUserAuth, getOrders);
router.get("/:id", authenticateToken, getOrderById);
router.post("/", optionalUserAuth, createOrder);
router.post("/:id/cancel", optionalUserAuth, cancelOrder);
router.post("/:id/return-exchange", optionalUserAuth, requestReturnExchange);
router.patch("/:id/return-exchange/status", optionalUserAuth, updateReturnExchangeStatus);
router.put("/:id/return-exchange/status", optionalUserAuth, updateReturnExchangeStatus);
router.put("/:id/status", optionalUserAuth, updateOrder);
router.patch("/:id/status", optionalUserAuth, updateOrder);
router.post("/:id/resend-rider-whatsapp", optionalUserAuth, resendAdminDeliveryBoyWhatsApp);
router.post("/:id/resend-whatsapp", optionalUserAuth, resendAdminDeliveryBoyWhatsApp);
router.put("/:id", authenticateToken, updateOrder);
router.delete("/:id", authenticateToken, deleteOrder);

export default router;