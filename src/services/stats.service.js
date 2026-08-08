const Medicine = require("../models/medicine.model");
const Customer = require("../models/customer.model");
const Invoice = require("../models/invoice.model");

const facetCount = (arr) => arr[0]?.count ?? 0;
const facetSum = (arr) => arr[0]?.total ?? 0;

const getInventoryStatsData = async (days = 30) => {
  const today = new Date();
  const futureDate = new Date();
  futureDate.setDate(today.getDate() + days);

  const [facetResult, expiredMedicines, expiringMedicines] = await Promise.all([
    Medicine.aggregate([
      {
        $facet: {
          totalStock: [{ $count: "count" }],
          expiredStock: [
            { $match: { expiryDate: { $lt: today } } },
            { $count: "count" },
          ],
          expiringStock: [
            {
              $match: {
                expiryDate: { $gte: today, $lte: futureDate },
              },
            },
            { $count: "count" },
          ],
          activeStock: [
            { $match: { expiryDate: { $gte: today } } },
            { $count: "count" },
          ],
          lowStockCount: [
            { $match: { quantity: { $lt: 10 } } },
            { $count: "count" },
          ],
          totalQuantity: [
            { $group: { _id: null, total: { $sum: "$quantity" } } },
          ],
          totalInventoryValue: [
            {
              $group: {
                _id: null,
                total: { $sum: { $multiply: ["$rate", "$quantity"] } },
              },
            },
          ],
        },
      },
    ]),
    Medicine.find({ expiryDate: { $lt: today } })
      .select("name expiryDate quantity mrp manufacturer")
      .sort({ expiryDate: -1 })
      .limit(10)
      .lean(),
    Medicine.find({
      expiryDate: { $gte: today, $lte: futureDate },
    })
      .select("name expiryDate quantity mrp manufacturer")
      .sort({ expiryDate: 1 })
      .limit(10)
      .lean(),
  ]);

  const facet = facetResult[0];
  const expiredStock = facetCount(facet.expiredStock);
  const expiringStock = facetCount(facet.expiringStock);

  return {
    stats: {
      totalStock: facetCount(facet.totalStock),
      activeStock: facetCount(facet.activeStock),
      expiredStock,
      expiringStock,
      expiringWithinDays: days,
      lowStockCount: facetCount(facet.lowStockCount),
      totalQuantity: facetSum(facet.totalQuantity),
      totalInventoryValue: facetSum(facet.totalInventoryValue).toFixed(2),
    },
    expiredMedicines: {
      count: expiredStock,
      list: expiredMedicines,
    },
    expiringMedicines: {
      count: expiringStock,
      withinDays: days,
      list: expiringMedicines,
    },
  };
};

const getCustomerStatsData = async () => {
  const totalCustomers = await Customer.countDocuments();
  return {
    stats: {
      totalCustomers,
    },
  };
};

const getInvoiceStatsData = async () => {
  const saleMatch = { invoiceType: { $ne: "purchase" } };
  const purchaseMatch = { invoiceType: "purchase" };

  const [salesFacet, purchasesFacet, recentSales, recentPurchases] =
    await Promise.all([
      Invoice.aggregate([
        { $match: saleMatch },
        {
          $facet: {
            totalInvoices: [{ $count: "count" }],
            pendingInvoices: [
              { $match: { status: "pending" } },
              { $count: "count" },
            ],
            paidInvoices: [{ $match: { status: "paid" } }, { $count: "count" }],
            cancelledInvoices: [
              { $match: { status: "cancelled" } },
              { $count: "count" },
            ],
            totalRevenue: [
              { $match: { status: "paid" } },
              { $group: { _id: null, total: { $sum: "$total" } } },
            ],
            pendingAmount: [
              { $match: { status: "pending" } },
              { $group: { _id: null, total: { $sum: "$total" } } },
            ],
          },
        },
      ]),
      Invoice.aggregate([
        { $match: purchaseMatch },
        {
          $facet: {
            totalInvoices: [{ $count: "count" }],
            pendingInvoices: [
              { $match: { status: "pending" } },
              { $count: "count" },
            ],
            paidInvoices: [{ $match: { status: "paid" } }, { $count: "count" }],
            totalAmount: [
              { $match: { status: { $ne: "cancelled" } } },
              { $group: { _id: null, total: { $sum: "$total" } } },
            ],
            pendingAmount: [
              { $match: { status: "pending" } },
              { $group: { _id: null, total: { $sum: "$total" } } },
            ],
          },
        },
      ]),
      Invoice.find(saleMatch)
        .populate("customer", "name")
        .select("invoiceNumber invoiceDate paidAt updatedAt total status customer")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      Invoice.find(purchaseMatch)
        .select(
          "invoiceNumber invoiceDate paidAt updatedAt total status supplier supplierContact",
        )
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
    ]);

  const sales = salesFacet[0];
  const purchases = purchasesFacet[0];

  return {
    sales: {
      stats: {
        totalInvoices: facetCount(sales.totalInvoices),
        pendingInvoices: facetCount(sales.pendingInvoices),
        paidInvoices: facetCount(sales.paidInvoices),
        cancelledInvoices: facetCount(sales.cancelledInvoices),
        totalRevenue: facetSum(sales.totalRevenue).toFixed(2),
        pendingAmount: facetSum(sales.pendingAmount).toFixed(2),
      },
      recent: recentSales,
    },
    purchases: {
      stats: {
        totalInvoices: facetCount(purchases.totalInvoices),
        pendingInvoices: facetCount(purchases.pendingInvoices),
        paidInvoices: facetCount(purchases.paidInvoices),
        totalAmount: facetSum(purchases.totalAmount).toFixed(2),
        pendingAmount: facetSum(purchases.pendingAmount).toFixed(2),
      },
      recent: recentPurchases,
    },
  };
};

function getCurrentFinancialYear() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  return month >= 4 ? year : year - 1;
}

function getQuarterIndex(month) {
  if (month >= 4 && month <= 6) return 0; // Q1 (Apr - Jun)
  if (month >= 7 && month <= 9) return 1; // Q2 (Jul - Sep)
  if (month >= 10 && month <= 12) return 2; // Q3 (Oct - Dec)
  return 3; // Q4 (Jan - Mar)
}

const getProductWiseMonthlySalesData = async ({ year, financialYear, search } = {}) => {
  const currentFY = getCurrentFinancialYear();
  const selectedFY = financialYear
    ? parseInt(financialYear, 10)
    : year
    ? parseInt(year, 10)
    : currentFY;

  const startDate = new Date(Date.UTC(selectedFY, 3, 1, 0, 0, 0));
  const endDate = new Date(Date.UTC(selectedFY + 1, 2, 31, 23, 59, 59, 999));

  const matchStage = {
    invoiceType: { $ne: "purchase" },
    status: { $in: ["paid", "pending"] },
    invoiceDate: { $gte: startDate, $lte: endDate },
  };

  const pipeline = [
    { $match: matchStage },
    { $unwind: "$items" },
  ];

  if (search && search.trim()) {
    pipeline.push({
      $match: {
        "items.medicineName": { $regex: search.trim(), $options: "i" },
      },
    });
  }

  pipeline.push({
    $group: {
      _id: {
        medicineName: "$items.medicineName",
        month: { $month: "$invoiceDate" },
      },
      totalQuantity: { $sum: "$items.quantity" },
      totalFree: { $sum: "$items.free" },
      totalRevenue: { $sum: "$items.amount" },
      invoiceIds: { $addToSet: "$_id" },
    },
  });

  const aggregateResults = await Invoice.aggregate(pipeline);

  const fyResults = await Invoice.aggregate([
    { $match: { invoiceType: { $ne: "purchase" }, status: { $in: ["paid", "pending"] } } },
    {
      $project: {
        financialYear: {
          $cond: {
            if: { $gte: [{ $month: "$invoiceDate" }, 4] },
            then: { $year: "$invoiceDate" },
            else: { $subtract: [{ $year: "$invoiceDate" }, 1] },
          },
        },
      },
    },
    { $group: { _id: "$financialYear" } },
    { $sort: { _id: -1 } },
  ]);

  let availableFYs = fyResults.map((r) => r._id).filter(Boolean);
  if (!availableFYs.includes(selectedFY)) {
    availableFYs.push(selectedFY);
  }
  if (!availableFYs.includes(currentFY)) {
    availableFYs.push(currentFY);
  }
  availableFYs.sort((a, b) => b - a);

  const availableFinancialYears = availableFYs.map((fy) => ({
    value: fy,
    label: `FY ${fy}-${String(fy + 1).slice(-2)}`,
  }));

  const productMap = new Map();
  let grandTotalRevenue = 0;
  let grandTotalQuantity = 0;
  const quarterlyGrandTotals = Array(4)
    .fill(0)
    .map(() => ({ quantity: 0, revenue: 0 }));

  const QUARTER_LABELS = [
    "Q1 (Apr – Jun)",
    "Q2 (Jul – Sep)",
    "Q3 (Oct – Dec)",
    "Q4 (Jan – Mar)",
  ];

  aggregateResults.forEach((row) => {
    const productName = row._id.medicineName || "Unknown Product";
    const month = row._id.month;
    const qIdx = getQuarterIndex(month);

    if (!productMap.has(productName)) {
      productMap.set(productName, {
        medicineName: productName,
        totalQuantity: 0,
        totalFree: 0,
        totalRevenue: 0,
        quarterlyData: Array(4)
          .fill(0)
          .map(() => ({ quantity: 0, free: 0, revenue: 0, orderCount: 0 })),
      });
    }

    const prod = productMap.get(productName);
    const revenueVal = Math.round(row.totalRevenue * 100) / 100;

    prod.quarterlyData[qIdx].quantity += row.totalQuantity;
    prod.quarterlyData[qIdx].free += row.totalFree;
    prod.quarterlyData[qIdx].revenue = Math.round((prod.quarterlyData[qIdx].revenue + revenueVal) * 100) / 100;
    prod.quarterlyData[qIdx].orderCount += row.invoiceIds.length;

    prod.totalQuantity += row.totalQuantity;
    prod.totalFree += row.totalFree;
    prod.totalRevenue += row.totalRevenue;

    grandTotalQuantity += row.totalQuantity;
    grandTotalRevenue += row.totalRevenue;

    quarterlyGrandTotals[qIdx].quantity += row.totalQuantity;
    quarterlyGrandTotals[qIdx].revenue = Math.round((quarterlyGrandTotals[qIdx].revenue + revenueVal) * 100) / 100;
  });

  const productsList = Array.from(productMap.values()).map((prod) => ({
    ...prod,
    totalRevenue: Math.round(prod.totalRevenue * 100) / 100,
  }));

  productsList.sort((a, b) => b.totalRevenue - a.totalRevenue);

  const topProduct = productsList.length > 0 ? productsList[0].medicineName : "N/A";

  let peakQuarterIndex = 0;
  let peakQuarterRevenue = 0;
  quarterlyGrandTotals.forEach((q, idx) => {
    if (q.revenue > peakQuarterRevenue) {
      peakQuarterRevenue = q.revenue;
      peakQuarterIndex = idx;
    }
  });

  const peakQuarter =
    grandTotalRevenue > 0
      ? `${QUARTER_LABELS[peakQuarterIndex]}`
      : "N/A";

  const selectedFYLabel = `FY ${selectedFY}-${String(selectedFY + 1).slice(-2)}`;

  return {
    financialYear: selectedFY,
    financialYearLabel: selectedFYLabel,
    availableFinancialYears,
    availableYears: availableFYs,
    summary: {
      grandTotalRevenue: Math.round(grandTotalRevenue * 100) / 100,
      grandTotalQuantity,
      topProduct,
      peakQuarter,
      peakMonth: peakQuarter,
      totalProductsCount: productsList.length,
    },
    quarterlyGrandTotals,
    monthlyGrandTotals: quarterlyGrandTotals,
    products: productsList,
  };
};

const getDashboardStatsData = async (days = 30) => {
  const [inventory, customers, invoices] = await Promise.all([
    getInventoryStatsData(days),
    getCustomerStatsData(),
    getInvoiceStatsData(),
  ]);

  return { inventory, customers, invoices };
};

module.exports = {
  getInventoryStatsData,
  getCustomerStatsData,
  getInvoiceStatsData,
  getDashboardStatsData,
  getProductWiseMonthlySalesData,
};
