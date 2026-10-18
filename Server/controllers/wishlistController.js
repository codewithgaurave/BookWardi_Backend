import Wishlist from "../models/Wishlist.js";

// Helper to extract product ID as string
const extractId = (item) => {
  if (item === null || item === undefined) return null;
  if (typeof item === 'object') {
    return String(item.id || item.productId || item._id || '');
  }
  return String(item);
};

// Helper to find or create wishlist for user
const getOrCreateWishlist = async (userId, userPhone) => {
  const query = [];
  if (userId) {
    query.push({ userId });
    query.push({ userId: String(userId) });
  }
  if (userPhone && String(userPhone).trim()) {
    query.push({ userPhone: String(userPhone).trim() });
  }

  let wishlist = null;
  if (query.length > 0) {
    wishlist = await Wishlist.findOne({ $or: query });
  }

  if (!wishlist) {
    wishlist = await Wishlist.create({
      userId: userId || null,
      userPhone: userPhone ? String(userPhone).trim() : "",
      products: [],
      items: []
    });
  } else {
    let updated = false;
    if (userId && !wishlist.userId) {
      wishlist.userId = userId;
      updated = true;
    }
    if (userPhone && !wishlist.userPhone) {
      wishlist.userPhone = String(userPhone).trim();
      updated = true;
    }
    if (updated) {
      await wishlist.save();
    }
  }

  return wishlist;
};

// Helper to synchronize items and products in wishlist
const getNormalizedWishlistData = (wishlist) => {
  const rawItems = Array.isArray(wishlist.items) ? wishlist.items.map(String) : [];
  const rawProducts = Array.isArray(wishlist.products) ? wishlist.products : [];

  const itemsSet = new Set(rawItems);
  const productsMap = new Map();

  // Populate from products array first
  rawProducts.forEach((p) => {
    if (p && typeof p === 'object') {
      const idStr = extractId(p);
      if (idStr) {
        itemsSet.add(idStr);
        productsMap.set(idStr, p);
      }
    } else if (p !== null && p !== undefined) {
      itemsSet.add(String(p));
    }
  });

  const finalItems = Array.from(itemsSet);
  const finalProducts = Array.from(productsMap.values());
  const finalProductIds = finalItems.map((id) => (isNaN(id) ? id : Number(id)));

  return {
    items: finalItems,
    products: finalProducts,
    productIds: finalProductIds
  };
};

// 1. Get User Wishlist
export const getWishlist = async (req, res) => {
  try {
    const userId = req.body?.userId || req.user?.id || req.headers["x-user-id"];
    const userPhone = req.user?.phone || req.headers["x-user-phone"] || req.query?.phone || req.body?.phone;

    if (!userId && !userPhone) {
      return res.json({ success: true, wishlist: { items: [], products: [] }, productIds: [], products: [] });
    }

    const wishlist = await getOrCreateWishlist(userId, userPhone);
    const { items, products, productIds } = getNormalizedWishlistData(wishlist);

    return res.json({
      success: true,
      wishlist,
      productIds,
      products
    });
  } catch (error) {
    console.error("Error in getWishlist:", error);
    return res.status(500).json({ message: "Failed to fetch wishlist", error: error.message });
  }
};

// 2. Add / Toggle Wishlist Item
export const toggleWishlist = async (req, res) => {
  try {
    const { productId, product, phone, userId: bodyUserId } = req.body;
    const userId = bodyUserId || req.user?.id || req.headers["x-user-id"];
    const userPhone = req.user?.phone || req.headers["x-user-phone"] || phone;

    const itemProduct = product || {};
    const targetProdId = productId !== undefined && productId !== null ? productId : (itemProduct.id || itemProduct._id);

    if (targetProdId === undefined || targetProdId === null) {
      return res.status(400).json({ message: "Product ID is required" });
    }

    let wishlist = await getOrCreateWishlist(userId, userPhone);
    const strId = String(targetProdId);

    const { items, products } = getNormalizedWishlistData(wishlist);

    const itemIndex = items.findIndex((id) => id === strId);
    let action = "added";

    if (itemIndex > -1) {
      // Remove
      items.splice(itemIndex, 1);
      const updatedProducts = products.filter((p) => extractId(p) !== strId);
      wishlist.items = items;
      wishlist.products = updatedProducts;
      action = "removed";
    } else {
      // Add
      items.push(strId);
      const productObj = {
        id: itemProduct.id || itemProduct._id || targetProdId,
        productId: itemProduct.id || itemProduct._id || targetProdId,
        name: itemProduct.name || "Stationery Item",
        subtitle: itemProduct.subtitle || "",
        image: itemProduct.image || "",
        price: itemProduct.price || 0,
        originalPrice: itemProduct.originalPrice || 0,
        category: itemProduct.category || "",
        rating: itemProduct.rating || 4.5,
        reviewsCount: itemProduct.reviewsCount || 0,
        badge: itemProduct.badge || "",
        inStock: itemProduct.inStock !== undefined ? itemProduct.inStock : true
      };
      
      const updatedProducts = products.filter((p) => extractId(p) !== strId);
      updatedProducts.push(productObj);

      wishlist.items = items;
      wishlist.products = updatedProducts;
      action = "added";
    }

    wishlist.markModified('items');
    wishlist.markModified('products');
    await wishlist.save();

    const { productIds, products: finalProducts } = getNormalizedWishlistData(wishlist);

    return res.json({
      message: `Product ${action} ${action === 'added' ? 'to' : 'from'} wishlist`,
      action,
      productIds,
      products: finalProducts,
      wishlist
    });
  } catch (error) {
    console.error("Error in toggleWishlist:", error);
    return res.status(500).json({ message: "Failed to update wishlist", error: error.message });
  }
};

// 3. Remove item from Wishlist
export const removeFromWishlist = async (req, res) => {
  try {
    const { productId } = req.params;
    const userId = req.body?.userId || req.user?.id || req.headers["x-user-id"];
    const userPhone = req.user?.phone || req.headers["x-user-phone"];

    let wishlist = await getOrCreateWishlist(userId, userPhone);
    const strId = String(productId);

    const { items, products } = getNormalizedWishlistData(wishlist);

    const updatedItems = items.filter((id) => id !== strId);
    const updatedProducts = products.filter((p) => extractId(p) !== strId);

    wishlist.items = updatedItems;
    wishlist.products = updatedProducts;
    wishlist.markModified('items');
    wishlist.markModified('products');
    await wishlist.save();

    const { productIds, products: finalProducts } = getNormalizedWishlistData(wishlist);

    return res.json({
      message: "Product removed from wishlist",
      action: "removed",
      productIds,
      products: finalProducts,
      wishlist
    });
  } catch (error) {
    console.error("Error in removeFromWishlist:", error);
    return res.status(500).json({ message: "Failed to remove from wishlist", error: error.message });
  }
};
