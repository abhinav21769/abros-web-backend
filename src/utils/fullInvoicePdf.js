const { jsPDF } = require("jspdf");
const autoTableImport = require("jspdf-autotable");
const autoTable = autoTableImport.default || autoTableImport;
const QRCode = require("qrcode");

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
  vpa: "8295566445@paytm",
};

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
  return Number(item.gstRate ?? med?.gstRate ?? 5);
}

function getLineTotalWithGst(item) {
  if (item.amount != null && !Number.isNaN(Number(item.amount))) {
    return Number(item.amount);
  }
  const qty = Number(item.quantity) || 0;
  const rate = Number(item.rate) || 0;
  const disc = Number(item.discount) || 0;
  const sub = qty * rate * (1 - disc / 100);
  const gstRate = getLineItemGstRate(item);
  return sub * (1 + gstRate / 100);
}

function formatLineItemQuantity(quantity, free, calcNetRate = true) {
  const qty = Number(quantity) || 0;
  const freeQty = Number(free) || 0;
  if (calcNetRate) {
    return String(qty + freeQty);
  }
  return freeQty > 0 ? `${qty}+${freeQty}` : String(qty);
}

function formatShortInvoiceDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  return `${day}-${month}-${year}`;
}

function formatExpiryShort(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  return `${month}-${year}`;
}

const { calculateItemNetRate } = require("./invoiceTax");

function getPdfItemHeaders(calcNetRate = true) {
  return [
    "S. No.", "Prodcut Name", "Packing", "HSN", "MFG", "BATCH", "EXP.",
    "MRP", "QTY.", calcNetRate ? "NET RATE" : "RATE", "DISC.", "CGST", "SGST", "Amount"
  ];
}

function calculateTaxSummary(items = []) {
  let subtotal = 0;
  let cgst = 0;
  let sgst = 0;

  items.forEach((item) => {
    const qty = Number(item.quantity) || 0;
    const rate = Number(item.rate) || 0;
    const disc = Number(item.discount) || 0;
    const base = qty * rate * (1 - disc / 100);
    const gstRate = getLineItemGstRate(item);
    const taxAmt = base * (gstRate / 100);
    subtotal += base;
    cgst += taxAmt / 2;
    sgst += taxAmt / 2;
  });

  const grandTotal = Math.round(subtotal + cgst + sgst);
  return { subtotal, cgst, sgst, grandTotal };
}

function buildPdfTableRows(invoice) {
  const calcNetRate = invoice?.calcNetRate !== false;
  return (invoice.items || []).map((item, index) => {
    const med = getMedicine(item);
    const netRate = calculateItemNetRate(item.quantity, item.free, item.rate, item.discount);
    const displayRate = calcNetRate ? (netRate > 0 ? netRate : item.rate) : item.rate;

    return [
      String(index + 1),
      item.medicineName || med?.name || "",
      med?.packagingType || "",
      getLineItemHsn(item),
      med?.manufacturer || "",
      item.batchNumber || med?.batchNumber || "",
      item.expiryDate ? formatExpiryShort(item.expiryDate) : (med?.expiryDate ? formatExpiryShort(med.expiryDate) : ""),
      formatAmount(item.mrp ?? med?.mrp ?? item.rate),
      formatLineItemQuantity(item.quantity, item.free, calcNetRate),
      formatAmount(displayRate),
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
  const pdfColumnWidths = [9, 20, 12, 10, 12, 12, 10, 11, 10, 11, 11, 10, 8, 8, 16];
  const widthScale = contentWidth / pdfColumnWidths.reduce((sum, width) => sum + width, 0);

  return pdfColumnWidths.reduce((styles, width, index) => {
    styles[index] = { cellWidth: width * widthScale, halign: "center" };
    return styles;
  }, {});
}

function buildPaddedTableRows(invoice, tax) {
  const calcNetRate = invoice?.calcNetRate !== false;
  const itemHeaders = getPdfItemHeaders(calcNetRate);
  const tableRows = buildPdfTableRows(invoice);
  const minRows = Math.max(tableRows.length, 2);
  const paddedRows = [
    ...tableRows,
    ...Array.from({ length: minRows - tableRows.length }, () => Array(itemHeaders.length).fill("")),
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

  const calcNetRate = invoice?.calcNetRate !== false;
  const itemHeaders = getPdfItemHeaders(calcNetRate);
  const paddedRows = buildPaddedTableRows(invoice, tax);
  const scaledColumnStyles = getScaledColumnStyles(contentWidth);

  autoTable(doc, {
    startY: y,
    head: [itemHeaders],
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

async function generateUpiQrDataUrl(amount, note) {
  const upiUrl = `upi://pay?pa=${encodeURIComponent(SELLER.vpa)}&pn=${encodeURIComponent(SELLER.name)}&am=${encodeURIComponent(amount)}&cu=INR&tn=${encodeURIComponent(note)}`;
  return QRCode.toDataURL(upiUrl, { width: 300, margin: 1 });
}

async function buildFullInvoicePdfBuffer(invoice) {
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
