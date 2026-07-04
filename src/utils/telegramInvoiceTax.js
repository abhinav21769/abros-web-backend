function calculateInvoiceTax(items = []) {
  const lineItems = items.map((item) => {
    const amount = Number(item.amount) || 0;
    const gstRate = Number(item.gstRate) || 5;
    const halfRate = gstRate / 200;
    const cgst = Math.round(amount * halfRate * 100) / 100;
    const sgst = Math.round(amount * halfRate * 100) / 100;
    return { amount, cgst, sgst };
  });

  const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const cgst =
    Math.round(lineItems.reduce((sum, item) => sum + item.cgst, 0) * 100) / 100;
  const sgst =
    Math.round(lineItems.reduce((sum, item) => sum + item.sgst, 0) * 100) / 100;
  const exactTotal = subtotal + cgst + sgst;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    cgst,
    sgst,
    grandTotal: Math.round(exactTotal),
  };
}

module.exports = { calculateInvoiceTax };
