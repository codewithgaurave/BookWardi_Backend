/**
 * Invoice Numbering and Series Generation Utility
 * Generates sequential seller-specific invoice numbers (e.g. NSD01, NSD02, SS01, SS02)
 * Supports Section 31 Replacement Invoices for Exchanges and Section 34 Credit Notes
 */

export const getSellerInvoicePrefix = (sellerOrStoreName) => {
  const name = (
    (typeof sellerOrStoreName === 'string' ? sellerOrStoreName : '') ||
    sellerOrStoreName?.storeName ||
    sellerOrStoreName?.sellerStoreName ||
    sellerOrStoreName?.businessName ||
    sellerOrStoreName?.sellerName ||
    sellerOrStoreName?.name ||
    ''
  ).trim();

  if (!name) return 'INV';

  const upper = name.toUpperCase();

  // Known Seller Exact Brand Matches
  if (upper.includes('NATIONAL SCHOOL DRESS') || upper.includes('NATIONAL SCHOOL')) {
    return 'NSD';
  }

  // Filter out filler words in Hindi/English business names
  const noiseWords = new Set([
    'AND', 'EVAM', 'THE', 'PVT', 'LTD', 'LIMITED', 'PRIVATE',
    'ENTERPRISE', 'ENTERPRISES', 'STORE', 'STORES', 'BHANDAR',
    'PUSTAK', 'BOOK', 'BOOKS', 'SHOP', 'COMPANY', 'CO'
  ]);

  const words = upper
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !noiseWords.has(w));

  const candidateWords = words.length > 0 
    ? words 
    : upper.replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 0);

  if (candidateWords.length >= 3) {
    return (candidateWords[0][0] + candidateWords[1][0] + candidateWords[2][0]).toUpperCase();
  } else if (candidateWords.length === 2) {
    return (candidateWords[0][0] + candidateWords[1][0]).toUpperCase();
  } else if (candidateWords.length === 1) {
    const single = candidateWords[0];
    return single.length >= 3 ? single.slice(0, 3) : single.padEnd(2, 'S');
  }

  return 'INV';
};

export const formatSellerInvoiceNumber = (prefix, seqNumber) => {
  const cleanPrefix = (prefix || 'INV').toUpperCase().trim();
  const num = Math.max(1, Number(seqNumber) || 1);
  return `${cleanPrefix}${String(num).padStart(2, '0')}`;
};

export const formatSellerCreditNoteNumber = (prefix, seqNumber) => {
  const cleanPrefix = (prefix || 'INV').toUpperCase().trim();
  const num = Math.max(1, Number(seqNumber) || 1);
  return `${cleanPrefix}CN${String(num).padStart(2, '0')}`;
};

/**
 * Checks whether an order had an exchange that was delivered / doorstep swap completed
 */
export const isOrderExchangeDelivered = (order) => {
  if (!order) return false;
  const rawStatus = String(order.status || order.overallStatus || '').toLowerCase().trim();
  const normStatus = rawStatus.replace(/[\s-]+/g, '_');
  const normReturnStatus = String(order.returnRequest?.status || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  const returnReqStatus = normReturnStatus;
  const returnType = String(order.returnRequest?.type || order.returnRequest?.requestType || '').toLowerCase().trim();

  const isExchange = returnType === 'exchange' ||
                     normStatus.includes('exchange') ||
                     normReturnStatus.includes('exchange') ||
                     String(order.deliveryStatus || '').toLowerCase().includes('swap') ||
                     String(order.selfDeliveryDetails?.status || '').toLowerCase().includes('swap') ||
                     Boolean(order.returnRequest?.exchangeSize || order.returnRequest?.exchangeLength);

  if (!isExchange) return false;

  const deliveryStatus = String(order.deliveryStatus || '').toLowerCase();
  const selfDelivStatus = String(order.selfDeliveryDetails?.status || '').toLowerCase();

  const isDelivered = normStatus === 'exchanged' ||
                      normStatus === 'swap_completed' ||
                      normStatus.includes('completed') ||
                      normStatus === 'delivered' ||
                      deliveryStatus.includes('swap completed') ||
                      deliveryStatus.includes('delivered') ||
                      selfDelivStatus.includes('swap completed') ||
                      selfDelivStatus.includes('delivered') ||
                      Boolean(order.deliveredAt) ||
                      Boolean(order.exchangedAt) ||
                      ['exchanged', 'swap_completed', 'delivered', 'completed'].includes(returnReqStatus);

  return isDelivered;
};

/**
 * Resolves the sequential Section 34 Credit Note number for an order
 * (e.g. NSD04 -> NSDCN04)
 */
export const getSellerCreditNoteNumber = (order, seller = null, allOrders = []) => {
  if (!order) return 'INVCN01';
  if (order.sellerCreditNoteNo && /^[A-Z0-9]{2,}CN\d+$/i.test(order.sellerCreditNoteNo)) {
    return order.sellerCreditNoteNo;
  }
  if (order.creditNoteNumber && /^[A-Z0-9]{2,}CN\d+$/i.test(order.creditNoteNumber)) {
    return order.creditNoteNumber;
  }
  const sellerCand = seller || order.sellerDetails || order.items?.[0]?.sellerDetails || order;
  const storeName = sellerCand?.storeName || sellerCand?.sellerStoreName || sellerCand?.businessName || sellerCand?.name || order.sellerStoreName || order.storeName || '';
  const prefix = getSellerInvoicePrefix(storeName);

  // If order has an invoice number (like NSD04), sync CN number with it directly
  const invStr = String(order.sellerInvoiceNo || order.invoiceNumber || '');
  const match = invStr.match(/^[A-Z0-9]{2,}?0*(\d+)$/i);
  if (match) {
    const seq = parseInt(match[1], 10);
    return formatSellerCreditNoteNumber(prefix, seq);
  }

  const seq = order.sellerCreditNoteSequence || order.sellerSequence || 1;
  return formatSellerCreditNoteNumber(prefix, seq);
};

/**
 * Resolves the sequential invoice number for a given base order
 */
export const getSellerInvoiceNumber = (order, seller = null, allOrders = []) => {
  if (!order) return 'INV01';

  // 1. If order has a custom pre-computed seller invoice number that is not INV-<orderId>
  const existingInv = order.invoiceNumber || order.sellerInvoiceNo;
  if (existingInv && typeof existingInv === 'string' && !existingInv.startsWith('INV-')) {
    return existingInv;
  }

  // 2. Resolve prefix from seller or order
  const sellerCand = seller || order.sellerDetails || order.items?.[0]?.sellerDetails || order;
  const storeName = sellerCand?.storeName || sellerCand?.sellerStoreName || sellerCand?.businessName || sellerCand?.name || order.sellerStoreName || order.storeName || '';
  const prefix = getSellerInvoicePrefix(storeName);

  // 3. If explicit sellerSequence is attached
  if (order.sellerSequence && Number(order.sellerSequence) > 0) {
    return formatSellerInvoiceNumber(prefix, order.sellerSequence);
  }

  // 4. Calculate chronological sequence from allOrders list if provided
  if (Array.isArray(allOrders) && allOrders.length > 0) {
    const targetOrderId = String(order.id || order.orderId || order._id || '');
    
    // Sort all orders chronologically (oldest first)
    const sorted = [...allOrders].sort((a, b) => {
      const timeA = new Date(a.createdAt || a.date || 0).getTime() || 0;
      const timeB = new Date(b.createdAt || b.date || 0).getTime() || 0;
      if (timeA !== timeB) return timeA - timeB;
      return String(a._id || a.id || '').localeCompare(String(b._id || b.id || ''));
    });

    const index = sorted.findIndex((o) => String(o.id || o.orderId || o._id || '') === targetOrderId);
    if (index >= 0) {
      return formatSellerInvoiceNumber(prefix, index + 1);
    }
  }

  return formatSellerInvoiceNumber(prefix, 1);
};

/**
 * Resolves the sequential replacement invoice number for a delivered exchange product
 * (e.g. if order was NSD04, replacement delivered item gets NSD05)
 */
export const getSellerExchangeInvoiceNumber = (order, seller = null, allOrders = []) => {
  if (!order) return null;

  // 1. If explicit exchange invoice number exists on order and is clean
  const existingExch = order.exchangeInvoiceNumber || order.sellerExchangeInvoiceNo;
  if (existingExch && typeof existingExch === 'string' && !existingExch.startsWith('EXCH-') && !existingExch.startsWith('INV-')) {
    return existingExch;
  }

  // Only delivered exchanges get a replacement invoice
  if (!isOrderExchangeDelivered(order)) {
    return null;
  }

  const sellerCand = seller || order.sellerDetails || order.items?.[0]?.sellerDetails || order;
  const storeName = sellerCand?.storeName || sellerCand?.sellerStoreName || sellerCand?.businessName || sellerCand?.name || order.sellerStoreName || order.storeName || '';
  const prefix = getSellerInvoicePrefix(storeName);

  // 2. If explicit sellerExchangeSequence is set
  if (order.sellerExchangeSequence && Number(order.sellerExchangeSequence) > 0) {
    return formatSellerInvoiceNumber(prefix, order.sellerExchangeSequence);
  }

  // 3. Calculate sequence based on base orders count + exchange delivery rank
  if (Array.isArray(allOrders) && allOrders.length > 0) {
    const targetOrderId = String(order.id || order.orderId || order._id || '');

    // Determine max base sequence or count
    let maxBaseSeq = 0;
    allOrders.forEach(o => {
      const seq = Number(o.sellerSequence) || 0;
      if (seq > maxBaseSeq) maxBaseSeq = seq;
      const invMatch = String(o.sellerInvoiceNo || o.invoiceNumber || '').match(/^[A-Z0-9]{2,}?0*(\d+)$/i);
      if (invMatch) {
        const num = parseInt(invMatch[1], 10);
        if (num > maxBaseSeq) maxBaseSeq = num;
      }
    });
    if (maxBaseSeq === 0) maxBaseSeq = allOrders.length;

    // Filter delivered exchanges
    const deliveredExchanges = allOrders
      .filter(o => isOrderExchangeDelivered(o))
      .sort((a, b) => {
        const timeA = new Date(a.returnRequest?.updatedAt || a.deliveredAt || a.exchangedAt || a.createdAt || 0).getTime();
        const timeB = new Date(b.returnRequest?.updatedAt || b.deliveredAt || b.exchangedAt || b.createdAt || 0).getTime();
        if (timeA !== timeB) return timeA - timeB;
        return String(a._id || a.id || '').localeCompare(String(b._id || b.id || ''));
      });

    const exchIdx = deliveredExchanges.findIndex(o => String(o.id || o.orderId || o._id || '') === targetOrderId);
    if (exchIdx >= 0) {
      const exchSeq = maxBaseSeq + exchIdx + 1;
      return formatSellerInvoiceNumber(prefix, exchSeq);
    }
  }

  return null;
};
