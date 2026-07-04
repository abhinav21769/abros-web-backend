const { calculateInvoiceTax } = require("./telegramInvoiceTax");

const escapePdfText = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");

const formatAmount = (value) => Number(value || 0).toFixed(2);

const formatDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
};

const textLine = (x, y, text, size = 10) =>
  `BT /F1 ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`;

function createPdfBuffer(lines) {
  const content = lines.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "utf8");
}

function buildInvoicePdf(invoice) {
  const tax = calculateInvoiceTax(invoice.items || []);
  const customer = invoice.customer || {};
  const lines = [];
  let y = 800;

  lines.push(textLine(40, y, "ABROS HEALTHCARE", 18));
  y -= 22;
  lines.push(textLine(40, y, "Invoice", 13));
  y -= 24;
  lines.push(textLine(40, y, `Invoice No: ${invoice.invoiceNumber}`));
  lines.push(textLine(330, y, `Date: ${formatDate(invoice.invoiceDate)}`));
  y -= 16;
  lines.push(textLine(40, y, `Customer: ${customer.name || "-"}`));
  y -= 16;
  lines.push(textLine(40, y, `Payment: ${invoice.paymentType || "cash"}`));
  y -= 28;

  lines.push(
    textLine(
      40,
      y,
      "Medicine                         Qty   Rate   Disc%  GST%   Amount",
      9,
    ),
  );
  y -= 14;
  lines.push(textLine(40, y, "---------------------------------------------------------------", 9));
  y -= 14;

  for (const item of invoice.items || []) {
    if (y < 90) break;
    const name = String(item.medicineName || item.medicine?.name || "").slice(
      0,
      28,
    );
    const row = `${name.padEnd(32)} ${String(item.quantity).padStart(3)} ${formatAmount(item.rate).padStart(7)} ${formatAmount(item.discount).padStart(6)} ${formatAmount(item.gstRate).padStart(5)} ${formatAmount(item.amount).padStart(8)}`;
    lines.push(textLine(40, y, row, 9));
    y -= 14;
  }

  y -= 10;
  lines.push(textLine(330, y, `Subtotal: Rs. ${formatAmount(tax.subtotal)}`));
  y -= 16;
  lines.push(textLine(330, y, `CGST: Rs. ${formatAmount(tax.cgst)}`));
  y -= 16;
  lines.push(textLine(330, y, `SGST: Rs. ${formatAmount(tax.sgst)}`));
  y -= 18;
  lines.push(
    textLine(330, y, `Grand Total: Rs. ${formatAmount(tax.grandTotal)}`, 12),
  );

  return createPdfBuffer(lines);
}

module.exports = { buildInvoicePdf };
