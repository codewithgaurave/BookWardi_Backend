import Order from "../models/Order.js";
import Seller from "../models/Seller.js";

/**
 * BookVardi Seller Settlement Rules Engine
 * 
 * Rule 1: Online Payment + Self Delivery (ऑनलाइन भुगतान + सेलर की डिलीवरी)
 * - Gross Sale: ग्राहक से प्राप्त कुल बिक्री राशि (item net customer purchase price)
 * - Portal Commission: 10% — पोर्टल का कमीशन
 * - GST on Commission: 18% — कमीशन पर GST
 * - TDS: 0.1% — लागू TDS की कटौती (Sec 194-O)
 * - GST TCS: 0.5% — जहाँ GST कानून के अनुसार लागू हो (Sec 52)
 * - Final Seller Settlement: सभी लागू कटौतियों के बाद बची राशि सेलर को दी जाएगी
 * 
 * Rule 2: Online Payment + Third-Party Delivery (ऑनलाइन भुगतान + कूरियर से डिलीवरी)
 * - Gross Sale: ग्राहक से प्राप्त कुल बिक्री राशि
 * - Portal Commission: 10% — पोर्टल का कमीशन
 * - GST on Commission: 18% — कमीशन पर GST
 * - TDS: 0.1% — लागू TDS की कटौती
 * - GST TCS: 0.5% — जहाँ GST कानून के अनुसार लागू हो
 * - Delivery Charges + 18% GST: डिलीवरी का खर्च और उस पर GST तभी काटें, जब यह खर्च सेलर के जिम्मे हो
 * - ₹301 या अधिक के ऑर्डर पर: यदि डिलीवरी का खर्च एडमिन उठाता है, तो सेलर से डिलीवरी चार्ज और उसका GST नहीं काटना है
 * 
 * Rule 3: COD + Self Delivery (कैश भुगतान + सेलर की डिलीवरी)
 * - ग्राहक पूरा पैसा सीधे सेलर को देगा।
 * - पोर्टल सेलर को बिक्री की राशि ट्रांसफर नहीं करेगा।
 * - Portal Commission: 10% — सेलर से पोर्टल का कमीशन लिया जाएगा।
 * - GST on Commission: 18% — कमीशन पर GST लिया जाएगा।
 * - TDS: 0.1% — लागू TDS की राशि सेलर से वसूल की जाएगी (Sec 194-O)।
 * - GST TCS: 0% — जब पोर्टल ग्राहक का भुगतान एकत्र नहीं करता, तो GST TCS नहीं काटना है (Sec 52 E-Commerce TCS is 0%)।
 * - Final Settlement: कमीशन, कमीशन पर GST और लागू TDS की कुल राशि सेलर को पोर्टल में जमा करनी होगी या उसके अगले भुगतान से समायोजित की जाएगी। इस स्थिति में सेलर का सेटलमेंट माइनस (-) में दिखेगा।
 * 
 * Rule 4: COD + Third-Party Delivery (कैश भुगतान + कूरियर से डिलीवरी)
 * यदि कूरियर ग्राहक से कैश लेकर पोर्टल को भुगतान करता है:
 * - Gross Sale: ग्राहक से प्राप्त कुल बिक्री राशि।
 * - Portal Commission: 10% — पोर्टल का कमीशन।
 * - GST on Commission: 18% — कमीशन पर GST।
 * - TDS: 0.1% — लागू TDS की कटौती।
 * - GST TCS: 0.5% — जहाँ GST कानून के अनुसार लागू हो।
 * - Delivery Charges + 18% GST: डिलीवरी का खर्च और उस पर GST तभी काटें, जब यह खर्च सेलर के जिम्मे हो।
 * - Final Seller Settlement: सभी लागू कटौतियों के बाद बची राशि सेलर को दी जाएगी।
 * - ₹301 या अधिक के ऑर्डर पर: यदि डिलीवरी का खर्च एडमिन उठाता है, तो सेलर से डिलीवरी चार्ज और उसका GST नहीं काटना है।
 */

export const SETTLEMENT_RULES = {
  ONLINE_SELF_DELIVERY: {
    code: "ONLINE_SELF_DELIVERY",
    ruleNumber: 1,
    name: "Online Payment + Self Delivery",
    nameHi: "ऑनलाइन भुगतान + सेलर की डिलीवरी",
    defaultCommissionRate: 10, // 10%
    gstOnCommissionRate: 18,    // 18%
    tdsRate: 0.1,              // 0.1%
    gstTcsRate: 0.5            // 0.5%
  },
  ONLINE_THIRD_PARTY_DELIVERY: {
    code: "ONLINE_THIRD_PARTY_DELIVERY",
    ruleNumber: 2,
    name: "Online Payment + Third-Party Delivery",
    nameHi: "ऑनलाइन भुगतान + कूरियर से डिलीवरी",
    defaultCommissionRate: 10, // 10%
    gstOnCommissionRate: 18,    // 18%
    tdsRate: 0.1,              // 0.1%
    gstTcsRate: 0.5,           // 0.5%
    freeDeliveryThreshold: 301  // Orders >= ₹301 have delivery charges absorbed by Admin
  },
  COD_SELF_DELIVERY: {
    code: "COD_SELF_DELIVERY",
    ruleNumber: 3,
    name: "COD + Self Delivery",
    nameHi: "कैश भुगतान + सेलर की डिलीवरी",
    defaultCommissionRate: 10, // 10%
    gstOnCommissionRate: 18,    // 18%
    tdsRate: 0.1,              // 0.1%
    gstTcsRate: 0.0,           // 0% (जब पोर्टल ग्राहक का भुगतान एकत्र नहीं करता)
    isSellerCollectedCash: true
  },
  COD_THIRD_PARTY_DELIVERY: {
    code: "COD_THIRD_PARTY_DELIVERY",
    ruleNumber: 4,
    name: "COD + Third-Party Delivery",
    nameHi: "कैश भुगतान + कूरियर से डिलीवरी",
    defaultCommissionRate: 10, // 10%
    gstOnCommissionRate: 18,    // 18%
    tdsRate: 0.1,              // 0.1%
    gstTcsRate: 0.5,           // 0.5% (लागू कानून के अनुसार जब कूरियर पोर्टल को भुगतान करता है)
    freeDeliveryThreshold: 301, // Orders >= ₹301 have delivery charges absorbed by Admin
    isSellerCollectedCash: false // Courier remits collected cash to Portal
  }
};

/**
 * Calculate dynamic seller settlement for an order or item
 * @param {number} grossSale - Customer sale price (net of customer coupon/offer discounts)
 * @param {object} options - Options containing commissionRate, paymentMethod, deliveryMode, deliveryChargeBorneBy, etc.
 * @returns {object} Full financial breakdown with final seller settlement
 */
export function calculateSellerSettlement(grossSale, options = {}) {
  const gross = Math.max(0, Math.round(Number(grossSale || 0) * 100) / 100);

  // Determine if order/item is cancelled or refunded
  const isCancelled = Boolean(
    options.isCancelled ||
    options.isRefunded ||
    options.settlementStatus === "refunded" ||
    options.settlementStatus === "cancelled" ||
    String(options.status || "").toLowerCase().includes("cancel") ||
    String(options.status || "").toLowerCase().includes("refund") ||
    String(options.overallStatus || "").toLowerCase().includes("cancel") ||
    String(options.overallStatus || "").toLowerCase().includes("refund") ||
    String(options.settlementStatus || "").toLowerCase().includes("refund") ||
    String(options.settlementStatus || "").toLowerCase().includes("cancel")
  );

  const rawPaymentMethod = String(options.paymentMethod || "UPI").toUpperCase();
  const isCod = rawPaymentMethod.includes("COD") ||
                rawPaymentMethod.includes("CASH") ||
                rawPaymentMethod.includes("DELIVERY") ||
                rawPaymentMethod === "PAY_ON_DELIVERY" ||
                rawPaymentMethod === "CASH_ON_DELIVERY";
  const isOnline = !isCod;

  const rawDeliveryMode = String(options.deliveryMode || options.deliveryType || "").toLowerCase();
  const hasCourier = Boolean(options.courierName && options.courierName !== "N/A" && options.courierName !== "");
  const isThirdParty = options.isThirdParty === true || 
                       rawDeliveryMode.includes("third") || 
                       rawDeliveryMode.includes("courier") || 
                       (hasCourier && !rawDeliveryMode.includes("self")) ||
                       options.isSelfDelivery === false;
  const isSelfDelivery = !isThirdParty;

  // Determine active rule:
  // Rule 4: COD + Third-Party Courier Delivery (कैश भुगतान + कूरियर से डिलीवरी)
  // Rule 3: COD + Self Delivery (कैश भुगतान + सेलर की डिलीवरी)
  // Rule 2: Online Payment + Third-Party Courier Delivery
  // Rule 1: Online Payment + Self Delivery
  let rule;
  if (isCod && isThirdParty) {
    rule = SETTLEMENT_RULES.COD_THIRD_PARTY_DELIVERY;
  } else if (isCod && isSelfDelivery) {
    rule = SETTLEMENT_RULES.COD_SELF_DELIVERY;
  } else if (isThirdParty) {
    rule = SETTLEMENT_RULES.ONLINE_THIRD_PARTY_DELIVERY;
  } else {
    rule = SETTLEMENT_RULES.ONLINE_SELF_DELIVERY;
  }

  // Statutory GST & Reversal Rules:
  // When an order is cancelled or refunded (Credit Note under Sec 34):
  // 1. Seller pending settlement is reversed to ₹0.00
  // 2. Section 194-O Income Tax TDS is reversed to ₹0.00
  // 3. Section 52 GST TCS (CGST, SGST, IGST) is reversed to ₹0.00
  // 4. Platform commission and GST on commission are waived/reversed to ₹0.00
  // 5. Delivery charge deductions are reversed to ₹0.00
  if (isCancelled) {
    return {
      ruleCode: rule.code,
      ruleNumber: rule.ruleNumber,
      ruleName: `${rule.name} (Cancelled / Refunded)`,
      ruleNameHi: `${rule.nameHi} (रद्द / रिफंड - सेटलमेंट रिवर्सल)`,
      isCod,
      isOnline,
      isSelfDelivery,
      isThirdParty,
      isSellerCollectedCash: false,
      cashCollectedBy: isCod ? (rule.code === "COD_SELF_DELIVERY" ? "seller" : "portal") : "portal",
      grossSale: gross,
      productGstRate: 0,
      isTaxFree: true,
      baseAmount: 0,
      taxableValue: 0,
      commissionRate: 0,
      commissionAmount: 0,
      gstOnCommissionRate: 0,
      gstOnCommissionAmount: 0,
      tdsRate: 0,
      tdsAmount: 0,
      // Statutory Section 52 GST TCS Reversed
      isIntraState: true,
      gstTcsRate: 0,
      gstTcsAmount: 0,
      cgstTcsRate: 0,
      cgstTcsAmount: 0,
      sgstTcsRate: 0,
      sgstTcsAmount: 0,
      igstTcsRate: 0,
      igstTcsAmount: 0,
      // Delivery charges waived
      isAbove400: gross >= Number(options.freeDeliveryThreshold ?? options.minOrderFreeShipping ?? options.freeShippingThreshold ?? 401),
      isAboveThreshold: gross >= Number(options.freeDeliveryThreshold ?? options.minOrderFreeShipping ?? options.freeShippingThreshold ?? 401),
      deliveryChargeBorneBy: "none",
      deliveryChargeAmount: 0,
      gstOnDeliveryRate: 0,
      gstOnDeliveryAmount: 0,
      totalDeliveryDeduction: 0,
      // Aggregates & Final Payout
      statutoryDeductions: 0,
      totalDeductions: 0,
      netSettlement: 0,
      finalSellerSettlement: 0,
      isCancelled: true,
      isSettlementReversed: true
    };
  }

  const isRule3CodSelf = rule.code === "COD_SELF_DELIVERY";

  // 1. Platform Commission Rate (Default 10%)
  const commissionRate = (options.commissionRate !== undefined && options.commissionRate !== null && !isNaN(Number(options.commissionRate)))
    ? Number(options.commissionRate)
    : rule.defaultCommissionRate;

  // 2. GST on Commission Rate (18%)
  const gstOnCommissionRate = (options.gstOnCommissionRate !== undefined && !isNaN(Number(options.gstOnCommissionRate)))
    ? Number(options.gstOnCommissionRate)
    : rule.gstOnCommissionRate;

  // 3. TDS Rate (0.1% under Sec 194-O)
  const tdsRate = (options.tdsRate !== undefined && !isNaN(Number(options.tdsRate)))
    ? Number(options.tdsRate)
    : rule.tdsRate;

  // 4. GST TCS Rate & Breakdown (Sec 52)
  // Intra-State: 0.25% CGST + 0.25% SGST (Total 0.5%)
  // Inter-State: 0.5% IGST
  // Rule 3 (COD Self Delivery): 0% TCS (when portal does not collect customer payment)
  let isIntraState = true;
  if (typeof options.isIntraState === "boolean") {
    isIntraState = options.isIntraState;
  } else if (options.sellerState && (options.customerState || options.shippingState || options.buyerState)) {
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const s1 = norm(options.sellerState);
    const s2 = norm(options.customerState || options.shippingState || options.buyerState);
    if (s1 && s2) {
      const isUp1 = s1 === "up" || s1.includes("uttarpradesh");
      const isUp2 = s2 === "up" || s2.includes("uttarpradesh");
      if (isUp1 && isUp2) {
        isIntraState = true;
      } else {
        isIntraState = s1 === s2;
      }
    }
  }

  // Resolve Product GST Rate & Base Taxable Amount (बिना GST वाले पैसे)
  // नियम: "टीसीएस ग्रॉस वैल्यू पर नहीं कटता, यह सिर्फ 'बेस अमाउंट' (बिना जीएसटी वाले पैसे) पर कटता है।"
  // नियम: "अगर कोई आइटम टैक्स-फ्री है (जैसे किताबें, जिन पर 0% जीएसटी है), तो उस पर टीसीएस बिल्कुल नहीं कटेगा (TCS = 0)।"
  const rawGstRate = (options.gstRate !== undefined && options.gstRate !== null && !isNaN(Number(options.gstRate)))
    ? Number(options.gstRate)
    : (options.gstPercentage !== undefined && options.gstPercentage !== null && !isNaN(Number(options.gstPercentage)))
      ? Number(options.gstPercentage)
      : (options.gstPercent !== undefined && options.gstPercent !== null && !isNaN(Number(options.gstPercent)))
        ? Number(options.gstPercent)
        : (options.gst !== undefined && options.gst !== null && !isNaN(Number(options.gst)))
          ? Number(options.gst)
          : (options.productGstRate !== undefined && options.productGstRate !== null && !isNaN(Number(options.productGstRate)))
            ? Number(options.productGstRate)
            : (options.taxRate !== undefined && options.taxRate !== null && !isNaN(Number(options.taxRate)))
              ? Number(options.taxRate)
              : null;

  const itemCategory = String(options.category || options.productCategory || "").toLowerCase();
  const itemName = String(options.name || options.productName || "").toLowerCase();
  const isBookOrExemptCategory = itemCategory.includes("book") || itemCategory.includes("textbook") || itemName.includes("book") || itemName.includes("ncert");

  const productGstRate = rawGstRate !== null
    ? rawGstRate
    : (isBookOrExemptCategory ? 0 : 5);

  const isTaxFree = productGstRate === 0 || options.isTaxFree === true || options.isExempt === true;

  // Base Amount calculation (Taxable Value without GST):
  let baseAmount;
  if (options.baseAmount !== undefined && options.baseAmount !== null && !isNaN(Number(options.baseAmount))) {
    baseAmount = Math.max(0, Math.round(Number(options.baseAmount) * 100) / 100);
  } else if (options.taxableValue !== undefined && options.taxableValue !== null && !isNaN(Number(options.taxableValue))) {
    baseAmount = Math.max(0, Math.round(Number(options.taxableValue) * 100) / 100);
  } else if (isTaxFree) {
    baseAmount = gross;
  } else {
    // gross includes GST, so baseAmount = gross / (1 + gstRate/100)
    baseAmount = Math.max(0, Math.round((gross / (1 + (productGstRate / 100))) * 100) / 100);
  }

  const baseGstTcsRate = isRule3CodSelf
    ? 0
    : ((options.gstTcsRate !== undefined && !isNaN(Number(options.gstTcsRate)))
        ? Number(options.gstTcsRate)
        : rule.gstTcsRate);

  // 4. GST TCS Rate & Breakdown (Sec 52)
  // TCS applies only to taxable supplies (productGstRate > 0)
  // For 0% GST items (books/tax-free), GST TCS is strictly 0!
  // For Rule 3 COD Self Delivery (portal does not collect funds), GST TCS is strictly 0!
  const isTcsApplicable = !isRule3CodSelf && !isTaxFree && baseGstTcsRate > 0 && baseAmount > 0;

  let cgstTcsRate = 0;
  let sgstTcsRate = 0;
  let igstTcsRate = 0;
  let cgstTcsAmount = 0;
  let sgstTcsAmount = 0;
  let igstTcsAmount = 0;
  let gstTcsRate = isTcsApplicable ? baseGstTcsRate : 0;
  let gstTcsAmount = 0;

  if (isTcsApplicable) {
    if (isIntraState) {
      cgstTcsRate = Math.round((baseGstTcsRate / 2) * 1000) / 1000; // 0.25%
      sgstTcsRate = Math.round((baseGstTcsRate / 2) * 1000) / 1000; // 0.25%
      igstTcsRate = 0;
      cgstTcsAmount = Math.round(((baseAmount * cgstTcsRate) / 100) * 100) / 100;
      sgstTcsAmount = Math.round(((baseAmount * sgstTcsRate) / 100) * 100) / 100;
      igstTcsAmount = 0;
      gstTcsAmount = Math.round((cgstTcsAmount + sgstTcsAmount) * 100) / 100;
    } else {
      cgstTcsRate = 0;
      sgstTcsRate = 0;
      igstTcsRate = baseGstTcsRate; // 0.5%
      cgstTcsAmount = 0;
      sgstTcsAmount = 0;
      igstTcsAmount = Math.round(((baseAmount * igstTcsRate) / 100) * 100) / 100;
      gstTcsAmount = igstTcsAmount;
    }
  }

  // Exact calculations rounded to 2 decimal places (paisa accuracy)
  const commissionAmount = Math.round(((gross * commissionRate) / 100) * 100) / 100;
  const gstOnCommissionAmount = Math.round(((commissionAmount * gstOnCommissionRate) / 100) * 100) / 100;
  // 3. TDS (Sec 194-O): हमेशा 'Gross Value' (टोटल पैसे) पर कटता है (0.1% of Gross Sale).
  // प्रोडक्ट पर GST है या नहीं, इससे TDS को कोई मतलब नहीं है।
  const tdsAmount = Math.round(((gross * tdsRate) / 100) * 100) / 100;

  // 5. Delivery Charges + 18% GST (Rule 2 & Rule 4: Third-Party Delivery)
  // "₹301 से कम के ऑर्डर पर पोर्टल की डिलीवरी नीति के अनुसार चार्ज लागू होंगे।"
  // "₹301 या अधिक के ऑर्डर पर डिलीवरी का खर्च एडमिन उठाएगा, तो सेलर से यह खर्च नहीं काटना है।"
  const totalOrderValue = Number(options.orderTotal || options.totalAmount || gross);
  const freeDeliveryThreshold = Number(
    options.freeDeliveryThreshold ?? 
    options.minOrderFreeShipping ?? 
    options.freeShippingThreshold ?? 
    rule.freeDeliveryThreshold ??
    401
  );
  const isAboveThreshold = totalOrderValue >= freeDeliveryThreshold;
  const isAbove400 = isAboveThreshold; // Backward compatibility alias
  const adminBearsDeliveryAbove400 = options.adminBearsDeliveryAbove400 !== false && isAboveThreshold;

  let deliveryChargeBorneBy = options.deliveryChargeBorneBy;
  if (!deliveryChargeBorneBy) {
    if (isAboveThreshold && (options.adminBearsDeliveryAbove400 !== false)) {
      deliveryChargeBorneBy = "admin";
    } else if (options.isDeliveryBorneBySeller || options.deliveryBorneBy === "seller") {
      deliveryChargeBorneBy = "seller";
    } else if (Number(options.shippingFee || options.shippingAmount || 0) > 0) {
      deliveryChargeBorneBy = "customer";
    } else {
      // For third-party courier delivery < 301 where shipping is not charged to customer, seller bears delivery
      deliveryChargeBorneBy = isThirdParty ? "seller" : "admin";
    }
  }

  // If order is >= ₹301 and admin absorbs it, seller is never deducted for delivery
  const isDeliveryExemptedForSeller = isAboveThreshold && (options.adminBearsDeliveryAbove400 !== false);

  let deliveryChargeAmount = 0;
  // Product GST rate is the default GST rate for delivery (Composite Supply under Section 8 of CGST Act)
  // Delivery charge GST strictly matches the product's GST rate (e.g., 5% product -> 5% delivery, 0% product -> 0% delivery)
  let gstOnDeliveryRate = (productGstRate !== undefined && productGstRate !== null && !isNaN(Number(productGstRate)))
    ? Number(productGstRate)
    : ((options.gstOnDeliveryRate !== undefined && !isNaN(Number(options.gstOnDeliveryRate)))
      ? Number(options.gstOnDeliveryRate)
      : ((options.shippingGstRate !== undefined && !isNaN(Number(options.shippingGstRate)))
        ? Number(options.shippingGstRate)
        : 5));
  let gstOnDeliveryAmount = 0;
  let totalDeliveryDeduction = 0;

  if (isThirdParty && deliveryChargeBorneBy === "seller" && !isDeliveryExemptedForSeller) {
    const rawDeliveryFee = Math.max(0, Number(options.deliveryCharge ?? options.shippingAmount ?? options.shippingFee ?? 40));
    deliveryChargeAmount = Math.round(rawDeliveryFee * 100) / 100;
    gstOnDeliveryAmount = Math.round(((deliveryChargeAmount * gstOnDeliveryRate) / 100) * 100) / 100;
    totalDeliveryDeduction = Math.round((deliveryChargeAmount + gstOnDeliveryAmount) * 100) / 100;
  }

  const statutoryDeductions = Math.round(
    (commissionAmount + gstOnCommissionAmount + tdsAmount + gstTcsAmount) * 100
  ) / 100;

  const totalDeductions = Math.round(
    (statutoryDeductions + totalDeliveryDeduction) * 100
  ) / 100;

  // Final Settlement Calculation:
  // For Rule 1 & 2 (Online payment): Portal collected gross, so it pays seller (Gross - Deductions)
  // For Rule 3 (COD + Self Delivery): Customer paid seller in cash directly. Portal collected ₹0.
  // Seller owes portal (Commission + GST on Commission + TDS).
  // Settlement is negative (-totalDeductions) to be deposited or adjusted in seller wallet.
  // For Rule 4 (COD + Courier): Courier remits cash to portal, so portal pays seller (Gross - Deductions).
  const netSettlement = isRule3CodSelf
    ? Math.round(-totalDeductions * 100) / 100
    : Math.max(0, Math.round((gross - totalDeductions) * 100) / 100);

  return {
    ruleCode: rule.code,
    ruleNumber: rule.ruleNumber,
    ruleName: rule.name,
    ruleNameHi: rule.nameHi,
    isCod,
    isOnline,
    isSelfDelivery,
    isThirdParty,
    isSellerCollectedCash: isRule3CodSelf,
    cashCollectedBy: isRule3CodSelf ? "seller" : "portal",
    grossSale: gross,
    productGstRate,
    isTaxFree,
    baseAmount,
    taxableValue: baseAmount,
    commissionRate,
    commissionAmount,
    gstOnCommissionRate,
    gstOnCommissionAmount,
    tdsRate,
    tdsAmount,
    // GST TCS full dynamic breakdown (Sec 52)
    isIntraState,
    gstTcsRate,
    gstTcsAmount,
    cgstTcsRate,
    cgstTcsAmount,
    sgstTcsRate,
    sgstTcsAmount,
    igstTcsRate,
    igstTcsAmount,
    // Delivery charges breakdown (Rule 2 & 4: ₹301 policy)
    isAbove400,
    isAboveThreshold,
    freeDeliveryThreshold,
    deliveryChargeBorneBy,
    deliveryChargeAmount,
    gstOnDeliveryRate,
    gstOnDeliveryAmount,
    totalDeliveryDeduction,
    // Aggregates
    statutoryDeductions,
    totalDeductions,
    netSettlement,
    finalSellerSettlement: netSettlement
  };
}

/**
 * Determine effective return/exchange window days for an item or order.
 * If explicitly non-returnable and non-exchangeable, return window is 0 days.
 * Default is 7 days unless configured on item/product/order.
 */
export function getEffectiveReturnWindowDays(order = {}, item = {}) {
  const isNonReturnable = (
    item.isReturnable === false ||
    order.isReturnable === false ||
    String(item.returnPolicy || order.returnPolicy || '').toLowerCase().includes('non_returnable') ||
    String(item.returnPolicy || order.returnPolicy || '').toLowerCase().includes('no_return')
  );
  const isNonExchangeable = (
    item.isExchangeable === false ||
    order.isExchangeable === false ||
    String(item.returnPolicy || order.returnPolicy || '').toLowerCase().includes('non_exchangeable') ||
    String(item.returnPolicy || order.returnPolicy || '').toLowerCase().includes('no_exchange')
  );

  if (isNonReturnable && isNonExchangeable) {
    return 0;
  }

  const configuredDays = Number(
    item.returnWindowDays ??
    order.returnWindowDays ??
    item.product?.returnWindowDays ??
    7
  );

  return (!isNaN(configuredDays) && configuredDays >= 0) ? configuredDays : 7;
}

/**
 * Calculate Settlement Maturity & Unlock Date
 * Rules:
 * 1. Non-Return / Non-Exchange Orders:
 *    Settlement happens strictly after (Return Window + 1) days from delivery!
 *    e.g., 7 days return window -> 7 + 1 = 8 days after delivery.
 * 2. Exchanged Orders:
 *    Settlement happens strictly 1 day after the exchange date!
 *    e.g., Exchanged on 16 Oct -> Settles on 17 Oct (1 day after exchange).
 * 3. Return & Refund Orders:
 *    Settlement reversed with auto-recognized statutory Credit Note under Sec 34.
 */
export function calculateSettlementMaturity({ order = {}, item = {}, deliveredAt = null, now = new Date() }) {
  const currentNow = now instanceof Date ? now : new Date(now);
  const overallStatus = String(order.overallStatus || order.status || item.status || '').toLowerCase().trim();
  const returnReqStatus = String(order.returnRequest?.status || item.returnRequest?.status || 'no_request').toLowerCase().trim();

  const isDelivered = overallStatus.includes('delivered');
  const isExchanged = overallStatus === 'exchanged' || returnReqStatus === 'exchanged';
  const isRefunded = ['refunded', 'refund_completed', 'refund_processed'].includes(overallStatus) || 
                     ['refunded', 'refund_completed', 'refund_processed'].includes(returnReqStatus);
  const isCancelled = overallStatus.includes('cancel') || returnReqStatus.includes('cancel') || Boolean(order.cancelledAt);

  // 1. Return & Refund Completed or Order Cancelled: Settlement reversed, Credit note auto-handled
  if (isRefunded || isCancelled) {
    return {
      isDelivered: false,
      isMatured: false,
      isRefunded,
      isCancelled,
      status: isRefunded ? 'refunded' : 'cancelled',
      label: isRefunded ? 'Refunded (Settlement Reversed)' : 'Cancelled (Settlement Reversed)',
      badgeClass: 'bg-rose-50 text-rose-800 border-rose-200',
      returnWindowDays: 0,
      holdingDays: 0,
      settlementDueDate: null,
      daysRemaining: null,
      description: isRefunded
        ? 'Order returned & refunded. Credit Note auto-recognized under Sec 34. Settlement, Commission, TDS and TCS reversed to ₹0.00.'
        : 'Order cancelled. Settlement, Commission, TDS and TCS reversed to ₹0.00.'
    };
  }

  // 2. Exchanged Orders: Settlement unlocks strictly 1 day after exchange date!
  if (isExchanged) {
    let resolvedExchangeDate = order.exchangedAt ||
      item.exchangedAt ||
      order.returnRequest?.exchangedAt ||
      order.returnRequest?.updatedAt ||
      (order.timeline && Array.isArray(order.timeline)
        ? order.timeline.find(t => String(t.status || '').toLowerCase().includes('exchange'))?.timestamp
        : null) ||
      order.updatedAt ||
      order.createdAt ||
      currentNow;

    const exchangeDate = resolvedExchangeDate ? new Date(resolvedExchangeDate) : currentNow;
    // Exactly 1 day after exchange date
    const settlementDueDate = new Date(exchangeDate.getTime() + 1 * 24 * 60 * 60 * 1000);
    const isMatured = currentNow.getTime() >= settlementDueDate.getTime();
    const msRemaining = Math.max(0, settlementDueDate.getTime() - currentNow.getTime());
    const daysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));

    if (isMatured) {
      return {
        isDelivered: true,
        isMatured: true,
        isExchanged: true,
        status: 'matured',
        label: 'Matured & Payable (Exchange Completed)',
        badgeClass: 'bg-emerald-50 text-emerald-800 border-emerald-200',
        returnWindowDays: 0,
        holdingDays: 1,
        settlementDueDate,
        daysRemaining: 0,
        description: `Exchange completed. Settlement unlocked 1 day after exchange on ${settlementDueDate.toLocaleDateString('en-IN')}`
      };
    }

    return {
      isDelivered: true,
      isMatured: false,
      isExchanged: true,
      status: 'in_exchange_buffer',
      label: `Exchange Completed (Settles in ${daysRemaining || 1}d)`,
      badgeClass: 'bg-purple-50 text-purple-900 border-purple-200',
      returnWindowDays: 0,
      holdingDays: 1,
      settlementDueDate,
      daysRemaining: daysRemaining || 1,
      description: `Exchange completed on ${exchangeDate.toLocaleDateString('en-IN')}. Settlement unlocks on ${settlementDueDate.toLocaleDateString('en-IN')} (1 day buffer)`
    };
  }

  // 3. Active return or exchange in progress (pending resolution): Frozen on hold
  const hasActiveReturnRequest = Boolean(
    order.returnRequest &&
    !['no_request', 'rejected', 'return_rejected', 'exchange_rejected', 'exchanged', 'refunded', 'refund_completed'].includes(returnReqStatus)
  );

  if (hasActiveReturnRequest) {
    return {
      isDelivered: true,
      isMatured: false,
      hasActiveReturnRequest: true,
      status: 'on_hold',
      label: 'On Hold (Return/Exchange in Progress)',
      badgeClass: 'bg-amber-50 text-amber-900 border-amber-200',
      returnWindowDays: 0,
      holdingDays: 0,
      settlementDueDate: null,
      daysRemaining: null,
      description: `Settlement frozen due to customer ${returnReqStatus.replace(/_/g, ' ')}`
    };
  }

  // 4. Order In Transit / Not Delivered
  if (!isDelivered) {
    return {
      isDelivered: false,
      isMatured: false,
      status: 'not_delivered',
      label: 'Order in Transit / Not Delivered',
      badgeClass: 'bg-gray-100 text-gray-600 border-gray-200',
      returnWindowDays: 0,
      holdingDays: 0,
      settlementDueDate: null,
      daysRemaining: null
    };
  }

  // 5. Normal Non-Return / Non-Exchange Delivered Orders:
  // Settlement happens strictly after (Return Window + 1) days from delivery!
  let resolvedDeliveredAt = deliveredAt ||
    order.deliveredAt ||
    item.deliveredAt ||
    (order.timeline && Array.isArray(order.timeline)
      ? order.timeline.find(t => String(t.status || '').toLowerCase().includes('deliver'))?.timestamp
      : null) ||
    order.updatedAt ||
    order.createdAt;

  const deliveryDate = resolvedDeliveredAt ? new Date(resolvedDeliveredAt) : currentNow;

  const returnWindowDays = getEffectiveReturnWindowDays(order, item);
  const holdingDays = returnWindowDays + 1; // Return window + 1 buffer day
  const settlementDueDate = new Date(deliveryDate.getTime() + holdingDays * 24 * 60 * 60 * 1000);

  const isMatured = currentNow.getTime() >= settlementDueDate.getTime();
  const msRemaining = Math.max(0, settlementDueDate.getTime() - currentNow.getTime());
  const daysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));

  if (isMatured) {
    return {
      isDelivered: true,
      isMatured: true,
      status: 'matured',
      label: 'Matured & Payable',
      badgeClass: 'bg-emerald-50 text-emerald-800 border-emerald-200',
      returnWindowDays,
      holdingDays,
      settlementDueDate,
      daysRemaining: 0,
      description: `Return period (${returnWindowDays}d + 1d) completed on ${settlementDueDate.toLocaleDateString('en-IN')}`
    };
  }

  return {
    isDelivered: true,
    isMatured: false,
    status: 'in_return_window',
    label: `In Return Window (${daysRemaining}d left)`,
    badgeClass: 'bg-amber-50 text-amber-900 border-amber-200',
    returnWindowDays,
    holdingDays,
    settlementDueDate,
    daysRemaining,
    description: `Settlement unlocks on ${settlementDueDate.toLocaleDateString('en-IN')} (${returnWindowDays} days return + 1 day buffer)`
  };
}

/**
 * Reconcile Seller's Settlement Balances across all delivered orders
 * - Calculates Matured Settlements (Delivered + Return Window + 1 day passed)
 * - Calculates Pending Settlements (Orders still inside Return Window + 1 day)
 * - Safely updates Seller document and item settlementStatus
 */
export async function reconcileSellerSettlementBalances(sellerId, options = {}) {
  try {
    if (!sellerId) return null;
    const now = options.now instanceof Date ? options.now : new Date();

    const seller = await Seller.findById(sellerId);
    if (!seller) return null;

    const sellerIdStr = String(seller._id);
    const sellerStore = String(seller.storeName || '').trim().toLowerCase();

    // Query delivered, exchanged, returned, refunded, and cancelled orders
    const orders = await Order.find({
      $or: [
        { overallStatus: { $regex: /delivered/i } },
        { status: { $regex: /delivered/i } },
        { overallStatus: { $regex: /exchanged/i } },
        { status: { $regex: /exchanged/i } },
        { overallStatus: { $regex: /refund/i } },
        { status: { $regex: /refund/i } },
        { overallStatus: { $regex: /cancel/i } },
        { status: { $regex: /cancel/i } },
        { settlementStatus: { $regex: /refund|cancel/i } },
        { "returnRequest.status": { $regex: /exchanged/i } },
        { "returnRequest.status": { $regex: /refund/i } }
      ]
    });

    let maturedTotal = 0;
    let lockedTotal = 0;
    let totalDeductionsAll = 0;
    let grossDelivered = 0;

    for (const order of orders) {
      const items = Array.isArray(order.items) ? order.items : [];
      let orderModified = false;

      // Filter items belonging to this seller
      const matchingItems = items.filter(it => {
        const itSellerId = String(it.sellerId?._id || it.sellerId || '');
        const itStore = String(it.storeName || it.sellerStoreName || '').trim().toLowerCase();
        const orderSeller = String(order.sellerId?._id || order.sellerId || '');
        const orderStore = String(order.storeName || order.sellerStoreName || '').trim().toLowerCase();
        return (
          itSellerId === sellerIdStr ||
          (sellerStore && itStore === sellerStore) ||
          orderSeller === sellerIdStr ||
          (sellerStore && orderStore === sellerStore)
        );
      });

      if (matchingItems.length === 0) continue;

      for (const item of matchingItems) {
        const itemGross = Number(item.total) || Math.round((Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1)) * 100) / 100;

        // Check maturity & cancellation/refund status
        const maturity = calculateSettlementMaturity({ order, item, now });
        item.settlementDueDate = maturity.settlementDueDate;
        item.returnWindowDays = maturity.returnWindowDays;

        const isItemCancelledOrRefunded = maturity.isRefunded || maturity.isCancelled || 
          String(order.overallStatus || order.status || '').toLowerCase().includes('refund') ||
          String(order.overallStatus || order.status || '').toLowerCase().includes('cancel') ||
          String(item.status || '').toLowerCase().includes('refund') ||
          String(item.status || '').toLowerCase().includes('cancel') ||
          item.settlementStatus === 'refunded' || item.settlementStatus === 'cancelled' ||
          order.settlementStatus === 'refunded' || order.settlementStatus === 'cancelled';

        if (isItemCancelledOrRefunded) {
          // Zero out all financial metrics (Pending Settlement = 0, TDS = 0, TCS = 0, Commission = 0)
          item.commissionRate = 0;
          item.commissionAmount = 0;
          item.gstOnCommissionRate = 0;
          item.gstOnCommissionAmount = 0;
          item.tdsRate = 0;
          item.tdsAmount = 0;
          item.gstTcsRate = 0;
          item.gstTcsAmount = 0;
          item.cgstTcsRate = 0;
          item.cgstTcsAmount = 0;
          item.sgstTcsRate = 0;
          item.sgstTcsAmount = 0;
          item.igstTcsRate = 0;
          item.igstTcsAmount = 0;
          item.deliveryChargeAmount = 0;
          item.gstOnDeliveryAmount = 0;
          item.totalDeliveryDeduction = 0;
          item.totalDeductions = 0;
          item.netSettlementAmount = 0;
          item.settlementStatus = 'refunded';
          item.isSettlementMatured = false;
          orderModified = true;
          continue; // Do NOT add anything to grossDelivered, totalDeductionsAll, maturedTotal, or lockedTotal
        }

        grossDelivered += itemGross;

        // If active item doesn't have netSettlementAmount computed, calculate it
        if (item.netSettlementAmount === undefined || item.netSettlementAmount === null) {
          const stl = calculateSellerSettlement(itemGross, {
            commissionRate: item.commissionRate ?? order.commissionRate ?? seller.commissionRate ?? 10,
            paymentMethod: order.paymentMethod,
            deliveryMode: order.deliveryMode,
            courierName: order.courierName,
            isThirdParty: order.isThirdParty,
            deliveryChargeBorneBy: order.deliveryChargeBorneBy,
            orderTotal: order.totalAmount || order.total,
            category: item.category,
            name: item.name
          });
          item.commissionAmount = stl.commissionAmount;
          item.gstOnCommissionAmount = stl.gstOnCommissionAmount;
          item.tdsAmount = stl.tdsAmount;
          item.gstTcsAmount = stl.gstTcsAmount;
          item.totalDeliveryDeduction = stl.totalDeliveryDeduction;
          item.totalDeductions = stl.totalDeductions;
          item.netSettlementAmount = stl.netSettlement;
          item.settlementRule = stl.ruleCode;
          orderModified = true;
        }

        totalDeductionsAll += Number(item.totalDeductions || 0);
        const itemNetSettlement = Number(item.netSettlementAmount || 0);

        if (maturity.isMatured) {
          if (item.settlementStatus !== 'credited' && item.settlementStatus !== 'settled') {
            item.settlementStatus = 'credited';
            item.isSettlementMatured = true;
            item.settlementMaturedAt = item.settlementMaturedAt || now;
            orderModified = true;
          }
          maturedTotal += itemNetSettlement;
        } else if (maturity.status === 'in_return_window' || maturity.status === 'in_exchange_buffer') {
          const targetStatus = maturity.status === 'in_exchange_buffer' ? 'pending_exchange_buffer' : 'pending_return_window';
          if (item.settlementStatus !== targetStatus) {
            item.settlementStatus = targetStatus;
            item.isSettlementMatured = false;
            orderModified = true;
          }
          lockedTotal += itemNetSettlement;
        } else if (maturity.status === 'on_hold') {
          if (item.settlementStatus !== 'on_hold') {
            item.settlementStatus = 'on_hold';
            item.isSettlementMatured = false;
            orderModified = true;
          }
        }
      }

      if (orderModified) {
        order.settlementDueDate = matchingItems[0]?.settlementDueDate || order.settlementDueDate;
        order.isSettlementMatured = matchingItems.some(it => it.isSettlementMatured);
        if (matchingItems.every(it => it.settlementStatus === 'refunded' || it.settlementStatus === 'cancelled')) {
          order.settlementStatus = 'refunded';
          order.isSettlementMatured = false;
          order.tdsAmount = 0;
          order.gstTcsAmount = 0;
          order.cgstTcsAmount = 0;
          order.sgstTcsAmount = 0;
          order.igstTcsAmount = 0;
          order.commissionAmount = 0;
          order.gstOnCommissionAmount = 0;
          order.totalDeliveryDeduction = 0;
          order.totalDeductions = 0;
          order.sellerPayout = 0;
          order.sellerSettlement = 0;
          order.netSettlementAmount = 0;
          const displayId = order.orderId || order.id || String(order._id).slice(-8).toUpperCase();
          order.creditNoteNumber = order.creditNoteNumber || `CN-${displayId}`;
          order.creditNoteIssuedAt = order.creditNoteIssuedAt || now;
        } else if (order.isSettlementMatured && order.settlementStatus !== 'settled') {
          order.settlementStatus = 'settled';
        }
        await order.save().catch(e => console.warn('Could not save order maturity updates:', e.message));
      }
    }

    const totalWithdrawn = Number(seller.totalWithdrawn || 0);
    const finalWalletBalance = Math.max(0, Math.round((maturedTotal - totalWithdrawn) * 100) / 100);
    const finalPendingBalance = Math.max(0, Math.round(lockedTotal * 100) / 100);
    const totalEarnings = Math.round((maturedTotal + lockedTotal) * 100) / 100;

    seller.walletBalance = finalWalletBalance;
    seller.pendingSettlementBalance = finalPendingBalance;
    seller.totalEarnings = totalEarnings;
    await seller.save().catch(e => console.warn('Could not save seller wallet balances:', e.message));

    return {
      sellerId: sellerIdStr,
      storeName: seller.storeName,
      walletBalance: finalWalletBalance,
      pendingSettlementBalance: finalPendingBalance,
      maturedTotal: Math.round(maturedTotal * 100) / 100,
      lockedTotal: Math.round(lockedTotal * 100) / 100,
      totalWithdrawn,
      totalEarnings,
      grossDelivered: Math.round(grossDelivered * 100) / 100
    };
  } catch (err) {
    console.error('Error reconciling seller settlements:', err);
    return null;
  }
}

export default {
  SETTLEMENT_RULES,
  calculateSellerSettlement,
  getEffectiveReturnWindowDays,
  calculateSettlementMaturity,
  reconcileSellerSettlementBalances
};
