import express from "express";
import {
  loginAdmin,
  createAdmin,
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  getDashboardStats,
  changePassword,
  getRecentActivities,
  getChartData,
  globalSearch,
  getAdminProducts,
  getAdminProductById,
  updateProductApproval,
  deleteAdminProduct,
  createAdminProduct,
  updateAdminProduct,
  getAdminInventory,
  updateAdminInventoryStock,
  quickRestockAdminInventory,
  getPlatformSettings,
  getPublicPlatformSettings,
  updatePlatformSettings,
  getAllSubadmins,
  createSubadmin,
  updateSubadmin,
  deleteSubadmin
} from "../controllers/adminController.js";
import {
  getAllSellers,
  reconcileAllSellers,
  getSellerById,
  approveSeller,
  rejectSeller,
  setPendingSeller,
  toggleSellerStatus,
  updateSellerCommission,
  downloadSellerFinancialStatement,
  approveSellerUpdates,
  rejectSellerUpdates
} from "../controllers/adminSellerController.js";
import {
  getAllPayoutsAdmin,
  processPayoutAdmin
} from "../controllers/payoutController.js";
import {
  exportOrdersAdmin,
  exportProductsAdmin,
  exportUsersAdmin,
  exportSellersAdmin
} from "../controllers/exportController.js";
import {
  getAdminKits,
  getAdminKitById,
  updateKitApproval,
  createAdminKit,
  updateAdminKit,
  deleteAdminKit
} from "../controllers/adminKitController.js";
import { authenticateAdmin, requireSuperAdmin } from "../middlewares/auth.js";

const router = express.Router();

// ==========================================
// Admin Auth routes
// ==========================================
router.post("/login", loginAdmin);
router.post("/register", createAdmin);
router.post("/create-default", createAdmin);

// ==========================================
// Sub-Admin RBAC Team Management (Super-Admin only)
// ==========================================
router.get("/subadmins", authenticateAdmin, getAllSubadmins);
router.post("/subadmins", requireSuperAdmin, createSubadmin);
router.put("/subadmins/:id", requireSuperAdmin, updateSubadmin);
router.delete("/subadmins/:id", requireSuperAdmin, deleteSubadmin);

// ==========================================
// Admin Dashboard & User Management
// ==========================================
router.get("/dashboard/stats", authenticateAdmin, getDashboardStats);
router.get("/recent-activities", authenticateAdmin, getRecentActivities);
router.get("/chart-data", authenticateAdmin, getChartData);
router.get("/users", authenticateAdmin, getUsers);
router.post("/users", authenticateAdmin, createUser);
router.put("/users/:id", authenticateAdmin, updateUser);
router.delete("/users/:id", authenticateAdmin, deleteUser);
router.put("/change-password", authenticateAdmin, changePassword);
router.get("/search", authenticateAdmin, globalSearch);

// ==========================================
// Admin Product Approval & Catalog Management (RESTful)
// ==========================================
router.get("/products", authenticateAdmin, getAdminProducts);
router.get("/products/:id", authenticateAdmin, getAdminProductById);
router.post("/products", authenticateAdmin, createAdminProduct);
router.put("/products/:id", authenticateAdmin, updateAdminProduct);
router.put("/products/:id/approval", authenticateAdmin, updateProductApproval);
router.patch("/products/:id/approval", authenticateAdmin, updateProductApproval);
router.delete("/products/:id", authenticateAdmin, deleteAdminProduct);

// ==========================================
// Admin Kit & Bundle Management
// ==========================================
router.get("/kits", authenticateAdmin, getAdminKits);
router.get("/kits/:id", authenticateAdmin, getAdminKitById);
router.patch("/kits/:id/approval", authenticateAdmin, updateKitApproval);
router.put("/kits/:id/approval", authenticateAdmin, updateKitApproval);
router.post("/kits", authenticateAdmin, createAdminKit);
router.put("/kits/:id", authenticateAdmin, updateAdminKit);
router.delete("/kits/:id", authenticateAdmin, deleteAdminKit);

// ==========================================
// Admin Inventory & Warehouse Management (RESTful)
// ==========================================
router.get("/inventory", authenticateAdmin, getAdminInventory);
router.patch("/inventory/:id/stock", authenticateAdmin, updateAdminInventoryStock);
router.put("/inventory/:id/stock", authenticateAdmin, updateAdminInventoryStock);
router.post("/inventory/quick-restock", authenticateAdmin, quickRestockAdminInventory);

// ==========================================
// Admin Seller Verification & Management
// ==========================================
router.get("/sellers", authenticateAdmin, getAllSellers);
router.get("/sellers/reconcile-all", authenticateAdmin, reconcileAllSellers);
router.post("/sellers/reconcile-all", authenticateAdmin, reconcileAllSellers);
router.get("/sellers/:id", authenticateAdmin, getSellerById);
router.put("/sellers/:id/approve", authenticateAdmin, approveSeller);
router.put("/sellers/:id/reject", authenticateAdmin, rejectSeller);
router.put("/sellers/:id/pending", authenticateAdmin, setPendingSeller);
router.put("/sellers/:id/status", authenticateAdmin, toggleSellerStatus);
router.put("/sellers/:id/commission", authenticateAdmin, updateSellerCommission);
router.put("/sellers/:id/approve-updates", authenticateAdmin, approveSellerUpdates);
router.put("/sellers/:id/reject-updates", authenticateAdmin, rejectSellerUpdates);
router.get("/sellers/:id/finance-statement/pdf", authenticateAdmin, downloadSellerFinancialStatement);

// ==========================================
// Admin Payout Ledger & Approvals
// ==========================================
router.get("/payouts", authenticateAdmin, getAllPayoutsAdmin);
router.put("/payouts/:id/process", authenticateAdmin, processPayoutAdmin);

// ==========================================
// Admin Platform Settings
// ==========================================
router.get("/settings/public", getPublicPlatformSettings);
router.get("/settings", authenticateAdmin, getPlatformSettings);
router.put("/settings", authenticateAdmin, updatePlatformSettings);

// ==========================================
// Admin Data Export (Excel / CSV Reports)
// ==========================================
router.get("/export/orders", authenticateAdmin, exportOrdersAdmin);
router.get("/export/products", authenticateAdmin, exportProductsAdmin);
router.get("/export/users", authenticateAdmin, exportUsersAdmin);
router.get("/export/sellers", authenticateAdmin, exportSellersAdmin);

export default router;


