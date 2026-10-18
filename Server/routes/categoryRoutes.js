import express from 'express';
import Category from '../models/Category.js';
import authenticateToken from '../middlewares/auth.js';
import { cacheMiddleware, clearCache } from '../utils/cache.js';

const router = express.Router();

async function getCategoriesFromDB() {
  return await Category.find().sort({ sortOrder: 1, createdAt: 1 });
}

// Get all categories (Public for header and store browsing)
router.get('/', async (req, res) => {
  try {
    const categories = await getCategoriesFromDB();
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get category tree with subcategories (Public)
router.get('/tree', async (req, res) => {
  try {
    const categories = await getCategoriesFromDB();
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create category
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description, gstPercentage, icon, accentColor, bgColor, subCategories, imageUrl, sortOrder } = req.body;
    const category = new Category({
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      description,
      gstPercentage: gstPercentage !== undefined ? Number(gstPercentage) : 5,
      icon,
      accentColor,
      bgColor,
      subCategories: Array.isArray(subCategories)
        ? subCategories.map(s => typeof s === 'string' ? { name: s, slug: s.toLowerCase().replace(/[^a-z0-9]+/g, '-') } : s)
        : [],
      imageUrl,
      sortOrder: sortOrder || 0
    });
    await category.save();
    clearCache('categor');
    clearCache('product');
    res.status(201).json({ message: 'Category created successfully', category });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update category
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    if (updates.subCategories && Array.isArray(updates.subCategories)) {
      updates.subCategories = updates.subCategories.map(s => typeof s === 'string' ? { name: s, slug: s.toLowerCase().replace(/[^a-z0-9]+/g, '-') } : s);
    }
    const category = await Category.findByIdAndUpdate(id, updates, { new: true });
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }
    clearCache('categor');
    res.json({ message: 'Category updated successfully', category });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete category
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const category = await Category.findByIdAndDelete(id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }
    clearCache('categor');
    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

export default router;