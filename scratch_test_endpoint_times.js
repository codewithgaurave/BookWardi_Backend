import 'dotenv/config';

async function testEndpoints() {
  const sellerApis = [
    { name: 'sellerStatus', url: 'http://localhost:5000/api/seller/status' },
    { name: 'sellerProducts', url: 'http://localhost:5000/api/seller/products' },
    { name: 'sellerKits', url: 'http://localhost:5000/api/seller/kits' },
    { name: 'sellerOrders', url: 'http://localhost:5000/api/seller/orders' },
    { name: 'schoolOrders', url: 'http://localhost:5000/api/seller/school-orders' },
    { name: 'promotions', url: 'http://localhost:5000/api/seller/promotions' },
    { name: 'wallet', url: 'http://localhost:5000/api/seller/wallet' },
    { name: 'reviews', url: 'http://localhost:5000/api/seller/reviews' },
    { name: 'profile', url: 'http://localhost:5000/api/seller/profile' },
    { name: 'settings', url: 'http://localhost:5000/api/seller/settings' },
    { name: 'customers', url: 'http://localhost:5000/api/seller/customers' },
    { name: 'adminProducts', url: 'http://localhost:5000/api/admin/products' }
  ];

  console.log('Testing response times for endpoints (without auth):');
  for (const api of sellerApis) {
    const t0 = Date.now();
    try {
      const res = await fetch(api.url);
      const time = Date.now() - t0;
      console.log(`[${time}ms] ${api.name} -> HTTP ${res.status}`);
    } catch (e) {
      console.log(`[${Date.now() - t0}ms] ${api.name} -> ERROR: ${e.message}`);
    }
  }
}

testEndpoints();
