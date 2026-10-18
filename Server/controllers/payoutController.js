import mongoose from "mongoose";
import Payout from "../models/Payout.js";
import Seller from "../models/Seller.js";
import Order from "../models/Order.js";
import { reconcileSellerSettlementBalances } from "../services/settlementService.js";

// 1. Get Seller Wallet & Financial Overview
export const getSellerWalletOverview = async (req, res) => {
  try {
    const sellerId = req.user?.id;
    const isValidId = sellerId && mongoose.Types.ObjectId.isValid(sellerId);
    if (!isValidId) {
      return res.json({
        wallet: { walletBalance: 0, pendingSettlementBalance: 0, totalEarnings: 0, totalWithdrawn: 0, commissionPercentage: 5, commissionRate: 5, bankDetails: {} },
        recentPayouts: [],
        deliveredOrdersCount: 0
      });
    }

    // Run dynamic reconciliation of matured vs pending return window settlements
    await reconcileSellerSettlementBalances(sellerId);

    const seller = await Seller.findById(sellerId).select(
      "walletBalance pendingSettlementBalance totalEarnings totalWithdrawn commissionPercentage commissionRate bankDetails"
    );

    if (!seller) {
      return res.json({
        wallet: { walletBalance: 0, pendingSettlementBalance: 0, totalEarnings: 0, totalWithdrawn: 0, commissionPercentage: 5, commissionRate: 5, bankDetails: {} },
        recentPayouts: [],
        deliveredOrdersCount: 0
      });
    }
    // Recent Payout Requests
    const recentPayouts = await Payout.find({ sellerId }).sort({ createdAt: -1 }).limit(10);

    // Delivered & Exchanged Orders Earnings Breakdown
    const deliveredOrders = await Order.find({
      "items.sellerId": sellerId,
      overallStatus: { $in: ["delivered", "Delivered", "exchanged", "Exchanged"] }
    }).select("orderId items createdAt totalAmount overallStatus");

    res.json({
      wallet: {
        walletBalance: seller.walletBalance || 0,
        pendingSettlementBalance: seller.pendingSettlementBalance || 0,
        totalEarnings: seller.totalEarnings || 0,
        totalWithdrawn: seller.totalWithdrawn || 0,
        commissionPercentage: seller.commissionPercentage ?? seller.commissionRate ?? 5,
        commissionRate: seller.commissionRate ?? seller.commissionPercentage ?? 5,
        bankDetails: seller.bankDetails
      },
      recentPayouts,
      deliveredOrdersCount: deliveredOrders.length
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch wallet overview", error: error.message });
  }
};

// 2. Request Payout / Withdrawal
export const requestPayout = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { amount, notes } = req.body;

    const withdrawAmount = Number(amount);
    if (!withdrawAmount || withdrawAmount < 100) {
      return res.status(400).json({ message: "Minimum withdrawal amount is ₹100." });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    if (seller.walletBalance < withdrawAmount) {
      return res.status(400).json({
        message: `Insufficient wallet balance. Available: ₹${seller.walletBalance}, Requested: ₹${withdrawAmount}`
      });
    }

    if (!seller.bankDetails?.accountNumber || !seller.bankDetails?.ifscCode) {
      return res.status(400).json({
        message: "Please add your complete bank account details in profile before requesting payout."
      });
    }

    // Deduct from wallet balance atomically
    seller.walletBalance -= withdrawAmount;
    await seller.save();

    const payout = await Payout.create({
      sellerId,
      amount: withdrawAmount,
      bankDetails: {
        accountHolderName: seller.bankDetails.accountHolderName || seller.name,
        accountNumber: seller.bankDetails.accountNumber,
        ifscCode: seller.bankDetails.ifscCode,
        bankName: seller.bankDetails.bankName || ""
      },
      notes: notes || ""
    });

    res.status(201).json({
      message: "Payout request submitted successfully! Admin will process the transfer.",
      payout,
      remainingWalletBalance: seller.walletBalance
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to submit payout request", error: error.message });
  }
};

// 3. Admin: Get All Payout Requests
export const getAllPayoutsAdmin = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};

    const payouts = await Payout.find(filter)
      .populate("sellerId", "name storeName email phone bankDetails walletBalance")
      .sort({ createdAt: -1 });

    res.json(payouts);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch payouts", error: error.message });
  }
};

// 4. Admin: Process / Reject Payout Request
export const processPayoutAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, transactionReference, rejectionReason } = req.body; // action: 'approve' | 'reject'

    const payout = await Payout.findById(id);
    if (!payout) {
      return res.status(404).json({ message: "Payout request not found" });
    }

    if (payout.status !== "pending") {
      return res.status(400).json({ message: `Payout is already ${payout.status}` });
    }

    const seller = await Seller.findById(payout.sellerId);

    if (action === "approve") {
      payout.status = "processed";
      payout.transactionReference = transactionReference || `UTR_${Date.now()}`;
      payout.processedAt = new Date();
      payout.processedBy = req.user.id;

      if (seller) {
        seller.totalWithdrawn = (seller.totalWithdrawn || 0) + payout.amount;
        await seller.save();
      }
    } else if (action === "reject") {
      payout.status = "rejected";
      payout.rejectionReason = rejectionReason || "Bank verification failed / Details mismatch";
      payout.processedAt = new Date();
      payout.processedBy = req.user.id;

      // Refund amount back to seller's wallet balance
      if (seller) {
        seller.walletBalance = (seller.walletBalance || 0) + payout.amount;
        await seller.save();
      }
    } else {
      return res.status(400).json({ message: "Invalid action. Use 'approve' or 'reject'." });
    }

    await payout.save();

    res.json({
      message: `Payout request ${action === "approve" ? "approved & processed" : "rejected and refunded to seller wallet"}.`,
      payout
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to process payout", error: error.message });
  }
};
