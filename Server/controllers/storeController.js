import Store from '../models/Store.js';
import Coupon from '../models/Coupon.js';
import GiftCard from '../models/GiftCard.js';

// Store operations
export const getStores = async (req, res) => {
  try {
    const stores = await Store.find().sort({ createdAt: -1 });
    res.json(stores);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createStore = async (req, res) => {
  try {
    const store = new Store(req.body);
    await store.save();
    res.status(201).json(store);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const updateStore = async (req, res) => {
  try {
    const store = await Store.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(store);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const deleteStore = async (req, res) => {
  try {
    await Store.findByIdAndDelete(req.params.id);
    res.json({ message: 'Store deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Coupon operations
export const getCoupons = async (req, res) => {
  try {
    const coupons = await Coupon.find().populate('storeId').sort({ createdAt: -1 });
    res.json(coupons);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createCoupon = async (req, res) => {
  try {
    const coupon = new Coupon(req.body);
    await coupon.save();
    res.status(201).json(coupon);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const updateCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(coupon);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const deleteCoupon = async (req, res) => {
  try {
    await Coupon.findByIdAndDelete(req.params.id);
    res.json({ message: 'Coupon deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Gift Card operations
export const getGiftCards = async (req, res) => {
  try {
    const giftCards = await GiftCard.find().sort({ createdAt: -1 });
    res.json(giftCards);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createGiftCard = async (req, res) => {
  try {
    const giftCard = new GiftCard(req.body);
    await giftCard.save();
    res.status(201).json(giftCard);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const updateGiftCard = async (req, res) => {
  try {
    const giftCard = await GiftCard.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(giftCard);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const deleteGiftCard = async (req, res) => {
  try {
    await GiftCard.findByIdAndDelete(req.params.id);
    res.json({ message: 'Gift card deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};