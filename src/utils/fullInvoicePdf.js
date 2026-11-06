const { jsPDF } = require("jspdf");
const autoTableImport = require("jspdf-autotable");
const autoTable = autoTableImport.default || autoTableImport;
const QRCode = require("qrcode");
const { normalizeDiscount, normalizeGstRate } = require("./invoiceTax");

// This file is the server-side twin of abros-web-frontend/src/utils/invoiceExport.js
// (the PDF the UI downloads). The two must produce the same document: when one
// changes, change the other, and keep the money maths identical to
// abros-web-frontend/src/utils/invoiceTax.js.

const SELLER = {
  name: "ABROS HEALTHCARE",
  addressLine: "Shop-2, Shivpuri Colony, Sultanpur, Ambala City.",
  pincode: "134003",
  phone: "8295566445",
  phoneDisplay: "82955-66445",
  gstin: "06AFUPJ3372H1Z5",
  dlNumbers: ["WLF20B2026HR000446", "WLF21B2026HR000442"],
  bankName: "Punjab National Bank, Prem Nagar",
  ifsc: "PUNB0120310",
  account: "10401132000162",
  forLabel: "For ABROS HEALTHCARE",
};

// The UI reads VITE_UPI_ID; set UPI_ID to the same value here so the QR on a
// Telegram bill pays the same account as the QR on a bill downloaded from the UI.
const UPI_ID = () => (process.env.UPI_ID || "8295566445@paytm").trim();
const UPI_PAYEE_NAME = () =>
  (process.env.UPI_PAYEE_NAME || SELLER.name).trim();

const TERMS = [
  "1. All disputes Subject to Ambala Jurisdiction only.",
  "2. Goods once sold will not taken back or Exchanged.",
];

function formatAmount(value) {
  return Number(value || 0).toFixed(2);
}

function displayOrDash(value) {
  const text = value == null ? "" : String(value).trim();
  return text || "-";
}

function twoDigitWords(num) {
  const ones = [
    "", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
    "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN",
    "SEVENTEEN", "EIGHTEEN", "NINETEEN"
  ];
  const tens = [
    "", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"
  ];

  if (num < 20) return ones[num];
  const remainder = num % 10;
  return `${tens[Math.floor(num / 10)]}${remainder ? ` ${ones[remainder]}` : ""}`;
}

function convertNumberToWords(num) {
  if (!num) return "ZERO";
  if (num < 0) return `MINUS ${convertNumberToWords(Math.abs(num))}`;

  let words = "";

  const crore = Math.floor(num / 10000000);
  if (crore) {
    words += `${convertNumberToWords(crore)} CRORE `;
    num %= 10000000;
  }

  const lakh = Math.floor(num / 100000);
  if (lakh) {
    words += `${convertNumberToWords(lakh)} LAKH `;
    num %= 100000;
  }

  const thousand = Math.floor(num / 1000);
  if (thousand) {
    words += `${convertNumberToWords(thousand)} THOUSAND `;
    num %= 1000;
  }

  const hundred = Math.floor(num / 100);
  if (hundred) {
    words += `${convertNumberToWords(hundred)} HUNDRED `;
    num %= 100;
  }

  if (num) {
    words += twoDigitWords(num);
  }

  return words.trim();
}

function amountInWords(amount) {
  const rupees = Math.floor(Number(amount) || 0);
  const paise = Math.round((Number(amount) - rupees) * 100);
  let words = convertNumberToWords(rupees);
  if (paise) {
    words += ` AND ${convertNumberToWords(paise)} PAISE`;
  }
  return `${words} ONLY.`;
}

function getMedicine(item) {
  return item.medicine && typeof item.medicine === "object" ? item.medicine : null;
}

function getLineItemHsn(item) {
  const med = getMedicine(item);
  return item.hsn || med?.hsn || "";
}

function getLineItemGstRate(item) {
  const med = getMedicine(item);
  return normalizeGstRate(item?.gstRate ?? med?.gstRate);
}

function calculateLineAmount(quantity, rate, discount = 0) {
  const gross = Number(quantity || 0) * Number(rate || 0);
  const discountAmount = gross * (normalizeDiscount(discount) / 100);
  return Math.round((gross - discountAmount) * 100) / 100;
}

// The stored line amount is the taxable value (before GST).
function getLineTaxableAmount(item) {
  if (item?.amount != null) return Number(item.amount);
  return calculateLineAmount(item?.quantity, item?.rate, item?.discount);
}

// What the Amount column shows: taxable value plus CGST and SGST.
function getLineTotalWithGst(item) {
  const taxable = getLineTaxableAmount(item);
  const halfRate = getLineItemGstRate(item) / 200;
  const cgst = Math.round(taxable * halfRate * 100) / 100;
  const sgst = Math.round(taxable * halfRate * 100) / 100;
  return Math.round((taxable + cgst + sgst) * 100) / 100;
}

function formatLineItemQuantity(quantity, free) {
  const qty = Number(quantity) || 0;
  const freeQty = Number(free) || 0;
  return freeQty > 0 ? `${qty}+${freeQty}` : String(qty);
}

// The server runs in UTC, so a date stored as IST midnight would print as the
// previous day. Dates are always read in IST, as they are on the user's phone.
const IST_DATE_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
});

function istParts(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(
    IST_DATE_PARTS.formatToParts(date).map((part) => [part.type, part.value]),
  );
}

function formatShortInvoiceDate(value) {
  const parts = istParts(value);
  return parts ? `${parts.day}-${parts.month}-${parts.year}` : "";
}

function formatExpiryShort(value) {
  const parts = istParts(value);
  return parts ? `${parts.month}-${parts.year}` : "";
}

const PDF_ITEM_HEADERS = [
  "S. No.", "Prodcut Name", "Packing", "HSN", "MFG", "BATCH", "EXP.",
  "MRP", "QTY.", "RATE", "DISC.", "CGST", "SGST", "Amount"
];

// Same rounding steps as the invoice itself: each line's CGST and SGST are
// rounded to paise, then the grand total to the rupee.
function calculateTaxSummary(items = []) {
  const lines = items.map((item) => {
    const amount = getLineTaxableAmount(item);
    const halfRate = getLineItemGstRate(item) / 200;
    return {
      amount,
      cgst: Math.round(amount * halfRate * 100) / 100,
      sgst: Math.round(amount * halfRate * 100) / 100,
    };
  });

  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const cgst = Math.round(lines.reduce((sum, line) => sum + line.cgst, 0) * 100) / 100;
  const sgst = Math.round(lines.reduce((sum, line) => sum + line.sgst, 0) * 100) / 100;
  const grandTotal = Math.round(subtotal + cgst + sgst);

  return { subtotal: Math.round(subtotal * 100) / 100, cgst, sgst, grandTotal };
}

function buildPdfTableRows(invoice) {
  return (invoice.items || []).map((item, index) => {
    const med = getMedicine(item);

    return [
      String(index + 1),
      item.medicineName || med?.name || "",
      med?.packagingType || "",
      getLineItemHsn(item),
      med?.manufacturer || "",
      item.batchNumber || med?.batchNumber || "",
      item.expiryDate ? formatExpiryShort(item.expiryDate) : (med?.expiryDate ? formatExpiryShort(med.expiryDate) : ""),
      formatAmount(item.mrp ?? med?.mrp ?? item.rate),
      formatLineItemQuantity(item.quantity, item.free),
      formatAmount(item.rate),
      `${Number(item.discount || 0).toFixed(2)}%`,
      `${getLineItemGstRate(item) / 2}%`,
      `${getLineItemGstRate(item) / 2}%`,
      formatAmount(getLineTotalWithGst(item)),
    ];
  });
}

function drawPdfLabelValue(doc, label, value, x, y, labelWidth = 24) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text(label, x, y);
  doc.setFont("helvetica", "normal");
  doc.text(String(value || ""), x + labelWidth, y, { maxWidth: 120 });
}

function getScaledColumnStyles(contentWidth) {
  const pdfColumnWidths = [9, 22, 13, 10, 13, 13, 10, 11, 10, 11, 10, 8, 8, 16];
  const widthScale = contentWidth / pdfColumnWidths.reduce((sum, width) => sum + width, 0);

  return pdfColumnWidths.reduce((styles, width, index) => {
    styles[index] = { cellWidth: width * widthScale, halign: "center" };
    return styles;
  }, {});
}

function buildPaddedTableRows(invoice, tax) {
  const tableRows = buildPdfTableRows(invoice);
  const minRows = Math.max(tableRows.length, 2);
  const paddedRows = [
    ...tableRows,
    ...Array.from({ length: minRows - tableRows.length }, () => Array(PDF_ITEM_HEADERS.length).fill("")),
  ];

  paddedRows.push([
    "", "TOTAL", "", "", "", "", "", "", "", "", "", "", "", formatAmount(tax.grandTotal)
  ]);

  return paddedRows;
}

function drawCutLine(doc, pageWidth, y, margin) {
  const centerX = pageWidth / 2;
  const gap = 6;

  doc.setDrawColor(110, 110, 110);
  doc.setLineWidth(0.25);
  doc.setLineDashPattern([1.5, 1.5], 0);
  doc.line(margin, y, centerX - gap, y);
  doc.line(centerX + gap, y, pageWidth - margin, y);
  doc.setLineDashPattern([], 0);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text("\u2702", centerX, y + 1, { align: "center" });
}

function drawInvoiceCopy(doc, invoice, options) {
  const { startY, margin, contentWidth, pageWidth, copyLabel, maxEndY, qrDataUrl } = options;
  const customer = invoice.customer || {};
  const isPurchase = invoice.invoiceType === "purchase";
  const receiver = isPurchase
    ? {
        name: invoice.supplier,
        address: invoice.supplierAddress || "",
        contact: invoice.supplierContact || "",
        dlNo: invoice.supplierDlNo || "",
        gstin: invoice.supplierGstin || "",
      }
    : customer;
  const tax = calculateTaxSummary(invoice.items || []);
  let y = startY;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  doc.text(copyLabel, pageWidth - margin, y + 2.5, { align: "right" });
  y += 5;

  const metaWidth = 48;
  const metaX = margin + contentWidth - metaWidth;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  doc.text(`GSTIN: ${SELLER.gstin}`, margin, y + 3);
  const dlLabel = "D.L NO: - ";
  doc.text(`${dlLabel}${SELLER.dlNumbers[0] || ""}`, margin, y + 7);
  if (SELLER.dlNumbers[1]) {
    doc.text(SELLER.dlNumbers[1], margin + doc.getTextWidth(dlLabel), y + 11);
  }

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.text("Invoice No.", metaX, y + 2);
  doc.setFont("helvetica", "bold");
  doc.text(String(invoice.invoiceNumber || ""), metaX + 18, y + 2);
  doc.setFont("helvetica", "normal");
  doc.text("Date", metaX, y + 6);
  doc.setFont("helvetica", "bold");
  doc.text(formatShortInvoiceDate(invoice.invoiceDate), metaX + 18, y + 6);
  doc.setFont("helvetica", "normal");
  doc.text("Type", metaX, y + 10);
  doc.setFont("helvetica", "bold");
  doc.text(invoice.paymentType === "cash" ? "CASH" : "CREDIT", metaX + 18, y + 10);

  y += SELLER.dlNumbers[1] ? 22 : 18;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(SELLER.name, pageWidth / 2, y, { align: "center" });

  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(`${SELLER.addressLine} Phone No.: ${SELLER.phoneDisplay}`, pageWidth / 2, y, { align: "center" });

  y += 5;
  const receiverHeaderHeight = 5;
  const rowGap = 4.5;
  const labelWidth = 24;
  const valueX = margin + 26;
  const valueMaxWidth = contentWidth - 30;
  const receiverTop = y;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  const addressLines = doc.splitTextToSize(displayOrDash(receiver.address), valueMaxWidth);
  const addressBlockHeight = Math.max(addressLines.length * 3.2, 3.2);
  const receiverContentHeight = rowGap + addressBlockHeight + rowGap * 3 + 2;
  const receiverHeight = receiverHeaderHeight + receiverContentHeight;

  doc.rect(margin, receiverTop, contentWidth, receiverHeight);
  doc.setFillColor(220, 220, 220);
  doc.rect(margin, receiverTop, contentWidth, receiverHeaderHeight, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  doc.text(
    isPurchase ? "DETAILS OF SUPPLIER" : "DETAILS OF RECEIVER / BILLED TO",
    pageWidth / 2,
    receiverTop + 3.5,
    { align: "center" }
  );

  let textY = receiverTop + receiverHeaderHeight + 3.5;
  drawPdfLabelValue(doc, "Name & Address:", displayOrDash(receiver.name), margin + 2, textY, labelWidth);
  textY += rowGap;
  addressLines.forEach((line, index) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.text(line, valueX, textY + index * 3.2);
  });
  textY += addressBlockHeight;

  drawPdfLabelValue(doc, "Phone No.:", displayOrDash(receiver.contact || receiver.phone), margin + 2, textY, labelWidth);
  textY += rowGap;
  drawPdfLabelValue(doc, "D.L. No.:", displayOrDash(receiver.dlNo), margin + 2, textY, labelWidth);
  textY += rowGap;
  drawPdfLabelValue(doc, "GSTIN:", displayOrDash(receiver.gstin), margin + 2, textY, labelWidth);

  y = receiverTop + receiverHeight;

  const paddedRows = buildPaddedTableRows(invoice, tax);
  const scaledColumnStyles = getScaledColumnStyles(contentWidth);

  autoTable(doc, {
    startY: y,
    head: [PDF_ITEM_HEADERS],
    body: paddedRows,
    tableWidth: contentWidth,
    theme: "grid",
    styles: {
      fontSize: 6.8,
      cellPadding: 0.9,
      lineColor: [0, 0, 0],
      lineWidth: 0.15,
      textColor: [0, 0, 0],
      valign: "middle",
    },
    headStyles: {
      fillColor: [235, 235, 235],
      textColor: [0, 0, 0],
      fontStyle: "bold",
      fontSize: 6.5,
      halign: "center",
    },
    columnStyles: scaledColumnStyles,
    margin: { left: margin, right: margin, top: 0, bottom: 0 },
    pageBreak: "avoid",
    rowPageBreak: "avoid",
    didParseCell(data) {
      if (data.section === "body" && data.row.index === paddedRows.length - 1 && data.column.index === 1) {
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.halign = "center";
      }
      if (data.section === "body" && data.row.index === paddedRows.length - 1 && data.column.index === 13) {
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  let blockY = doc.lastAutoTable.finalY;
  const qrSize = 14;
  const bankTextHeight = 12;
  const qrBlockHeight = qrSize + 3;
  const bankSectionHeight = isPurchase ? 0 : Math.max(bankTextHeight, qrDataUrl ? qrBlockHeight : 0);
  const wordsHeight = 7;
  const bankTopGap = isPurchase ? 0 : 2;
  const signatureTop = maxEndY - 9;

  if (blockY + wordsHeight <= signatureTop - bankSectionHeight - bankTopGap) {
    doc.rect(margin, blockY, contentWidth, wordsHeight);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.text("Amount in words:", margin + 2, blockY + 4.5);
    doc.setFont("helvetica", "normal");
    doc.text(amountInWords(tax.grandTotal), margin + 28, blockY + 4.5, { maxWidth: contentWidth - 52 });
    blockY += wordsHeight;
  }

  if (!isPurchase && blockY + bankTopGap + bankSectionHeight <= signatureTop) {
    blockY += bankTopGap;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.text("Bank Details:", margin + 2, blockY + 3);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.text(SELLER.bankName, margin + 2, blockY + 6.5);
    doc.text(`ACCOUNT : ${SELLER.account}`, margin + 2, blockY + 9.5);
    doc.text(`IFSC : ${SELLER.ifsc}`, margin + 2, blockY + 12.5, { maxWidth: contentWidth * 0.42 });

    if (qrDataUrl) {
      const qrX = (pageWidth - qrSize) / 2;
      const qrY = blockY + (bankSectionHeight - qrSize - 2) / 2;
      doc.addImage(qrDataUrl, "PNG", qrX, qrY, qrSize, qrSize);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6);
      doc.text("Scan to Pay", pageWidth / 2, qrY + qrSize + 2, { align: "center" });
    }

    blockY += bankSectionHeight;
  }

  if (!isPurchase) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.5);
    doc.text("Terms & Conditions", margin + 2, signatureTop + 2);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6);
    TERMS.forEach((term, index) => {
      doc.text(term, margin + 2, signatureTop + 5 + index * 3.2, { maxWidth: contentWidth * 0.52 });
    });
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  doc.text(SELLER.forLabel, pageWidth - margin, signatureTop + 2, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.text("Authorised Signatory", pageWidth - margin, signatureTop + 6, { align: "right" });

  return Math.max(blockY, signatureTop + 8);
}

// Mirrors abros-web-frontend/src/utils/upiPayment.js so both QR codes encode the
// same payment request.
async function generateUpiQrDataUrl(amount, note) {
  const params = new URLSearchParams();
  params.set("pa", UPI_ID());
  params.set("pn", UPI_PAYEE_NAME());
  params.set("cu", "INR");
  if (amount != null && Number(amount) > 0) {
    params.set("am", Number(amount).toFixed(2));
  }
  if (note) {
    params.set("tn", String(note).slice(0, 80));
  }
  return QRCode.toDataURL(`upi://pay?${params.toString()}`, {
    width: 240,
    margin: 1,
    errorCorrectionLevel: "M",
  });
}

async function buildFullInvoicePdfBuffer(invoiceInput) {
  // Plain data, so line items and the populated customer/medicine read the same
  // whether this was handed a Mongoose document or a lean object.
  const invoice =
    typeof invoiceInput?.toObject === "function"
      ? invoiceInput.toObject()
      : invoiceInput;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 6;
  const contentWidth = pageWidth - margin * 2;
  const cutY = pageHeight / 2;
  const copyGap = 2;
  const tax = calculateTaxSummary(invoice.items || []);
  const isPurchase = invoice.invoiceType === "purchase";
  let qrDataUrl = null;

  if (!isPurchase && invoice.status !== "cancelled") {
    try {
      qrDataUrl = await generateUpiQrDataUrl(tax.grandTotal, `Invoice ${invoice.invoiceNumber}`);
    } catch (e) {
      // Skip QR if generation fails
    }
  }

  drawInvoiceCopy(doc, invoice, {
    startY: margin,
    margin,
    contentWidth,
    pageWidth,
    copyLabel: "CUSTOMER COPY",
    maxEndY: cutY - copyGap,
    qrDataUrl,
  });

  drawCutLine(doc, pageWidth, cutY, margin);

  drawInvoiceCopy(doc, invoice, {
    startY: cutY + copyGap,
    margin,
    contentWidth,
    pageWidth,
    copyLabel: "OFFICE COPY",
    maxEndY: pageHeight - margin,
    qrDataUrl,
  });

  const arrayBuffer = doc.output("arraybuffer");
  return Buffer.from(arrayBuffer);
}

module.exports = { buildInvoicePdf: buildFullInvoicePdfBuffer };
