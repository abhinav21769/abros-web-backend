const DEFAULT_GST_RATE = 5;

const normalizeGstRate = (value) => {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) return DEFAULT_GST_RATE;
  return rate;
};

const normalizeDiscount = (value) => {
  const discount = Number(value);
  if (!Number.isFinite(discount) || discount < 0) return 0;
  return Math.min(discount, 100);
};

const calculateItemAmount = (quantity, rate, discount = 0) => {
  const gross = Number(quantity) * Number(rate);
  const discountAmount = gross * (normalizeDiscount(discount) / 100);
  return Math.round((gross - discountAmount) * 100) / 100;
};

const buildInvoiceTotals = (items) => {
  const normalizedItems = items.map((item) => {
    const quantity = Number(item.quantity);
    const free = Number(item.free) || 0;
    const rate = Number(item.rate);
    const discount = normalizeDiscount(item.discount);
    const gstRate = normalizeGstRate(item.gstRate);
    const amount = calculateItemAmount(quantity, rate, discount);

    return {
      ...item,
      quantity,
      free,
      rate,
      discount,
      gstRate,
      amount,
    };
  });

  const subtotal = normalizedItems.reduce((sum, item) => sum + item.amount, 0);
  let cgst = 0;
  let sgst = 0;

  normalizedItems.forEach((item) => {
    const halfRate = item.gstRate / 200;
    cgst += Math.round(item.amount * halfRate * 100) / 100;
    sgst += Math.round(item.amount * halfRate * 100) / 100;
  });

  cgst = Math.round(cgst * 100) / 100;
  sgst = Math.round(sgst * 100) / 100;

  const exactTotal = subtotal + cgst + sgst;
  const total = Math.round(exactTotal);

  return {
    items: normalizedItems,
    subtotal: Math.round(subtotal * 100) / 100,
    total,
  };
};

module.exports = {
  DEFAULT_GST_RATE,
  normalizeGstRate,
  normalizeDiscount,
  buildInvoiceTotals,
};
