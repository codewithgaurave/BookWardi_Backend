import { Parser } from "json2csv";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import User from "../models/User.js";
import Seller from "../models/Seller.js";
import Payout from "../models/Payout.js";

// 1. Admin: Export All Orders to Excel/CSV
export const exportOrdersAdmin = async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("userId", "name email phone")
      .populate("items.sellerId", "storeName phone")
      .sort({ createdAt: -1 });

    const flatData = [];
    orders.forEach((order) => {
      order.items.forEach((item) => {
        flatData.push({
          "Order ID": order.orderId || order._id.toString(),
          "Order Date": new Date(order.createdAt).toISOString().split("T")[0],
          "Customer Name": order.customer?.name || order.userId?.name || "N/A",
          "Customer Phone": order.customer?.phone || order.userId?.phone || "N/A",
          "Customer Email": order.customer?.email || order.userId?.email || "N/A",
          "Shipping Address": `${order.shippingAddress?.street || order.address || ""}, ${order.shippingAddress?.city || ""}, ${order.shippingAddress?.state || ""}`,
          "Product Name": item.name,
          "Size": item.size || "Standard",
          "Age": item.age || "Standard",
          "Quantity": item.quantity,
          "Unit Price (INR)": item.finalPrice || item.price,
          "Item Total (INR)": (item.finalPrice || item.price) * item.quantity,
          "Seller Store": item.sellerId?.storeName || "Direct / Admin",
          "Delivery Method": item.deliveryType || "Standard",
          "Payment Method": order.paymentMethod,
          "Payment Status": order.paymentStatus.toUpperCase(),
          "Order Status": order.overallStatus.toUpperCase(),
          "Razorpay ID": order.razorpayPaymentId || "N/A"
        });
      });
    });

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(flatData);

    res.setHeader("Content-Type", "text/csv");
    res.attachment(`SchoolKart_Orders_Report_${Date.now()}.csv`);
    return res.send(csv);
  } catch (error) {
    console.error("Export orders error:", error);
    res.status(500).json({ message: "Failed to export orders data", error: error.message });
  }
};

// 2. Admin: Export Products Catalog to Excel/CSV
export const exportProductsAdmin = async (req, res) => {
  try {
    const products = await Product.find().populate("sellerId", "storeName").sort({ createdAt: -1 });

    const flatData = products.map((p) => ({
      "Product ID": p._id.toString(),
      "Product Name": p.name,
      "Category": p.category,
      "Sub Category": p.subCategory || "",
      "School Name": p.schoolName || "",
      "Gender": p.gender || "Unisex",
      "Age Group": p.ageGroup || "",
      "Available Sizes": (p.sizes || []).join(", "),
      "MRP (INR)": p.mrp || p.price,
      "Selling Price (INR)": p.price,
      "Discount %": p.discountPercentage || 0,
      "Stock": p.stock,
      "Status": p.status,
      "Rating": p.averageRating || 0,
      "Reviews Count": p.numReviews || 0,
      "Seller": p.sellerId?.storeName || "In-House"
    }));

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(flatData);

    res.setHeader("Content-Type", "text/csv");
    res.attachment(`SchoolKart_Products_Catalog_${Date.now()}.csv`);
    return res.send(csv);
  } catch (error) {
    res.status(500).json({ message: "Failed to export products catalog", error: error.message });
  }
};

// 3. Admin: Export Users / Customers Data
export const exportUsersAdmin = async (req, res) => {
  try {
    const users = await User.find({ role: "user" }).select("-password").sort({ createdAt: -1 });

    const flatData = users.map((u) => ({
      "User ID": u._id.toString(),
      "Name": u.name,
      "Email": u.email,
      "Phone": u.phone || "N/A",
      "Total Saved Addresses": u.addresses?.length || 0,
      "Status": u.status,
      "Joined Date": new Date(u.createdAt).toISOString().split("T")[0]
    }));

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(flatData);

    res.setHeader("Content-Type", "text/csv");
    res.attachment(`SchoolKart_Customers_List_${Date.now()}.csv`);
    return res.send(csv);
  } catch (error) {
    res.status(500).json({ message: "Failed to export users data", error: error.message });
  }
};

// 4. Admin: Export Sellers & Payouts Report
export const exportSellersAdmin = async (req, res) => {
  try {
    const sellers = await Seller.find().select("-password").sort({ createdAt: -1 });

    const flatData = sellers.map((s) => ({
      "Seller ID": s._id.toString(),
      "Store Name": s.storeName,
      "Owner Name": s.name,
      "Email": s.email,
      "Phone": s.phone,
      "City": s.city,
      "State": s.state,
      "Self Delivery": s.deliveryPreferences?.selfDelivery ? "Yes" : "No",
      "Delivery Radius (KM)": s.deliveryPreferences?.maxDeliveryRadiusKm || 10,
      "Wallet Balance (INR)": s.walletBalance || 0,
      "Total Earnings (INR)": s.totalEarnings || 0,
      "Total Withdrawn (INR)": s.totalWithdrawn || 0,
      "Platform Fee %": s.commissionPercentage || 5,
      "Status": s.status.toUpperCase()
    }));

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(flatData);

    res.setHeader("Content-Type", "text/csv");
    res.attachment(`SchoolKart_Sellers_Report_${Date.now()}.csv`);
    return res.send(csv);
  } catch (error) {
    res.status(500).json({ message: "Failed to export sellers data", error: error.message });
  }
};

// 5. Seller: Export Own Orders to Excel/CSV
export const exportSellerOrders = async (req, res) => {
  try {
    const sellerId = req.user?.id || req.user?._id || req.seller?._id || req.seller?.id || req.headers["x-seller-id"];
    const orders = await Order.find({
      $or: [
        { "items.sellerId": sellerId },
        { sellerId: sellerId }
      ]
    }).sort({ createdAt: -1 });

    const flatData = [];
    orders.forEach((order) => {
      const sellerItems = (order.items || []).filter(
        (item) => !sellerId || (item.sellerId && String(item.sellerId._id || item.sellerId) === String(sellerId))
      );

      const itemsToExport = sellerItems.length > 0 ? sellerItems : (order.items || []);

      itemsToExport.forEach((item) => {
        flatData.push({
          "Order ID": order.orderId || order._id.toString(),
          "Order Date": order.createdAt ? new Date(order.createdAt).toISOString().split("T")[0] : "N/A",
          "Customer Name": order.customer?.name || order.userName || "Customer",
          "Customer Phone": order.customer?.phone || order.userPhone || "N/A",
          "Delivery Address": typeof order.shippingAddress === "string" ? order.shippingAddress : `${order.shippingAddress?.street || order.address || ""}, ${order.shippingAddress?.city || ""}`,
          "Product Name": item.name || "Product Item",
          "Size": item.size || "Standard",
          "Age": item.age || "Standard",
          "Quantity": item.quantity || 1,
          "Unit Price (INR)": item.finalPrice || item.price || 0,
          "Total Revenue (INR)": (item.finalPrice || item.price || 0) * (item.quantity || 1),
          "Fulfillment Type": item.deliveryType || order.deliveryMode || "Standard",
          "Item Status": String(item.status || order.overallStatus || order.status || "Pending").toUpperCase(),
          "Payment Status": String(order.paymentStatus || "Pending").toUpperCase()
        });
      });
    });

    const fields = [
      "Order ID", "Order Date", "Customer Name", "Customer Phone", "Delivery Address",
      "Product Name", "Size", "Age", "Quantity", "Unit Price (INR)", "Total Revenue (INR)",
      "Fulfillment Type", "Item Status", "Payment Status"
    ];
    const json2csvParser = new Parser({ fields });
    const csv = json2csvParser.parse(flatData);

    const filename = `My_Store_Orders_${Date.now()}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (typeof res.attachment === "function") {
      res.attachment(filename);
    }
    return res.send(csv);
  } catch (error) {
    console.error("Export seller orders error:", error);
    res.status(500).json({ message: "Failed to export seller orders", error: error.message });
  }
};
