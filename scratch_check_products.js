import 'dotenv/config';
import mongoose from 'mongoose';

async function main() {
  const startConnect = Date.now();
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to Mongo in ${Date.now() - startConnect}ms`);

  const Product = mongoose.model('Product', new mongoose.Schema({}, { strict: false }));
  
  const startCount = Date.now();
  const count = await Product.countDocuments();
  console.log(`Product count: ${count} (took ${Date.now() - startCount}ms)`);

  const startFind = Date.now();
  const prods = await Product.find().lean();
  console.log(`Product.find().lean() took ${Date.now() - startFind}ms for ${prods.length} products`);

  let totalBytes = 0;
  let base64Count = 0;
  for (const p of prods) {
    const str = JSON.stringify(p);
    totalBytes += str.length;
    if (str.includes('data:image')) {
      base64Count++;
    }
  }

  console.log(`Total payload size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Products with base64 images: ${base64Count} of ${prods.length}`);

  if (prods.length > 0) {
    const largest = prods.map(p => ({
      id: p._id,
      name: p.name,
      sizeKB: Math.round(JSON.stringify(p).length / 1024),
      hasBase64Img: String(p.image || '').startsWith('data:image'),
      imgLength: String(p.image || '').length,
      imagesCount: Array.isArray(p.images) ? p.images.length : 0
    })).sort((a, b) => b.sizeKB - a.sizeKB).slice(0, 5);

    console.log('Top 5 largest products:', largest);
  }

  // Check indexes
  const indexes = await Product.collection.indexes();
  console.log('Product indexes:', indexes.map(i => i.key));

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
