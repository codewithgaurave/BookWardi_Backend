/**
 * Shiprocket Live Test Script
 * Run: node test_shiprocket_live.js
 */

import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config({ path: './.env' });

const BASE = 'https://apiv2.shiprocket.in/v1/external';
const EMAIL = process.env.SHIPROCKET_API_EMAIL;
const PASSWORD = process.env.SHIPROCKET_API_PASSWORD;
const CHANNEL_ID = process.env.SHIPROCKET_CHANNEL_ID;
const PICKUP_PINCODE = process.env.SHIPROCKET_PICKUP_PINCODE || '247121';
const PICKUP_LOCATION = process.env.SHIPROCKET_PICKUP_LOCATION || 'warehouse';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const pass = (msg) => console.log(`${GREEN}✅ PASS${RESET} - ${msg}`);
const fail = (msg) => console.log(`${RED}❌ FAIL${RESET} - ${msg}`);
const info = (msg) => console.log(`${CYAN}ℹ️  INFO${RESET} - ${msg}`);
const warn = (msg) => console.log(`${YELLOW}⚠️  WARN${RESET} - ${msg}`);

let token = null;

// ─── Test 1: Check .env variables ───────────────────────────────────────────
function testEnvVars() {
  console.log('\n─── TEST 1: Environment Variables ───');
  let allOk = true;

  if (EMAIL) pass(`SHIPROCKET_API_EMAIL = ${EMAIL}`);
  else { fail('SHIPROCKET_API_EMAIL missing in .env'); allOk = false; }

  if (PASSWORD) pass(`SHIPROCKET_API_PASSWORD = ${'*'.repeat(PASSWORD.length)}`);
  else { fail('SHIPROCKET_API_PASSWORD missing in .env'); allOk = false; }

  if (CHANNEL_ID) pass(`SHIPROCKET_CHANNEL_ID = ${CHANNEL_ID}`);
  else { fail('SHIPROCKET_CHANNEL_ID missing in .env'); allOk = false; }

  if (PICKUP_PINCODE) pass(`SHIPROCKET_PICKUP_PINCODE = ${PICKUP_PINCODE}`);
  else warn('SHIPROCKET_PICKUP_PINCODE missing, using default 247121');

  if (PICKUP_LOCATION) pass(`SHIPROCKET_PICKUP_LOCATION = ${PICKUP_LOCATION}`);
  else warn('SHIPROCKET_PICKUP_LOCATION missing, using default "warehouse"');

  return allOk;
}

// ─── Test 2: Login & Get Token ───────────────────────────────────────────────
async function testLogin() {
  console.log('\n─── TEST 2: Shiprocket Login (Get Auth Token) ───');
  try {
    const res = await axios.post(`${BASE}/auth/login`, { email: EMAIL, password: PASSWORD }, { timeout: 15000 });

    if (res.data?.token) {
      token = res.data.token;
      pass(`Login successful! Token received (${token.length} chars)`);
      info(`Token preview: ${token.slice(0, 30)}...`);
      return true;
    } else {
      fail(`Login response missing token: ${JSON.stringify(res.data)}`);
      return false;
    }
  } catch (err) {
    const msg = err?.response?.data?.message || err.message;
    const status = err?.response?.status;
    fail(`Login failed (HTTP ${status || 'N/A'}): ${msg}`);
    if (status === 403) warn('Account may be blocked due to too many failed attempts. Reset password on Shiprocket dashboard.');
    if (status === 401) warn('Wrong email or password. Check .env credentials.');
    return false;
  }
}

// ─── Test 3: Serviceability Check ───────────────────────────────────────────
async function testServiceability() {
  console.log('\n─── TEST 3: Serviceability Check (Pickup → Delivery) ───');
  const deliveryPincode = '110001'; // Delhi test pincode
  try {
    const res = await axios.get(`${BASE}/courier/serviceability`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        pickup_postcode: PICKUP_PINCODE,
        delivery_postcode: deliveryPincode,
        weight: 1,
        cod: 0
      },
      timeout: 15000
    });

    const couriers = res.data?.data?.available_courier_companies || [];
    if (couriers.length > 0) {
      pass(`${couriers.length} courier(s) available for ${PICKUP_PINCODE} → ${deliveryPincode}`);
      couriers.slice(0, 3).forEach(c => {
        info(`  • ${c.courier_name} | Rate: ₹${c.rate || c.freight_charge || 'N/A'} | ETA: ${c.estimated_delivery_days || 'N/A'} days`);
      });
      return true;
    } else {
      warn(`No couriers available for ${PICKUP_PINCODE} → ${deliveryPincode}`);
      info('This may be normal for test pincodes. Try a different delivery pincode.');
      return false;
    }
  } catch (err) {
    const msg = err?.response?.data?.message || err.message;
    fail(`Serviceability check failed: ${msg}`);
    return false;
  }
}

// ─── Test 4: Create Test Order ───────────────────────────────────────────────
async function testCreateOrder() {
  console.log('\n─── TEST 4: Create Test Shiprocket Order ───');
  const testOrderId = `TEST-${Date.now()}`;
  try {
    const payload = {
      order_id: testOrderId,
      order_date: new Date().toISOString().slice(0, 19),
      pickup_location: PICKUP_LOCATION,
      channel_id: Number(CHANNEL_ID),
      comment: 'BookVardi Test Order',
      billing_customer_name: 'Test Customer',
      billing_last_name: '',
      billing_address: '123 Test Street',
      billing_address_2: '',
      billing_city: 'Delhi',
      billing_pincode: '110001',
      billing_state: 'Delhi',
      billing_country: 'India',
      billing_email: 'test@bookvardi.com',
      billing_phone: '9027237697',
      billing_alternate_phone: '',
      shipping_is_billing: true,
      order_items: [{
        name: 'Test School Uniform',
        sku: 'TEST-SKU-001',
        units: 1,
        selling_price: 499,
        discount: 0,
        tax: 5,
        hsn: ''
      }],
      payment_method: 'Prepaid',
      shipping_charges: 0,
      giftwrap_charges: 0,
      transaction_charges: 0,
      total_discount: 0,
      sub_total: 499,
      length: 20,
      breadth: 15,
      height: 10,
      weight: 0.5
    };

    const res = await axios.post(`${BASE}/orders/create/adhoc`, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    if (res.data?.order_id || res.data?.shipment_id) {
      pass(`Test order created! SR Order ID: ${res.data.order_id}, Shipment ID: ${res.data.shipment_id}`);
      info(`Status: ${res.data.status} (Code: ${res.data.status_code})`);
      return { shiprocketOrderId: res.data.order_id, shipmentId: res.data.shipment_id };
    } else {
      fail(`Order creation response unexpected: ${JSON.stringify(res.data)}`);
      return null;
    }
  } catch (err) {
    const msg = err?.response?.data?.message || err.message;
    const errData = err?.response?.data;
    fail(`Order creation failed: ${msg}`);
    if (errData) info(`Full error: ${JSON.stringify(errData)}`);
    if (msg?.includes('pickup')) warn('Pickup location may not exist. Check SHIPROCKET_PICKUP_LOCATION in .env matches your Shiprocket dashboard.');
    if (msg?.includes('channel')) warn('Channel ID may be wrong. Check SHIPROCKET_CHANNEL_ID in .env.');
    return null;
  }
}

// ─── Test 5: Assign AWB ──────────────────────────────────────────────────────
async function testAssignAwb(shipmentId) {
  console.log('\n─── TEST 5: Assign AWB to Shipment ───');
  try {
    const res = await axios.post(`${BASE}/courier/assign/awb`, {
      shipment_id: [Number(shipmentId)]
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const awbData = res.data?.response?.data;
    if (awbData?.awb_code) {
      pass(`AWB assigned: ${awbData.awb_code} via ${awbData.courier_name}`);
      info(`Tracking URL: https://track.shiprocket.in/tracking/${awbData.awb_code}`);
      return awbData.awb_code;
    } else {
      const errMsg = res.data?.response?.data?.awb_assign_error || JSON.stringify(res.data);
      fail(`AWB assignment failed: ${errMsg}`);
      return null;
    }
  } catch (err) {
    const msg = err?.response?.data?.message || err.message;
    fail(`AWB assignment error: ${msg}`);
    return null;
  }
}

// ─── Test 6: Track AWB ───────────────────────────────────────────────────────
async function testTracking(awbCode) {
  console.log('\n─── TEST 6: Track Shipment by AWB ───');
  try {
    const res = await axios.get(`${BASE}/courier/track/awb/${awbCode}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });

    const trackData = res.data?.tracking_data;
    if (trackData) {
      const shipmentTrack = trackData.shipment_track?.[0] || {};
      pass(`Tracking data received for AWB: ${awbCode}`);
      info(`Current Status: ${shipmentTrack['current-status'] || 'N/A'}`);
      info(`Courier: ${shipmentTrack.courier_name || 'N/A'}`);
      return true;
    } else {
      warn('No tracking data yet (normal for newly created shipments)');
      return true;
    }
  } catch (err) {
    const msg = err?.response?.data?.message || err.message;
    fail(`Tracking failed: ${msg}`);
    return false;
  }
}

// ─── Main Runner ─────────────────────────────────────────────────────────────
async function runAllTests() {
  console.log(`\n${'='.repeat(55)}`);
  console.log('  SHIPROCKET LIVE TEST - BookVardi Backend');
  console.log(`${'='.repeat(55)}`);

  const results = { pass: 0, fail: 0, warn: 0 };

  // Test 1: Env vars
  const envOk = testEnvVars();
  if (!envOk) {
    fail('Fix .env variables first before running other tests.');
    process.exit(1);
  }
  results.pass++;

  // Test 2: Login
  const loginOk = await testLogin();
  if (!loginOk) {
    fail('Login failed. Cannot run further tests without a valid token.');
    console.log('\n📋 SUMMARY: Login failed. Fix credentials and retry.\n');
    process.exit(1);
  }
  results.pass++;

  // Test 3: Serviceability
  const serviceOk = await testServiceability();
  if (serviceOk) results.pass++; else results.warn++;

  // Test 4: Create Order
  const orderResult = await testCreateOrder();
  if (orderResult) {
    results.pass++;

    // Test 5: Assign AWB
    const awbCode = await testAssignAwb(orderResult.shipmentId);
    if (awbCode) {
      results.pass++;

      // Test 6: Track
      const trackOk = await testTracking(awbCode);
      if (trackOk) results.pass++; else results.fail++;
    } else {
      results.fail++;
      warn('Skipping tracking test (no AWB)');
    }
  } else {
    results.fail++;
    warn('Skipping AWB & tracking tests (order creation failed)');
  }

  // Final Summary
  console.log(`\n${'='.repeat(55)}`);
  console.log('  FINAL RESULTS');
  console.log(`${'='.repeat(55)}`);
  console.log(`${GREEN}✅ Passed : ${results.pass}${RESET}`);
  console.log(`${RED}❌ Failed : ${results.fail}${RESET}`);
  console.log(`${YELLOW}⚠️  Warnings: ${results.warn}${RESET}`);

  if (results.fail === 0) {
    console.log(`\n${GREEN}🎉 Shiprocket is fully working! Create Shipment button will work.${RESET}\n`);
  } else {
    console.log(`\n${RED}🔧 Fix the failed tests above before using Create Shipment.${RESET}\n`);
  }
}

runAllTests().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
