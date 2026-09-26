const Invoice = require("../models/invoice.model");
const { calculateInvoiceTaxBreakdown } = require("../utils/invoiceTax");
const {
  getQuarterDateRange,
  getMonthDateRange,
  getFullYearDateRange,
  getFinancialYearStart,
  getCurrentQuarter,
  QUARTER_LABELS,
  MONTH_NAMES,
} = require("../utils/quarterUtils");

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const emptyBucket = () => ({
  invoiceCount: 0,
  subtotal: 0,
  cgst: 0,
  sgst: 0,
  gst: 0,
  total: 0,
});

const addToBucket = (bucket, tax) => {
  bucket.invoiceCount += 1;
  bucket.subtotal = round2(bucket.subtotal + tax.subtotal);
  bucket.cgst = round2(bucket.cgst + tax.cgst);
  bucket.sgst = round2(bucket.sgst + tax.sgst);
  bucket.gst = round2(bucket.gst + tax.gst);
  bucket.total = round2(bucket.total + tax.total);
};

const formatBucket = (bucket) => ({
  invoiceCount: bucket.invoiceCount,
  subtotal: bucket.subtotal.toFixed(2),
  cgst: bucket.cgst.toFixed(2),
  sgst: bucket.sgst.toFixed(2),
  gst: bucket.gst.toFixed(2),
  total: bucket.total.toFixed(2),
});

const getGstQuarterlySummary = async ({
  financialYear,
  quarter,
  month,
  periodType,
}) => {
  let period;
  if (month != null && month !== "" && month !== "all") {
    period = getMonthDateRange(financialYear, month);
  } else if (quarter === "all" || month === "all" || periodType === "all") {
    period = getFullYearDateRange(financialYear);
  } else {
    period = getQuarterDateRange(financialYear, quarter || getCurrentQuarter());
  }

  const invoices = await Invoice.find({
    invoiceType: { $ne: "purchase" },
    status: { $ne: "cancelled" },
    invoiceDate: { $gte: period.from, $lte: period.to },
  })
    .populate("customer", "name gstin dlNo")
    .select(
      "invoiceNumber invoiceDate customer subtotal total status paymentType items",
    )
    .sort({ invoiceDate: -1 })
    .lean();

  const gstRegistered = emptyBucket();
  const nonGstRegistered = emptyBucket();
  const invoiceRows = [];

  for (const invoice of invoices) {
    const tax = calculateInvoiceTaxBreakdown(invoice.items || []);
    const isGstRegistered = Boolean(invoice.customer?.gstin);
    const bucket = isGstRegistered ? gstRegistered : nonGstRegistered;

    addToBucket(bucket, tax);

    invoiceRows.push({
      _id: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      status: invoice.status,
      paymentType: invoice.paymentType,
      customerName: invoice.customer?.name || "—",
      customerGstin: invoice.customer?.gstin || "",
      registrationType: isGstRegistered ? "gst" : "non-gst",
      subtotal: tax.subtotal.toFixed(2),
      cgst: tax.cgst.toFixed(2),
      sgst: tax.sgst.toFixed(2),
      gst: tax.gst.toFixed(2),
      total: tax.total.toFixed(2),
    });
  }

  const combined = emptyBucket();
  addToBucket(combined, gstRegistered);
  addToBucket(combined, nonGstRegistered);

  return {
    period: {
      financialYear: period.financialYear,
      quarter: period.quarter,
      month: period.month,
      label: period.label,
      fromDate: period.fromDate,
      toDate: period.toDate,
    },
    summary: {
      gstRegistered: formatBucket(gstRegistered),
      nonGstRegistered: formatBucket(nonGstRegistered),
      combined: formatBucket(combined),
    },
    invoices: invoiceRows,
  };
};

const getGstDefaults = () => {
  const financialYear = getFinancialYearStart();
  const quarter = getCurrentQuarter();

  return {
    financialYear,
    quarter,
    quarterLabels: QUARTER_LABELS,
    monthNames: MONTH_NAMES,
  };
};

module.exports = {
  getGstQuarterlySummary,
  getGstDefaults,
};
