import mongoose from 'mongoose';

const subCategorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, default: '' },
  description: { type: String, default: '' },
  itemCount: { type: String, default: '' }
}, { _id: true });

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  slug: { type: String, default: '' },
  description: { type: String, default: '' },
  accentColor: { type: String, default: 'var(--color-brand-teal)' },
  bgColor: { type: String, default: 'var(--color-brand-teal-subtle)' },
  icon: { type: String, default: 'Package' },
  imageUrl: { type: String, default: '' },
  gstPercentage: { type: Number, default: 5, min: 0, max: 28 },
  subCategories: [subCategorySchema],
  productCount: { type: Number, default: 0 },
  sortOrder: { type: Number, default: 0 }
}, {
  timestamps: true
});

export default mongoose.model('Category', categorySchema);