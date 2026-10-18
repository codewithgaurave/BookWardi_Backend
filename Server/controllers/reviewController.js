import mongoose from "mongoose";
import Review from "../models/Review.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";

// Helper to recalculate averageRating and numReviews on Product document in MongoDB
export const recalculateProductRating = async (productId) => {
  if (!productId) return { averageRating: 0, numReviews: 0 };
  try {
    const productQuery = [
      { productId: productId },
      { productId: String(productId) }
    ];
    if (!isNaN(productId)) {
      productQuery.push({ productId: Number(productId) });
    }

    const allReviews = await Review.find({ $or: productQuery });
    const count = allReviews.length;
    const avgRating = count > 0
      ? Math.round((allReviews.reduce((sum, r) => sum + (Number(r.rating) || 0), 0) / count) * 10) / 10
      : 0;

    // Look up target product by ObjectId, numeric id, or string id
    let product = null;
    if (mongoose.Types.ObjectId.isValid(productId)) {
      product = await Product.findById(productId);
    }
    if (!product) {
      product = await Product.findOne({
        $or: [
          { id: productId },
          { id: String(productId) }
        ]
      });
    }

    if (product) {
      product.averageRating = avgRating;
      product.numReviews = count;
      await product.save();
      console.log(`⭐ [RATING RECALCULATED] Product ${product._id} (${product.name}) -> averageRating: ${avgRating}, numReviews: ${count}`);
    }

    return { averageRating: avgRating, numReviews: count };
  } catch (err) {
    console.error("Failed to recalculate product rating:", err);
    return { averageRating: 0, numReviews: 0 };
  }
};

// 1. Add / Update Product Review
export const addReview = async (req, res) => {
  try {
    const { productId, rating, comment, title, images, userName, name, institution } = req.body;

    if (!productId || !rating || !comment) {
      return res.status(400).json({ message: "Product ID, rating (1-5), and comment are required" });
    }

    const userId =
      req.user?.id ||
      req.headers?.["x-user-id"] ||
      req.headers?.["x-user-phone"] ||
      req.body?.phone ||
      req.body?.userId ||
      `anon_${Date.now()}`;

    const displayName = userName || name || req.user?.name || "Verified Customer";
    const displayInstitution = institution || req.user?.institution || "Verified Customer";

    // Default status to pending for customer reviews, approved for seller/admin
    const initialStatus = (req.user?.role === "admin" || req.user?.role === "seller") ? "approved" : "pending";

    // Check if verified purchaser
    let hasPurchased = false;
    try {
      if (req.user?.id) {
        hasPurchased = !!(await Order.findOne({
          userId: req.user.id,
          "items.productId": productId,
          overallStatus: { $in: ["delivered", "completed", "shipped"] }
        }));
      }
    } catch (e) {}

    // Check if review already exists
    let review = await Review.findOne({
      $or: [
        { productId: productId, userId: userId },
        { productId: String(productId), userId: String(userId) }
      ]
    });

    if (review) {
      review.rating = Number(rating);
      review.comment = comment;
      review.title = title || review.title || "";
      review.userName = displayName;
      review.institution = displayInstitution;
      if (images) review.images = images;
      review.verifiedPurchase = hasPurchased;
      review.status = initialStatus;
      await review.save();
    } else {
      review = await Review.create({
        productId,
        userId,
        userName: displayName,
        institution: displayInstitution,
        rating: Number(rating),
        title: title || "",
        comment,
        images: images || [],
        verifiedPurchase: hasPurchased,
        status: initialStatus
      });
    }

    // Immediately recalculate Product averageRating and numReviews in MongoDB
    const { averageRating, numReviews } = await recalculateProductRating(productId);

    const formattedReview = {
      id: review._id,
      name: review.userName,
      institution: review.institution || "Verified Customer",
      rating: review.rating,
      date: "Just now",
      title: review.title || "",
      comment: review.comment,
      images: review.images || [],
      verifiedPurchase: review.verifiedPurchase,
      status: review.status,
      helpfulCount: 0,
      createdAt: review.createdAt
    };

    res.status(201).json({
      message: "Review submitted successfully and rating updated",
      review: formattedReview,
      averageRating,
      numReviews
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to submit review", error: error.message });
  }
};

// 2. Get Reviews for a Product (Public endpoint returns ONLY seller-approved reviews)
export const getProductReviews = async (req, res) => {
  try {
    const { productId } = req.params;
    const includePending = req.query.includePending === "true";

    const productQuery = [
      { productId: productId },
      { productId: String(productId) }
    ];
    if (!isNaN(productId)) {
      productQuery.push({ productId: Number(productId) });
    }

    let filter = { $or: productQuery };

    // Unless explicitly requesting pending reviews, filter to return only seller-approved reviews
    if (!includePending) {
      filter = {
        $and: [
          { $or: productQuery },
          { $or: [{ status: "approved" }, { status: { $exists: false } }] }
        ]
      };
    }

    const reviews = await Review.find(filter).sort({ createdAt: -1 });

    // Map seller legal business names for reviews
    const sellerLegalNameMap = {};
    try {
      const Seller = (await import("../models/Seller.js")).default;
      const productIds = [...new Set(reviews.map((r) => r.productId).filter(Boolean))];
      if (productIds.length > 0) {
        const validObjectIds = productIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
        const products = await Product.find({
          $or: [
            ...(validObjectIds.length > 0 ? [{ _id: { $in: validObjectIds } }] : []),
            { id: { $in: productIds } }
          ]
        }).select("_id id sellerId sellerName sellerStoreName legalBusinessName storeName");

        const sellerIds = [...new Set(products.map((p) => p.sellerId).filter(Boolean))];
        const validSellerObjectIds = sellerIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
        const strSellerIds = sellerIds.map(String);
        const sellers = sellerIds.length > 0
          ? await Seller.find({
              $or: [
                ...(validSellerObjectIds.length > 0 ? [{ _id: { $in: validSellerObjectIds } }] : []),
                { storeName: { $in: strSellerIds } },
                { name: { $in: strSellerIds } }
              ]
            }).select("_id legalBusinessName storeName name")
          : [];

        const sellerMap = {};
        sellers.forEach((s) => {
          sellerMap[String(s._id)] = s.legalBusinessName || s.storeName || s.name || "";
        });

        products.forEach((p) => {
          const legalName = p.legalBusinessName || p.sellerName || p.sellerStoreName || p.storeName || (p.sellerId ? sellerMap[String(p.sellerId)] : "") || "";
          if (legalName) {
            sellerLegalNameMap[String(p._id)] = legalName;
            if (p.id) sellerLegalNameMap[String(p.id)] = legalName;
          }
        });
      }
    } catch (e) {}

    const formattedReviews = reviews.map((r) => {
      const sellerLegalName = r.legalBusinessName || r.sellerName || r.storeName || sellerLegalNameMap[String(r.productId)] || "";
      return {
        id: r._id,
        _id: r._id,
        name: r.userName || "Verified Customer",
        institution: r.institution || "Verified Customer",
        rating: r.rating,
        date: r.createdAt ? new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "Recently",
        title: r.title || "",
        comment: r.comment,
        images: r.images || [],
        verifiedPurchase: r.verifiedPurchase || false,
        status: r.status || "approved",
        reply: r.reply || "",
        sellerReply: r.reply || "",
        repliedAt: r.repliedAt || null,
        sellerId: r.sellerId || null,
        sellerName: sellerLegalName,
        legalBusinessName: sellerLegalName,
        storeName: sellerLegalName,
        helpfulCount: 0,
        createdAt: r.createdAt
      };
    });

    res.json(formattedReviews);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch reviews", error: error.message });
  }
};

// 3. Update Review Approval Status (Seller or Admin Approval)
export const updateReviewStatus = async (req, res) => {
  try {
    const { id } = req.params;
    let { status } = req.body; // 'approved' | 'rejected' | 'pending' | 'Approved' | 'Hidden'

    if (typeof status === "string") {
      const lower = status.toLowerCase();
      if (lower === "approved") status = "approved";
      else if (lower === "hidden" || lower === "rejected") status = "rejected";
      else if (lower === "pending" || lower.includes("pending")) status = "pending";
    }

    if (!["approved", "rejected", "pending"].includes(status)) {
      return res.status(400).json({ message: "Status must be 'approved', 'rejected', or 'pending'" });
    }

    let review = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      review = await Review.findById(id);
    }
    if (!review) {
      review = await Review.findOne({ $or: [{ id: id }, { id: String(id) }] });
    }
    if (!review) {
      return res.status(404).json({ message: "Review not found" });
    }

    review.status = status;
    await review.save();

    // Recalculate rating on product
    const { averageRating, numReviews } = await recalculateProductRating(review.productId);

    res.json({ message: `Review status updated to ${status}`, review, averageRating, numReviews });
  } catch (error) {
    res.status(500).json({ message: "Failed to update review status", error: error.message });
  }
};

// 4. Delete Review
export const deleteReview = async (req, res) => {
  try {
    let review = null;
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      review = await Review.findById(req.params.id);
    }
    if (!review) {
      review = await Review.findOne({ $or: [{ id: req.params.id }, { id: String(req.params.id) }] });
    }
    if (!review) {
      return res.status(404).json({ message: "Review not found" });
    }

    const requesterId = req.user?.id || req.headers["x-user-id"] || req.headers["x-user-phone"];
    if (requesterId && review.userId && review.userId.toString() !== requesterId.toString() && req.user?.role !== "admin") {
      return res.status(403).json({ message: "Not authorized to delete this review" });
    }

    const productId = review.productId;
    if (mongoose.Types.ObjectId.isValid(review._id)) {
      await Review.findByIdAndDelete(review._id);
    } else {
      await Review.deleteOne({ _id: review._id });
    }

    // Recalculate rating on product
    const { averageRating, numReviews } = await recalculateProductRating(productId);

    res.json({ message: "Review deleted successfully", averageRating, numReviews });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete review", error: error.message });
  }
};

// 5. Get All Reviews for Admin Moderation
export const getAllReviews = async (req, res) => {
  try {
    const reviews = await Review.find().sort({ createdAt: -1 });

    const productIds = [...new Set(reviews.map((r) => r.productId).filter(Boolean))];
    const validObjectIds = productIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    
    let products = [];
    if (productIds.length > 0) {
      products = await Product.find({
        $or: [
          ...(validObjectIds.length > 0 ? [{ _id: { $in: validObjectIds } }] : []),
          { id: { $in: productIds } }
        ]
      }).select("_id id name title");
    }
    
    const productMap = {};
    products.forEach((p) => {
      const key = String(p._id);
      productMap[key] = p.name || p.title || "Product";
      if (p.id) productMap[String(p.id)] = p.name || p.title || "Product";
    });

    const formatted = reviews.map((r) => {
      const statusTitle =
        r.status === "approved" ? "Approved" : r.status === "rejected" ? "Hidden" : "Pending Approval";
      return {
        id: r._id,
        _id: r._id,
        productId: r.productId,
        productName: productMap[String(r.productId)] || "Product",
        customerName: r.userName || "Verified Customer",
        userName: r.userName || "Verified Customer",
        institution: r.institution || "Verified Customer",
        rating: r.rating,
        comment: r.comment,
        title: r.title || "",
        images: r.images || [],
        verifiedPurchase: r.verifiedPurchase || false,
        status: statusTitle,
        rawStatus: r.status,
        reply: r.reply || "",
        repliedAt: r.repliedAt || null,
        date: r.createdAt
          ? new Date(r.createdAt).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
              year: "numeric"
            })
          : "Recently",
        createdAt: r.createdAt
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error("Failed to fetch all reviews:", error);
    res.status(500).json({ message: "Failed to fetch all reviews", error: error.message });
  }
};

// 6. Get All Reviews for Logged-in Seller's Products
export const getSellerReviews = async (req, res) => {
  try {
    const rawIds = [
      req.user?.id,
      req.seller?._id,
      req.seller?.id,
      req.user?._id,
      req.headers["x-seller-id"],
      req.query.sellerId
    ].filter(Boolean);

    const validSellerObjectIds = rawIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const strSellerIds = rawIds.map(String);

    if (rawIds.length === 0) {
      return res.json([]);
    }

    const sellerProducts = await Product.find({
      $or: [
        ...(validSellerObjectIds.length > 0
          ? [{ sellerId: { $in: validSellerObjectIds } }, { seller: { $in: validSellerObjectIds } }]
          : []),
        { sellerId: { $in: strSellerIds } },
        { seller: { $in: strSellerIds } }
      ]
    }).select("_id id name title");

    const productIds = sellerProducts.map((p) => p._id);
    const strProductIds = productIds.map((id) => String(id));
    const customProductIds = sellerProducts.map((p) => p.id).filter(Boolean);
    const numericProductIds = customProductIds.map(Number).filter((n) => !isNaN(n));
    const allProductKeys = [...new Set([...productIds, ...strProductIds, ...customProductIds, ...numericProductIds])];

    let filter = {};
    if (allProductKeys.length > 0) {
      filter = {
        $or: [
          { productId: { $in: allProductKeys } },
          ...(strSellerIds.length > 0 ? [{ sellerId: { $in: strSellerIds } }] : [])
        ]
      };
    } else if (strSellerIds.length > 0) {
      filter = { sellerId: { $in: strSellerIds } };
    }

    const reviews = await Review.find(filter).sort({ createdAt: -1 });

    const allProductIds = [...new Set(reviews.map((r) => r.productId).filter(Boolean))];
    const validObjectIds = allProductIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const products = allProductIds.length > 0 ? await Product.find({
      $or: [
        ...(validObjectIds.length > 0 ? [{ _id: { $in: validObjectIds } }] : []),
        { id: { $in: allProductIds } }
      ]
    }).select("_id id name title") : [];

    const productMap = {};
    products.forEach((p) => {
      productMap[String(p._id)] = p.name || p.title || "Product";
      if (p.id) productMap[String(p.id)] = p.name || p.title || "Product";
    });

    const formatted = reviews.map((r) => {
      const statusTitle =
        r.status === "approved" ? "Approved" : r.status === "rejected" ? "Hidden" : "Pending Approval";
      return {
        id: r._id,
        _id: r._id,
        productId: r.productId,
        productName: productMap[String(r.productId)] || "Product Review",
        customerName: r.userName || "Verified Customer",
        name: r.userName || "Verified Customer",
        rating: r.rating || 5,
        comment: r.comment || "",
        title: r.title || "",
        images: r.images || [],
        status: statusTitle,
        rawStatus: r.status,
        reply: r.reply || "",
        repliedAt: r.repliedAt || null,
        date: r.createdAt
          ? new Date(r.createdAt).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
              year: "numeric"
            })
          : "Recently",
        createdAt: r.createdAt
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error("Failed to fetch seller reviews:", error);
    res.status(500).json({ message: "Failed to fetch seller reviews", error: error.message });
  }
};

// 7. Post Official Seller Reply to Customer Review
export const replyToSellerReview = async (req, res) => {
  try {
    const { id } = req.params;
    const replyContent = req.body.replyText || req.body.reply || "";

    if (!replyContent || !String(replyContent).trim()) {
      return res.status(400).json({ message: "Reply text is required" });
    }

    let review = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      review = await Review.findById(id);
    }
    if (!review) {
      review = await Review.findOne({ $or: [{ _id: id }, { id: id }] });
    }

    if (!review) {
      return res.status(404).json({ message: "Review not found" });
    }

    let legalName = req.body.legalBusinessName || req.body.sellerName || req.body.storeName || req.user?.legalBusinessName || req.user?.storeName || req.user?.name || "";
    if (!legalName && req.user?.id) {
      try {
        const Seller = (await import("../models/Seller.js")).default;
        const seller = await Seller.findById(req.user.id);
        if (seller) {
          legalName = seller.legalBusinessName || seller.storeName || seller.name || "";
        }
      } catch (e) {}
    }
    if (!legalName && review.productId) {
      try {
        const Product = (await import("../models/Product.js")).default;
        const product = await Product.findOne({ $or: [{ _id: review.productId }, { id: review.productId }] });
        if (product) {
          legalName = product.legalBusinessName || product.sellerName || product.sellerStoreName || product.storeName || "";
          if (!legalName && product.sellerId) {
            const Seller = (await import("../models/Seller.js")).default;
            const seller = await Seller.findById(product.sellerId);
            if (seller) {
              legalName = seller.legalBusinessName || seller.storeName || seller.name || "";
            }
          }
        }
      } catch (e) {}
    }

    review.reply = String(replyContent).trim();
    review.repliedAt = new Date();
    if (legalName) {
      review.legalBusinessName = legalName;
      review.sellerName = legalName;
      review.storeName = legalName;
    }
    await review.save();

    console.log(`💬 [REVIEW REPLY SAVED TO DB] Review ID: ${review._id} -> Reply: "${review.reply}"`);

    res.json({
      success: true,
      message: "Reply saved to MongoDB database successfully!",
      review
    });
  } catch (error) {
    console.error("Reply to review error:", error);
    res.status(500).json({ message: "Failed to post review reply", error: error.message });
  }
};
