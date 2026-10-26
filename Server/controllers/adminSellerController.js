import mongoose from "mongoose";
import Seller from "../models/Seller.js";
import User from "../models/User.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import { generateSellerFinancialStatementPDF } from "../services/invoiceService.js";
import { calculateSellerSettlement, reconcileSellerSettlementBalances } from "../services/settlementService.js";

// Helper: Safely find seller by MongoDB ObjectId or fallback to email / phone / storeName
const findSellerByIdOrQuery = async (id, selectFields = "") => {
  const isObjId = mongoose.Types.ObjectId.isValid(id);
  let query = Seller.find(isObjId ? { _id: id } : { $or: [{ email: id }, { phone: id }, { storeName: id }] });
  if (selectFields) {
    query = query.select(selectFields);
  }
  return await query.findOne();
};

// Reconcile All Sellers Settlement Balances On-Demand (Return Window + 1 day maturity)
export const reconcileAllSellers = async (req, res) => {
  try {
    const sellers = await Seller.find({}).select("_id storeName");
    const results = await Promise.allSettled(sellers.map(s => reconcileSellerSettlementBalances(s._id)));
    const successList = results.filter(r => r.status === "fulfilled" && r.value).map(r => r.value);
    res.json({ success: true, count: successList.length, results: successList });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get All Sellers (with optional status filter)
export const getAllSellers = async (req, res) => {
  try {
    const { status, search } = req.query;
    const filter = {};

    if (status && ["pending", "approved", "rejected", "suspended"].includes(status)) {
      filter.status = status;
    }

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { storeName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } }
      ];
    }

    // Dynamic reconciliation of matured vs pending return window settlements for sellers
    const sellerIds = await Seller.find(filter).distinct("_id");
    if (sellerIds.length > 0) {
      await Promise.allSettled(sellerIds.map(id => reconcileSellerSettlementBalances(id)));
    }

    const sellersPromise = Seller.find(filter)
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();

    const [sellers, total, pending, approved, rejected, suspended] = await Promise.all([
      sellersPromise,
      Seller.countDocuments(),
      Seller.countDocuments({ status: "pending" }),
      Seller.countDocuments({ status: "approved" }),
      Seller.countDocuments({ status: "rejected" }),
      Seller.countDocuments({ status: "suspended" })
    ]);

    const counts = {
      total,
      pending,
      approved,
      rejected,
      suspended
    };

    res.json({
      counts,
      sellers
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch sellers", error: error.message });
  }
};

// Get Single Seller Details (KYC Documents, Bank Info, Store Details)
export const getSellerById = async (req, res) => {
  try {
    const { id } = req.params;

    const seller = await findSellerByIdOrQuery(id, "-password");
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    res.json(seller);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch seller details", error: error.message });
  }
};

// Approve Seller Application
export const approveSeller = async (req, res) => {
  try {
    const { id } = req.params;

    const seller = await findSellerByIdOrQuery(id);
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    seller.status = "approved";
    seller.rejectionReason = "";
    seller.approvedAt = new Date();
    if (req.user?.id && mongoose.Types.ObjectId.isValid(req.user.id)) {
      seller.approvedBy = req.user.id;
    } else {
      seller.approvedBy = null;
    }

    await seller.save();

    // Also update corresponding User document in DB if exists
    const userConditions = [{ _id: seller._id }];
    if (seller.email) userConditions.push({ email: seller.email.toLowerCase().trim() });
    if (seller.phone) {
      const cleanPhone = String(seller.phone).replace(/\D/g, "").slice(-10);
      if (cleanPhone) userConditions.push({ phone: { $regex: cleanPhone + "$" } });
    }

    if (userConditions.length > 0) {
      await User.updateMany(
        { $or: userConditions },
        { $set: { isSeller: true, sellerStatus: "approved", role: "Partner Merchant" } }
      );
    }

    res.json({
      message: `Seller '${seller.storeName}' has been APPROVED successfully. They can now log in and manage products.`,
      seller: {
        id: seller._id,
        _id: seller._id,
        storeName: seller.storeName,
        email: seller.email,
        status: seller.status,
        approvedAt: seller.approvedAt
      }
    });
  } catch (error) {
    console.error("approveSeller error:", error);
    res.status(500).json({ message: "Failed to approve seller", error: error.message });
  }
};

// Set Seller Application Status Back to Pending
export const setPendingSeller = async (req, res) => {
  try {
    const { id } = req.params;

    const seller = await findSellerByIdOrQuery(id);
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    seller.status = "pending";
    seller.rejectionReason = "";
    await seller.save();

    const userConditions = [{ _id: seller._id }];
    if (seller.email) userConditions.push({ email: seller.email.toLowerCase().trim() });
    if (seller.phone) {
      const cleanPhone = String(seller.phone).replace(/\D/g, "").slice(-10);
      if (cleanPhone) userConditions.push({ phone: { $regex: cleanPhone + "$" } });
    }

    if (userConditions.length > 0) {
      await User.updateMany(
        { $or: userConditions },
        { $set: { isSeller: false, sellerStatus: "pending" } }
      );
    }

    res.json({
      message: `Seller '${seller.storeName}' status reset to PENDING approval.`,
      seller: {
        id: seller._id,
        _id: seller._id,
        storeName: seller.storeName,
        status: seller.status
      }
    });
  } catch (error) {
    console.error("setPendingSeller error:", error);
    res.status(500).json({ message: "Failed to set seller status to pending", error: error.message });
  }
};

// Reject Seller Application (with reason)
export const rejectSeller = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, rejectionReason } = req.body;
    const msgReason = reason || rejectionReason;

    if (!msgReason || msgReason.trim().length === 0) {
      return res.status(400).json({
        message: "Rejection message/reason is required so the seller can know why verification failed."
      });
    }

    const seller = await findSellerByIdOrQuery(id);
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    seller.status = "rejected";
    seller.rejectionReason = msgReason.trim();
    await seller.save();

    const userConditions = [{ _id: seller._id }];
    if (seller.email) userConditions.push({ email: seller.email.toLowerCase().trim() });
    if (seller.phone) {
      const cleanPhone = String(seller.phone).replace(/\D/g, "").slice(-10);
      if (cleanPhone) userConditions.push({ phone: { $regex: cleanPhone + "$" } });
    }

    if (userConditions.length > 0) {
      await User.updateMany(
        { $or: userConditions },
        { $set: { isSeller: false, sellerStatus: "rejected" } }
      );
    }

    res.json({
      message: `Seller '${seller.storeName}' has been REJECTED with message: "${seller.rejectionReason}"`,
      seller: {
        id: seller._id,
        _id: seller._id,
        storeName: seller.storeName,
        status: seller.status,
        rejectionReason: seller.rejectionReason
      }
    });
  } catch (error) {
    console.error("rejectSeller error:", error);
    res.status(500).json({ message: "Failed to reject seller", error: error.message });
  }
};

// Toggle or Set Any Seller Account Status (approved, pending, rejected, suspended)
export const toggleSellerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason, rejectionReason } = req.body;
    const normalizedStatus = String(status || "").toLowerCase();

    if (!["approved", "pending", "rejected", "suspended"].includes(normalizedStatus)) {
      return res.status(400).json({
        message: "Status must be one of: 'approved', 'pending', 'rejected', or 'suspended'."
      });
    }

    const msgReason = reason || rejectionReason;
    if (normalizedStatus === "rejected" && (!msgReason || msgReason.trim().length === 0)) {
      return res.status(400).json({
        message: "Rejection message/reason is required when rejecting a seller."
      });
    }

    const seller = await findSellerByIdOrQuery(id);
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    seller.status = normalizedStatus;
    if (normalizedStatus === "rejected") {
      seller.rejectionReason = msgReason.trim();
    } else if (normalizedStatus === "approved" || normalizedStatus === "pending") {
      seller.rejectionReason = "";
    }
    if (normalizedStatus === "approved") {
      seller.approvedAt = new Date();
      if (req.user?.id && mongoose.Types.ObjectId.isValid(req.user.id)) {
        seller.approvedBy = req.user.id;
      } else {
        seller.approvedBy = null;
      }
    }

    await seller.save();

    const userConditions = [{ _id: seller._id }];
    if (seller.email) userConditions.push({ email: seller.email.toLowerCase().trim() });
    if (seller.phone) {
      const cleanPhone = String(seller.phone).replace(/\D/g, "").slice(-10);
      if (cleanPhone) userConditions.push({ phone: { $regex: cleanPhone + "$" } });
    }

    const userUpdates = { sellerStatus: normalizedStatus };
    if (normalizedStatus === "approved") {
      userUpdates.isSeller = true;
      userUpdates.role = "Partner Merchant";
    } else {
      userUpdates.isSeller = false;
    }
    await User.updateMany({ $or: userConditions }, { $set: userUpdates });

    res.json({
      message: `Seller '${seller.storeName}' status updated to ${normalizedStatus.toUpperCase()}.`,
      seller: {
        id: seller._id,
        _id: seller._id,
        storeName: seller.storeName,
        status: seller.status,
        rejectionReason: seller.rejectionReason
      }
    });
  } catch (error) {
    console.error("toggleSellerStatus error:", error);
    res.status(500).json({ message: "Failed to update seller status", error: error.message });
  }
};

// Update Seller Commission Rate (%)
export const updateSellerCommission = async (req, res) => {
  try {
    const { id } = req.params;
    const { commissionRate } = req.body;

    const rate = Number(commissionRate);
    if (isNaN(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ message: "Invalid commission rate. Must be a percentage between 0 and 100." });
    }

    const seller = await findSellerByIdOrQuery(id);
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    seller.commissionRate = rate;
    seller.commissionPercentage = rate;
    await seller.save();

    // Propagate updated commission to seller's orders in database
    try {
      await Order.updateMany(
        {
          $or: [
            { sellerId: seller._id },
            { "items.sellerId": seller._id },
            { "sellerDetails.sellerId": seller._id },
            { "items.sellerName": seller.storeName },
            { "items.storeName": seller.storeName },
            { sellerStoreName: seller.storeName },
            { storeName: seller.storeName }
          ]
        },
        {
          $set: {
            commissionRate: rate,
            sellerCommissionRate: rate,
            commissionPercentage: rate,
            "sellerDetails.commissionRate": rate,
            "sellerDetails.commissionPercentage": rate,
            "items.$[elem].commissionRate": rate,
            "items.$[elem].sellerCommissionRate": rate,
            "items.$[elem].commissionPercentage": rate,
            "items.$[elem].sellerDetails.commissionRate": rate,
            "items.$[elem].sellerDetails.commissionPercentage": rate
          }
        },
        {
          arrayFilters: [
            {
              $or: [
                { "elem.sellerId": { $in: [seller._id, seller._id.toString()] } },
                { "elem.sellerName": seller.storeName },
                { "elem.storeName": seller.storeName },
                { "elem.sellerStoreName": seller.storeName }
              ]
            }
          ]
        }
      );
    } catch (ordUpdateErr) {
      console.warn("Order commission update warning:", ordUpdateErr.message);
    }

    try {
      const { invalidateOrdersCache } = await import("./orderController.js");
      invalidateOrdersCache();
    } catch (cacheErr) {}

    res.json({
      message: `Commission rate for '${seller.storeName}' updated to ${rate}%.`,
      seller: {
        id: seller._id,
        _id: seller._id,
        storeName: seller.storeName,
        commissionRate: seller.commissionRate,
        commissionPercentage: seller.commissionPercentage
      }
    });
  } catch (error) {
    console.error("updateSellerCommission error:", error);
    res.status(500).json({ message: "Failed to update seller commission", error: error.message });
  }
};

// Download Official Seller Financial & Settlement Statement PDF
export const downloadSellerFinancialStatement = async (req, res) => {
  try {
    const id = req.params.id || req.seller?._id || req.user?.id || req.user?._id || req.headers["x-seller-id"];

    const seller = await findSellerByIdOrQuery(id, "-password");
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    // 1. Gather products belonging to this seller for comprehensive matching
    const sellerProducts = await Product.find({
      $or: [
        { sellerId: seller._id },
        { seller: seller._id },
        { sellerStoreName: seller.storeName },
        { storeName: seller.storeName }
      ]
    }).select("_id id name").lean();

    const productIds = sellerProducts.map(p => p._id.toString());

    // 2. Fetch all matching orders for this seller
    const orderConditions = [
      { sellerId: seller._id },
      { "items.sellerId": seller._id },
      { storeName: seller.storeName },
      { "items.storeName": seller.storeName }
    ];

    if (productIds.length > 0) {
      orderConditions.push(
        { "items.productId": { $in: productIds } },
        { "items.id": { $in: productIds } }
      );
    }

    const rawOrders = await Order.find({ $or: orderConditions }).sort({ createdAt: -1 }).lean();

    // 3. Normalize and enrich matching orders
    const enrichedOrders = [];
    let grossSales = 0;
    let platformCut = 0;
    let totalGstOnCommission = 0;
    let totalTds = 0;
    let totalGstTcs = 0;
    let totalDeliveryDeduction = 0;
    let totalDeductions = 0;
    let finalSettlementTotal = 0;
    let totalGst = 0;
    let codVolume = 0;
    let codCount = 0;
    let upiVolume = 0;
    let upiCount = 0;

    const commissionRate = Number(seller.commissionRate ?? seller.commissionPercentage ?? 10);

    rawOrders.forEach(o => {
      const itemsList = Array.isArray(o.items) ? o.items : [];
      // Filter items that belong to this seller
      const sellerItems = itemsList.filter(item => {
        const itemSellerId = String(item.sellerId?._id || item.sellerId || '');
        const itemStore = String(item.storeName || '').toLowerCase().trim();
        const itemProdId = String(item.productId?._id || item.productId || item.id || '');
        return (
          itemSellerId === String(seller._id) ||
          (seller.storeName && itemStore === seller.storeName.toLowerCase().trim()) ||
          productIds.includes(itemProdId)
        );
      });

      const relevantItems = sellerItems.length > 0 ? sellerItems : itemsList;
      const orderSubtotal = relevantItems.reduce((acc, item) => {
        const lineTotal = Number(item.total) || (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1));
        return acc + lineTotal;
      }, 0);

      const effectiveTotal = orderSubtotal > 0 ? orderSubtotal : Number(o.totalAmount || o.total || 0);
      const ordTotalVal = Number(o.totalAmount || o.total || effectiveTotal);
      const isCancelled = String(o.overallStatus || o.status || '').toLowerCase().includes('cancel');

      const isCod = String(o.paymentMethod || '').toUpperCase().includes('COD');

      const itemGst = relevantItems.reduce((sum, it) => {
        const itPrice = (Number(it.finalPrice || it.price || 0) * Number(it.quantity || 1));
        const explicitGst = it.gstPercent ?? it.gstPercentage ?? it.gstRate ?? it.gst ?? 5;
        const rate = !isNaN(Number(explicitGst)) ? Number(explicitGst) : 5;
        return sum + (itPrice - (itPrice / (1 + rate / 100)));
      }, 0);

      const sellerState = seller.state || seller.storeDetails?.state || "Uttar Pradesh";
      const customerState = o.shippingAddress?.state || "Uttar Pradesh";
      const stl = calculateSellerSettlement(effectiveTotal, {
        commissionRate,
        paymentMethod: o.paymentMethod || "UPI",
        deliveryMode: o.deliveryMode || "self_delivery",
        courierName: o.courierName,
        orderTotal: ordTotalVal,
        sellerState,
        customerState,
        deliveryCharge: o.shippingAmount || o.deliveryCharge || 40,
        freeDeliveryThreshold: Number(o.freeDeliveryThreshold ?? 401),
        deliveryChargeBorneBy: o.deliveryChargeBorneBy || (ordTotalVal >= Number(o.freeDeliveryThreshold ?? 401) ? 'admin' : (Number(o.shippingAmount || 0) > 0 ? 'customer' : 'seller'))
      });

      if (!isCancelled) {
        grossSales += effectiveTotal;
        platformCut += stl.commissionAmount;
        totalGstOnCommission += stl.gstOnCommissionAmount;
        totalTds += stl.tdsAmount;
        totalGstTcs += stl.gstTcsAmount;
        totalDeliveryDeduction += stl.totalDeliveryDeduction;
        totalDeductions += stl.totalDeductions;
        finalSettlementTotal += stl.netSettlement;
        totalGst += itemGst;

        if (isCod) {
          codVolume += effectiveTotal;
          codCount += 1;
        } else {
          upiVolume += effectiveTotal;
          upiCount += 1;
        }
      }

      enrichedOrders.push({
        ...o,
        orderId: o.orderId || o.id || String(o._id || ''),
        sellerSubtotal: effectiveTotal,
        total: effectiveTotal,
        commissionRate,
        isCod,
        date: o.date ? o.date : (o.createdAt ? new Date(o.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : 'Recent'),
        customerName: o.customerName || o.customer?.name || o.shippingAddress?.name || 'Verified Consumer',
        settlement: stl
      });
    });

    const netEarnings = Math.max(0, Math.round(finalSettlementTotal * 100) / 100);

    const metrics = {
      grossSales: Math.round(grossSales * 100) / 100,
      commissionRate,
      platformCut: Math.round(platformCut * 100) / 100,
      portalCommission: Math.round(platformCut * 100) / 100,
      gstOnCommission: Math.round(totalGstOnCommission * 100) / 100,
      tds: Math.round(totalTds * 100) / 100,
      gstTcs: Math.round(totalGstTcs * 100) / 100,
      deliveryDeduction: Math.round(totalDeliveryDeduction * 100) / 100,
      totalDeductions: Math.round(totalDeductions * 100) / 100,
      netEarnings,
      finalSettlement: netEarnings,
      totalGst: Math.round(totalGst * 100) / 100,
      codVolume,
      codCount,
      upiVolume,
      upiCount,
      payableBalance: seller.walletBalance || 0,
      settledVolume: seller.totalWithdrawn || 0
    };

    const cleanStoreName = (seller.storeName || 'Vendor').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `Financial_Statement_${cleanStoreName}_${Date.now()}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const pdfDoc = generateSellerFinancialStatementPDF(seller, enrichedOrders, metrics);
    pdfDoc.pipe(res);
  } catch (error) {
    console.error("Error generating seller financial statement PDF:", error);
    res.status(500).json({ message: "Failed to generate financial statement PDF", error: error.message });
  }
};

