import express from 'express';
import { 
  getStores, createStore, updateStore, deleteStore,
  getCoupons, createCoupon, updateCoupon, deleteCoupon,
  getGiftCards, createGiftCard, updateGiftCard, deleteGiftCard
} from '../controllers/storeController.js';
import { authenticateToken } from '../middlewares/auth.js';

const router = express.Router();

// Store routes
router.get('/stores', authenticateToken, getStores);
router.post('/stores', authenticateToken, createStore);
router.put('/stores/:id', authenticateToken, updateStore);
router.delete('/stores/:id', authenticateToken, deleteStore);

// Coupon routes
router.get('/coupons', authenticateToken, getCoupons);
router.post('/coupons', authenticateToken, createCoupon);
router.put('/coupons/:id', authenticateToken, updateCoupon);
router.delete('/coupons/:id', authenticateToken, deleteCoupon);

// Gift card routes
router.get('/giftcards', authenticateToken, getGiftCards);
router.post('/giftcards', authenticateToken, createGiftCard);
router.put('/giftcards/:id', authenticateToken, updateGiftCard);
router.delete('/giftcards/:id', authenticateToken, deleteGiftCard);

export default router;