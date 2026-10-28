import mongoose from "mongoose";
import Cart from "../models/Cart.js";
import Product from "../models/Product.js";

// Helper to extract cart item ID or product ID + variant key as string
const extractCartItemId = (item) => {
  if (item === null || item === undefined) return null;
  if (typeof item === 'object') {
    if (item.cartItemId) return String(item.cartItemId);
    const prodId = item.productId !== undefined ? item.productId : (item.id !== undefined ? item.id : item._id);
    const size = item.selectedSize || item.size || item.selectedVariant?.size || item.selectedVariant?.name || '';
    const color = item.selectedColor || item.color || item.selectedVariant?.color || '';
    const variantId = item.variantId || item.selectedVariant?.id || item.selectedVariant?._id || '';
    const keyPart = [size, color, variantId].filter(Boolean).join('_');
    return keyPart ? `${prodId}_${keyPart}` : String(prodId || '');
  }
  return String(item);
};

// Helper to resolve available stock for a product, taking size variants into account
export const resolveProductStock = (prod, itemSize = "") => {
  if (!prod) return Infinity;
  const targetSize = String(itemSize || "").trim().toLowerCase();

  // 1. If size is specified and product has sizeVariants
  if (targetSize && Array.isArray(prod.sizeVariants) && prod.sizeVariants.length > 0) {
    const variant = prod.sizeVariants.find((v) => {
      const s = String(v.size || v.measureValue || v.name || "").trim().toLowerCase();
      return s === targetSize;
    });
    if (variant) {
      const vStock = variant.stockQuantity !== undefined ? variant.stockQuantity : variant.stock;
      if (vStock !== undefined && vStock !== null && !isNaN(Number(vStock))) {
        return Math.max(0, Number(vStock));
      }
    }
  }

  // 2. Check top-level product stock
  const pStock = prod.stockQuantity !== undefined ? prod.stockQuantity : prod.stock;
  if (pStock !== undefined && pStock !== null && !isNaN(Number(pStock))) {
    return Math.max(0, Number(pStock));
  }

  return Infinity;
};

// Helper to locate existing cart for user without creating a dummy empty document
const findUserCart = async (userId, userPhone) => {
  const query = [];
  if (userId) {
    query.push({ userId });
    query.push({ userId: String(userId) });
    if (mongoose.Types.ObjectId.isValid(userId)) {
      query.push({ userId: new mongoose.Types.ObjectId(userId) });
    }
  }
  if (userPhone && String(userPhone).trim()) {
    const rawPhone = String(userPhone).trim();
    query.push({ userPhone: rawPhone });
    const digits = rawPhone.replace(/\D/g, "");
    if (digits.length >= 10) {
      query.push({ userPhone: { $regex: digits.slice(-10) + "$" } });
    }
  }

  if (query.length === 0) return null;
  return await Cart.findOne({ $or: query });
};

// Helper to get or create cart for user ONLY when adding items
const getOrCreateCart = async (userId, userPhone) => {
  let cart = await findUserCart(userId, userPhone);

  if (!cart) {
    cart = await Cart.create({
      userId: userId || null,
      userPhone: userPhone ? String(userPhone).trim() : "",
      items: [],
      totalAmount: 0
    });
  } else {
    let updated = false;
    if (userId && !cart.userId) {
      cart.userId = userId;
      updated = true;
    }
    if (userPhone && !cart.userPhone) {
      cart.userPhone = String(userPhone).trim();
      updated = true;
    }
    if (updated) {
      await cart.save();
    }
  }

  return cart;
};

// Helper to sanitize and normalize cart items array
const getNormalizedCartItems = (cart) => {
  if (!cart || !Array.isArray(cart.items)) return [];
  return cart.items
    .map((it) => {
      if (typeof it !== 'object' || it === null) {
        if (it === undefined || it === null) return null;
        return {
          id: String(it),
          productId: String(it),
          cartItemId: String(it),
          name: "Stationery Item",
          subtitle: "",
          image: "",
          price: 0,
          originalPrice: 0,
          quantity: 1
        };
      }
      const rawId = it.id || it.productId || it._id;
      if (rawId === undefined || rawId === null) return null;
      const computedCartItemId = it.cartItemId || extractCartItemId(it);
      return {
        ...it,
        id: rawId,
        productId: it.productId || rawId,
        cartItemId: computedCartItemId,
        name: it.name || "Stationery Item",
        subtitle: it.subtitle || "",
        image: it.image || (Array.isArray(it.images) && it.images[0]) || "",
        price: Number(it.price) || 0,
        originalPrice: Number(it.originalPrice || it.mrp) || 0,
        offerDiscount: Number(it.offerDiscount || it.discount || 0),
        discount: Number(it.offerDiscount || it.discount || 0),
        finalPrice: Number(it.finalPrice || it.price || 0),
        couponCode: it.couponCode || "",
        selectedSize: it.selectedSize || undefined,
        selectedColor: it.selectedColor || undefined,
        selectedVariant: it.selectedVariant || undefined,
        variantName: it.variantName || it.selectedVariant?.name || it.selectedSize || undefined,
        paymentMethodAllowed: it.paymentMethodAllowed || it.payment_method_allowed || "Both",
        paymentMethodsAllowed: Array.isArray(it.paymentMethodsAllowed) ? it.paymentMethodsAllowed : ["COD", "Online"],
        isMeterBased: Boolean(it.isMeterBased || it.unit === 'meter'),
        minMeter: it.minMeter !== undefined ? Number(it.minMeter) : undefined,
        meterStep: it.meterStep !== undefined ? Number(it.meterStep) : undefined,
        unit: it.unit || undefined,
        stock: it.stock !== undefined ? Number(it.stock) : (it.stockQuantity !== undefined ? Number(it.stockQuantity) : undefined),
        stockQuantity: it.stockQuantity !== undefined ? Number(it.stockQuantity) : (it.stock !== undefined ? Number(it.stock) : undefined),
        sizeVariants: Array.isArray(it.sizeVariants) ? it.sizeVariants : undefined,
        quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1
      };
    })
    .filter(Boolean);
};

// Helper to save cart document safely handling VersionError (Optimistic Concurrency Control)
const saveCartSafely = async (cart) => {
  try {
    cart.markModified('items');
    await cart.save();
    return cart;
  } catch (err) {
    if (cart && cart._id) {
      try {
        // Re-fetch latest document from MongoDB to get updated __v and save
        const latestCart = await Cart.findById(cart._id);
        if (latestCart) {
          latestCart.items = cart.items;
          latestCart.markModified('items');
          await latestCart.save();
          return latestCart;
        }
        // If latestCart is null, document was deleted concurrently (e.g. auto-cleared on checkout)
        return cart;
      } catch (innerErr) {
        return cart;
      }
    }
    return cart;
  }
};

// 1. Get User Cart
export const getCart = async (req, res) => {
  try {
    const userId = req.body?.userId || req.user?.id || req.headers["x-user-id"];
    const userPhone = req.user?.phone || req.headers["x-user-phone"] || req.query?.phone || req.body?.phone;

    if (!userId && !userPhone) {
      return res.json({ success: true, cart: { items: [], totalAmount: 0 } });
    }

    let cart = await findUserCart(userId, userPhone);

    // If no cart exists or it has 0 items, return empty response WITHOUT creating a document in MongoDB!
    if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
      if (cart && cart._id) {
        // Clean up any empty phantom cart document from MongoDB
        await Cart.deleteOne({ _id: cart._id }).catch(() => {});
      }
      return res.json({
        success: true,
        cart: {
          userId: userId || null,
          userPhone: userPhone ? String(userPhone).trim() : "",
          items: [],
          totalAmount: 0
        }
      });
    }

    const normalizedItems = getNormalizedCartItems(cart);

    // Sync cart items with live product data (paymentMethodAllowed, isGstInclusive, gst, price)
    for (const item of normalizedItems) {
      const pId = item.productId || item.id || item._id;
      if (pId) {
        let liveProd = null;
        if (/^[0-9a-fA-F]{24}$/.test(String(pId))) {
          liveProd = await Product.findById(pId).catch(() => null);
        }
        if (!liveProd && item.name) {
          liveProd = await Product.findOne({ name: item.name }).catch(() => null);
        }
        if (liveProd) {
          if (liveProd.paymentMethodAllowed) {
            item.paymentMethodAllowed = liveProd.paymentMethodAllowed;
            item.paymentMethodsAllowed = liveProd.paymentMethodAllowed === 'Online_Only'
              ? ['Online']
              : (liveProd.paymentMethodAllowed === 'COD_Only' ? ['COD'] : ['COD', 'Online']);
          }
          if (liveProd.isGstInclusive !== undefined) {
            item.isGstInclusive = liveProd.isGstInclusive;
          }
          if (liveProd.gst !== undefined) {
            item.gst = liveProd.gst;
          }
          if (liveProd.price !== undefined) {
            item.price = Number(liveProd.price);
          }
          const availStock = resolveProductStock(liveProd, item.selectedSize || item.variantName || item.size);
          item.stock = availStock;
          item.stockQuantity = availStock;
          if (Array.isArray(liveProd.sizeVariants)) {
            item.sizeVariants = liveProd.sizeVariants;
          }
          if (availStock !== Infinity && item.quantity > availStock) {
            item.quantity = Math.max(1, availStock);
          }
        }
      }
    }

    cart.items = normalizedItems;
    cart = await saveCartSafely(cart);

    return res.json({ success: true, cart });
  } catch (error) {
    console.error("Error in getCart:", error);
    return res.status(500).json({ message: "Failed to fetch cart", error: error.message });
  }
};

// 2. Add Item to Cart
export const addToCart = async (req, res) => {
  try {
    const { product, productId, quantity = 1, phone, userId: bodyUserId } = req.body;
    const userId = bodyUserId || req.user?.id || req.headers["x-user-id"];
    const userPhone = req.user?.phone || req.headers["x-user-phone"] || phone;

    const itemProduct = product || {};
    const itemNumId = productId !== undefined && productId !== null ? productId : (itemProduct.id || itemProduct._id);

    if (itemNumId === undefined || itemNumId === null) {
      return res.status(400).json({ message: "Product details or ID required" });
    }

    let liveProd = null;
    if (/^[0-9a-fA-F]{24}$/.test(String(itemNumId))) {
      liveProd = await Product.findById(itemNumId).catch(() => null);
    }
    if (!liveProd && itemProduct.name) {
      liveProd = await Product.findOne({ name: itemProduct.name }).catch(() => null);
    }
    const availStock = resolveProductStock(liveProd, itemProduct.selectedSize || itemProduct.variantName);
    if (availStock !== Infinity && availStock <= 0) {
      return res.status(400).json({
        message: `"${itemProduct.name || 'This item'}" is currently out of stock.`
      });
    }

    let cart = await getOrCreateCart(userId, userPhone);
    const cartItemId = itemProduct.cartItemId || extractCartItemId({ ...itemProduct, id: itemNumId });

    const items = getNormalizedCartItems(cart);
    const existingIndex = items.findIndex(
      (it) => extractCartItemId(it) === cartItemId
    );

    const isMeter = Boolean(
      itemProduct.isMeterBased ||
      itemProduct.unit === 'meter' ||
      String(itemProduct.category || '').toLowerCase().includes('unstitched') ||
      String(itemProduct.name || '').toLowerCase().includes('unstitched')
    );
    const minMeter = isMeter ? (Number(itemProduct.minMeter) > 0 ? Number(itemProduct.minMeter) : 0.5) : 1;
    const qtyToAdd = isMeter
      ? Math.max(minMeter, Number(quantity) > 0 ? Number(quantity) : minMeter)
      : (Number(quantity) > 0 ? Number(quantity) : 1);

    if (existingIndex > -1) {
      const existingQty = Number(items[existingIndex].quantity) || 0;
      if (availStock !== Infinity && (existingQty + qtyToAdd) > availStock) {
        if (existingQty >= availStock) {
          return res.status(400).json({
            message: `Only ${availStock} units in stock. You already have the maximum available quantity in your cart.`
          });
        }
        items[existingIndex].quantity = availStock;
      } else {
        items[existingIndex].quantity += qtyToAdd;
      }
      if (itemProduct.name) items[existingIndex].name = itemProduct.name;
      if (itemProduct.image) items[existingIndex].image = itemProduct.image || (Array.isArray(itemProduct.images) && itemProduct.images[0]) || "";
      if (itemProduct.price) items[existingIndex].price = Number(itemProduct.price) || 0;
      if (itemProduct.selectedSize) items[existingIndex].selectedSize = itemProduct.selectedSize;
      if (itemProduct.selectedColor) items[existingIndex].selectedColor = itemProduct.selectedColor;
      if (itemProduct.selectedVariant) items[existingIndex].selectedVariant = itemProduct.selectedVariant;
      if (itemProduct.variantName) items[existingIndex].variantName = itemProduct.variantName;
      if (isMeter) {
        items[existingIndex].isMeterBased = true;
        items[existingIndex].minMeter = minMeter;
        items[existingIndex].meterStep = Number(itemProduct.meterStep) || 0.5;
        items[existingIndex].unit = 'meter';
      }
    } else {
      items.push({
        ...itemProduct,
        id: itemProduct.id || itemProduct._id || itemNumId,
        productId: itemProduct.productId || itemProduct.id || itemProduct._id || itemNumId,
        cartItemId: cartItemId,
        name: itemProduct.name || "Stationery Item",
        subtitle: itemProduct.subtitle || itemProduct.category || "",
        image: itemProduct.image || (Array.isArray(itemProduct.images) && itemProduct.images[0]) || "",
        price: Number(itemProduct.price) || 0,
        originalPrice: Number(itemProduct.originalPrice || itemProduct.mrp) || 0,
        selectedSize: itemProduct.selectedSize || undefined,
        selectedColor: itemProduct.selectedColor || undefined,
        selectedVariant: itemProduct.selectedVariant || undefined,
        variantName: itemProduct.variantName || itemProduct.selectedVariant?.name || itemProduct.selectedSize || undefined,
        isMeterBased: isMeter,
        minMeter: isMeter ? minMeter : undefined,
        meterStep: isMeter ? (Number(itemProduct.meterStep) || 0.5) : undefined,
        unit: isMeter ? 'meter' : (itemProduct.unit || 'piece'),
        quantity: qtyToAdd
      });
    }

    cart.items = items;
    cart = await saveCartSafely(cart);

    return res.status(200).json({ message: "Item added to cart", cart });
  } catch (error) {
    console.error("Error in addToCart:", error);
    return res.status(500).json({ message: "Failed to add to cart", error: error.message });
  }
};

// 3. Update Cart Item Quantity
export const updateCartItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    const { quantity, delta, phone, userId: bodyUserId } = req.body;
    const userId = bodyUserId || req.user?.id || req.headers["x-user-id"];
    const userPhone = req.user?.phone || req.headers["x-user-phone"] || phone;

    let cart = await getOrCreateCart(userId, userPhone);
    const strId = String(itemId);

    const items = getNormalizedCartItems(cart);
    const itemIndex = items.findIndex(
      (it) => extractCartItemId(it) === strId
    );

    if (itemIndex === -1) {
      return res.status(404).json({ message: "Item not found in cart" });
    }

    const targetItem = items[itemIndex];
    let liveProd = null;
    const pId = targetItem.productId || targetItem.id;
    if (/^[0-9a-fA-F]{24}$/.test(String(pId))) {
      liveProd = await Product.findById(pId).catch(() => null);
    }
    if (!liveProd && targetItem.name) {
      liveProd = await Product.findOne({ name: targetItem.name }).catch(() => null);
    }
    const availStock = resolveProductStock(liveProd, targetItem.selectedSize || targetItem.variantName);

    if (delta !== undefined) {
      const newQty = items[itemIndex].quantity + Number(delta);
      if (delta > 0 && availStock !== Infinity && newQty > availStock) {
        return res.status(400).json({
          message: `Only ${availStock} units available in stock. Cannot add more.`
        });
      }
      if (newQty > 0) {
        items[itemIndex].quantity = newQty;
      } else {
        items.splice(itemIndex, 1);
      }
    } else if (quantity !== undefined) {
      const newQty = Number(quantity);
      if (availStock !== Infinity && newQty > availStock) {
        return res.status(400).json({
          message: `Only ${availStock} units available in stock. Cannot add more.`
        });
      }
      if (newQty > 0) {
        items[itemIndex].quantity = newQty;
      } else {
        items.splice(itemIndex, 1);
      }
    }

    cart.items = items;
    cart = await saveCartSafely(cart);

    return res.json({ message: "Cart updated", cart });
  } catch (error) {
    console.error("Error in updateCartItem:", error);
    return res.status(500).json({ message: "Failed to update cart", error: error.message });
  }
};

// 4. Remove Item from Cart
export const removeFromCart = async (req, res) => {
  try {
    const { itemId } = req.params;
    const userId = req.body?.userId || req.user?.id || req.headers["x-user-id"];
    const userPhone = req.user?.phone || req.headers["x-user-phone"] || req.body?.phone;

    let cart = await findUserCart(userId, userPhone);
    if (!cart) {
      return res.json({ message: "Cart is empty", cart: { userId, userPhone, items: [], totalAmount: 0 } });
    }
    const strId = String(itemId);

    const items = getNormalizedCartItems(cart).filter(
      (it) => extractCartItemId(it) !== strId
    );

    if (items.length === 0) {
      // If all items removed, completely remove the cart document from MongoDB
      await Cart.deleteOne({ _id: cart._id }).catch(() => {});
      return res.json({ message: "Item removed from cart", cart: { userId, userPhone, items: [], totalAmount: 0 } });
    }

    cart.items = items;
    cart = await saveCartSafely(cart);

    return res.json({ message: "Item removed from cart", cart });
  } catch (error) {
    console.error("Error in removeFromCart:", error);
    return res.status(500).json({ message: "Failed to remove item", error: error.message });
  }
};

// 5. Clear Entire Cart
export const clearCart = async (req, res) => {
  try {
    const userId = req.user?.id || req.headers["x-user-id"] || req.query?.userId || req.body?.userId;
    const userPhone = req.user?.phone || req.headers["x-user-phone"] || req.query?.phone || req.query?.userPhone || req.body?.phone || req.body?.userPhone;

    const orClauses = [];
    if (userId) {
      orClauses.push({ userId: String(userId) });
      if (mongoose.Types.ObjectId.isValid(userId)) {
        orClauses.push({ userId: new mongoose.Types.ObjectId(userId) });
      }
    }
    if (userPhone) {
      const digits = String(userPhone).replace(/\D/g, "");
      if (digits.length >= 10) {
        orClauses.push({ userPhone: { $regex: digits.slice(-10) + "$" } });
      } else {
        orClauses.push({ userPhone: String(userPhone).trim() });
      }
    }

    if (orClauses.length > 0) {
      // Permanently remove the cart documents from MongoDB so 0 phantom data remains
      await Cart.deleteMany({ $or: orClauses }).catch(() => {});
    }

    return res.json({
      message: "Cart cleared",
      cart: {
        userId: userId || null,
        userPhone: userPhone ? String(userPhone).trim() : "",
        items: [],
        totalAmount: 0
      }
    });
  } catch (error) {
    console.error("Error in clearCart:", error);
    return res.status(500).json({ message: "Failed to clear cart", error: error.message });
  }
};
