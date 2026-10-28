/**
 * Invoice Numbering and Series Generation Utility
 * Generates sequential seller-specific invoice numbers (e.g. NSD01, NSD02, SS01, SS02)
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

  // If filtered out everything, fallback to original words without noise filtering
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

export const getSellerCreditNoteNumber = (order, filterSellerId = null) => {
  if (order.creditNoteNumber && !order.creditNoteNumber.startsWith('CN-INV-') && !order.creditNoteNumber.startsWith('CN-ORDER')) {
    return order.creditNoteNumber;
  }
  if (order.sellerCreditNoteNo) {
    return order.sellerCreditNoteNo;
  }
  const prefix = getSellerInvoicePrefix(order.sellerStoreName || order.storeName || order.sellerName);
  const seq = order.sellerCreditNoteSequence || order.sellerSequence || 1;
  return formatSellerCreditNoteNumber(prefix, seq);
};


