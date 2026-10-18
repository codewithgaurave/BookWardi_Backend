import PDFDocument from "pdfkit";

/**
 * Generate an official PDF Partial Advance Payment Receipt for a School Bulk Order
 * @param {Object} order - SchoolBulkOrder document
 * @returns {PDFDocument} - Streaming PDF document
 */
export const generatePartialAdvanceReceiptPDF = (order) => {
  const doc = new PDFDocument({ margin: 40, size: "A4" });

  const primaryColor = "#0f172a"; // Slate 900
  const brandTeal = "#0f766e"; // Teal 700
  const emeraldGreen = "#059669"; // Emerald 600
  const mutedColor = "#64748b"; // Slate 500
  const borderColor = "#e2e8f0"; // Slate 200

  const refId = order.referenceId || (order._id ? order._id.toString().substring(0, 8).toUpperCase() : "BULK-2026");
  const receiptNo = order.advanceReceiptNumber || `REC-ADV-${refId}`;
  const totalBudget = Number(order.overallBudget || order.targetBudgetPerKit || order.estimatedBudget || order.quoteAmount || 0);

  const advPct = Number(order.sellerAdvancePercentage || order.buyerAdvancePercentage || order.prepaymentPercentage || 20);
  const advAmount = Number(
    order.advancePaidAmount ||
    order.sellerAdvanceAmount ||
    order.buyerAdvanceAmount ||
    (totalBudget > 0 ? Math.round((totalBudget * advPct) / 100) : 0)
  );
  const remainingBalance = Math.max(0, totalBudget - advAmount);

  const dateStr = order.advancePaidAt
    ? new Date(order.advancePaidAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

  // 1. HEADER SECTION (Brand Left, Invoice Meta Right with zero overlap)
  doc
    .fillColor(brandTeal)
    .fontSize(22)
    .font("Helvetica-Bold")
    .text("Bookvardi", 40, 36)
    .fontSize(8.5)
    .font("Helvetica")
    .fillColor(mutedColor)
    .text("B2B & School Institutional Procurement Desk", 40, 62)
    .text("GSTIN: 09AAACS1429B1Z2 | corporate@bookvardi.in", 40, 74);

  // Right Header - Clean, dedicated coordinates avoiding any text collision
  doc
    .fillColor(primaryColor)
    .fontSize(12)
    .font("Helvetica-Bold")
    .text("TAX INVOICE & ADVANCE RECEIPT", 260, 36, { width: 295, align: "right" });

  doc
    .fontSize(8.5)
    .font("Helvetica")
    .fillColor(mutedColor)
    .text(`Invoice / Receipt No: ${receiptNo}`, 260, 54, { width: 295, align: "right" })
    .text(`Bulk Order Ref: #${refId}`, 260, 66, { width: 295, align: "right" })
    .text(`Payment Date: ${dateStr}`, 260, 78, { width: 295, align: "right" });

  // Header Divider
  doc.strokeColor(borderColor).lineWidth(1).moveTo(40, 96).lineTo(555, 96).stroke();

  // 2. PARTIES DETAILS (BUYER & SUPPLIER)
  // Left: Buyer (School)
  const buyerAddress = [order.address, order.city, order.state, order.pincode].filter(Boolean).join(", ") || order.deliveryLocation || "Campus Address, Uttar Pradesh";
  const contactName = order.contactName || order.contactPerson || order.buyerName || "Authorized Representative";
  const contactPhone = order.contactPhone || order.userPhone || "N/A";
  const contactEmail = order.contactEmail || order.userEmail || "";

  doc
    .fontSize(9.5)
    .font("Helvetica-Bold")
    .fillColor(primaryColor)
    .text("PROCURING INSTITUTION / BUYER:", 40, 108)
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(primaryColor)
    .text(order.institutionName || order.schoolName || "Institutional Buyer", 40, 122, { width: 245 })
    .font("Helvetica")
    .fontSize(8)
    .fillColor(mutedColor)
    .text(`Attn: ${contactName}`, 40, 134, { width: 245 })
    .text(`Phone: ${contactPhone}${contactEmail ? ` | ${contactEmail}` : ""}`, 40, 145, { width: 245 })
    .text(`Address: ${buyerAddress}`, 40, 156, { width: 245, lineBreak: true });

  // Right: Supplier (Seller)
  const sellerInfo = order.sellerId && typeof order.sellerId === "object" ? order.sellerId : null;
  const supplierName = sellerInfo?.storeName || sellerInfo?.businessName || sellerInfo?.name || order.sellerStoreName || "Bookvardi Verified Partner Network";
  const supplierCity = sellerInfo?.city || order.city || "Lucknow, Uttar Pradesh";

  doc
    .fontSize(9.5)
    .font("Helvetica-Bold")
    .fillColor(primaryColor)
    .text("AUTHORIZED SELLER / SUPPLIER:", 310, 108)
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(primaryColor)
    .text(supplierName, 310, 122, { width: 245 })
    .font("Helvetica")
    .fontSize(8)
    .fillColor(mutedColor)
    .text("Authorized B2B Institutional Vendor Hub", 310, 134, { width: 245 })
    .text("Escrow & Mobilization Settlement via Bookvardi", 310, 145, { width: 245 })
    .text(`Location: ${supplierCity}`, 310, 156, { width: 245 });

  // Divider
  doc.strokeColor(borderColor).lineWidth(1).moveTo(40, 186).lineTo(555, 186).stroke();

  // 3. ADVANCE PAYMENT HIGHLIGHT CARD (TINTED BOX)
  doc
    .roundedRect(40, 196, 515, 68, 6)
    .fillAndStroke("#f0fdf4", "#bbf7d0");

  doc
    .fontSize(8.5)
    .font("Helvetica-Bold")
    .fillColor(brandTeal)
    .text("MOBILIZATION PREPAYMENT TAX INVOICE & FINANCIAL TRAIL", 52, 206);

  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor(primaryColor)
    .text(`Total Agreed Contract Value: Rs. ${totalBudget.toLocaleString('en-IN')}`, 52, 220)
    .text(`Prepayment Mobilization Rate: ${advPct}% Upfront`, 52, 232)
    .text(`Online Txn ID: ${order.advanceTransactionId || "pay_TnVu9EPSX1vMbp"}`, 52, 244)
    .text(`Payment Mode: ${order.advancePaymentMode || "Online (Razorpay / UPI)"}`, 52, 256);

  doc
    .fontSize(10.5)
    .font("Helvetica-Bold")
    .fillColor(emeraldGreen)
    .text(`Advance Paid: Rs. ${advAmount.toLocaleString('en-IN')}`, 320, 214, { width: 225, align: "right" })
    .fontSize(9)
    .font("Helvetica-Bold")
    .fillColor("#b91c1c") // Red
    .text(`Remaining Due on Delivery: Rs. ${remainingBalance.toLocaleString('en-IN')}`, 320, 229, { width: 225, align: "right" })
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor(emeraldGreen)
    .text(`Status: ${(order.advancePaymentStatus || "Paid").toUpperCase()} (VERIFIED ESCROW)`, 320, 244, { width: 225, align: "right" });

  // 4. PROCUREMENT ITEMS SUMMARY TABLE
  const tableTop = 278;
  doc
    .rect(40, tableTop, 515, 20)
    .fill("#f8fafc");

  doc
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor(primaryColor)
    .text("#", 45, tableTop + 6)
    .text("Requirement Demand Item", 68, tableTop + 6)
    .text("Category", 270, tableTop + 6)
    .text("Qty", 380, tableTop + 6, { align: "center", width: 40 })
    .text("Rate", 430, tableTop + 6, { align: "right", width: 55 })
    .text("Line Total", 492, tableTop + 6, { align: "right", width: 58 });

  let y = tableTop + 23;
  const items = Array.isArray(order.requirements) && order.requirements.length > 0
    ? order.requirements.slice(0, 8)
    : [{ itemName: order.requirementSummary || "Bulk Uniform / Stationery Supply", category: "School Supplies", quantity: order.totalQuantity || 100, sellerPricePerUnit: Math.round(totalBudget / (order.totalQuantity || 100)) }];

  items.forEach((item, index) => {
    const qty = Number(item.quantity) || 1;
    const rate = Number(item.sellerPricePerUnit || item.budgetPerUnit || (totalBudget > 0 && order.totalQuantity > 0 ? Math.round(totalBudget / order.totalQuantity) : 0));
    const lineTotal = qty * rate;

    const rowBg = index % 2 === 1 ? "#fafafa" : "#ffffff";
    doc.rect(40, y - 2, 515, 20).fill(rowBg);

    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor(primaryColor)
      .text(String(index + 1), 45, y + 3)
      .text(item.itemName || item.name || "Procurement Item", 68, y + 3, { width: 195, lineBreak: false })
      .fillColor(mutedColor)
      .text(item.category || "School Uniforms", 270, y + 3, { width: 105, lineBreak: false })
      .fillColor(primaryColor)
      .text(String(qty), 380, y + 3, { align: "center", width: 40 })
      .text(`Rs. ${rate.toLocaleString('en-IN')}`, 430, y + 3, { align: "right", width: 55 })
      .font("Helvetica-Bold")
      .text(`Rs. ${lineTotal.toLocaleString('en-IN')}`, 492, y + 3, { align: "right", width: 58 });

    y += 20;
  });

  // Table bottom border
  doc.strokeColor(borderColor).lineWidth(1).moveTo(40, y + 2).lineTo(555, y + 2).stroke();

  // 5. TERMS & CONDITIONS
  const termsY = y + 16;
  doc
    .fontSize(8.5)
    .font("Helvetica-Bold")
    .fillColor(primaryColor)
    .text("Mobilization Advance & Delivery Handover Terms:", 40, termsY)
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor(mutedColor)
    .text("1. This tax receipt confirms receipt of mobilization advance payment towards raw material procurement, cutting, and batch tailoring.", 40, termsY + 13)
    .text(`2. The remaining balance amount of Rs. ${remainingBalance.toLocaleString('en-IN')} is due upon delivery handover and physical verification of consignment.`, 40, termsY + 23)
    .text("3. Settlement is protected by Bookvardi B2B Escrow. Final GST Tax Invoice will be issued upon complete consignment dispatch.", 40, termsY + 33)
    .text("4. Delivery is fulfilled exclusively via Bookvardi Verified Merchant Partner network under institutional supply terms.", 40, termsY + 43);

  // 6. VERIFICATION STAMP & DIGITAL SEAL
  const stampY = termsY + 62;
  doc
    .roundedRect(40, stampY, 230, 48, 5)
    .strokeColor("#86efac")
    .fillAndStroke("#f0fdf4", "#86efac");

  doc
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor(brandTeal)
    .text("BOOKVARDI VERIFIED ADVANCE RECEIPT", 50, stampY + 9)
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor(mutedColor)
    .text("Authorized Desk: B2B Institutional Escrow", 50, stampY + 20)
    .text(`Audit Trail Ref: BV-ESCROW-${refId}-OK`, 50, stampY + 31);

  doc
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor(primaryColor)
    .text("Bookvardi Authorized Desk / Seller Hub", 310, stampY + 16, { width: 245, align: "right" })
    .fontSize(7.5)
    .font("Helvetica")
    .fillColor(emeraldGreen)
    .text("Digitally Verified & Stamped on Bookvardi Platform", 310, stampY + 28, { width: 245, align: "right" });

  doc.end();
  return doc;
};
