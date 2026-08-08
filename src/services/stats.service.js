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

const getProductWiseMonthlySalesData = async ({ year, search } = {}) => {
  const selectedYear = year ? parseInt(year, 10) : new Date().getFullYear();

  const matchStage = {
    invoiceType: { $ne: "purchase" },
    status: { $ne: "cancelled" },
  };

  if (selectedYear) {
    const startDate = new Date(Date.UTC(selectedYear, 0, 1, 0, 0, 0));
    const endDate = new Date(Date.UTC(selectedYear, 11, 31, 23, 59, 59, 999));
    matchStage.invoiceDate = { $gte: startDate, $lte: endDate };
  }

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

  const yearResults = await Invoice.aggregate([
    { $match: { invoiceType: { $ne: "purchase" }, status: { $ne: "cancelled" } } },
    { $group: { _id: { $year: "$invoiceDate" } } },
    { $sort: { "_id": -1 } },
  ]);

  const availableYears = yearResults.map((r) => r._id).filter(Boolean);
  if (!availableYears.includes(selectedYear)) {
    availableYears.push(selectedYear);
    availableYears.sort((a, b) => b - a);
  }

  const productMap = new Map();
  let grandTotalRevenue = 0;
  let grandTotalQuantity = 0;
  const monthlyGrandTotals = Array(12)
    .fill(0)
    .map(() => ({ quantity: 0, revenue: 0 }));

  aggregateResults.forEach((row) => {
    const productName = row._id.medicineName || "Unknown Product";
    const monthIdx = row._id.month - 1;

    if (!productMap.has(productName)) {
      productMap.set(productName, {
        medicineName: productName,
        totalQuantity: 0,
        totalFree: 0,
        totalRevenue: 0,
        monthlyData: Array(12)
          .fill(0)
          .map(() => ({ quantity: 0, free: 0, revenue: 0, orderCount: 0 })),
      });
    }

    const prod = productMap.get(productName);
    if (monthIdx >= 0 && monthIdx < 12) {
      const revenueVal = Math.round(row.totalRevenue * 100) / 100;
      prod.monthlyData[monthIdx] = {
        quantity: row.totalQuantity,
        free: row.totalFree,
        revenue: revenueVal,
        orderCount: row.invoiceIds.length,
      };

      prod.totalQuantity += row.totalQuantity;
      prod.totalFree += row.totalFree;
      prod.totalRevenue += row.totalRevenue;

      grandTotalQuantity += row.totalQuantity;
      grandTotalRevenue += row.totalRevenue;

      monthlyGrandTotals[monthIdx].quantity += row.totalQuantity;
      monthlyGrandTotals[monthIdx].revenue += revenueVal;
    }
  });

  const productsList = Array.from(productMap.values()).map((prod) => ({
    ...prod,
    totalRevenue: Math.round(prod.totalRevenue * 100) / 100,
  }));

  productsList.sort((a, b) => b.totalRevenue - a.totalRevenue);

  const topProduct = productsList.length > 0 ? productsList[0].medicineName : "N/A";

  let peakMonthIndex = 0;
  let peakMonthRevenue = 0;
  monthlyGrandTotals.forEach((m, idx) => {
    if (m.revenue > peakMonthRevenue) {
      peakMonthRevenue = m.revenue;
      peakMonthIndex = idx;
    }
  });

  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  const peakMonth =
    grandTotalRevenue > 0
      ? `${monthNames[peakMonthIndex]} (${selectedYear})`
      : "N/A";

  return {
    year: selectedYear,
    availableYears,
    summary: {
      grandTotalRevenue: Math.round(grandTotalRevenue * 100) / 100,
      grandTotalQuantity,
      topProduct,
      peakMonth,
      totalProductsCount: productsList.length,
    },
    monthlyGrandTotals: monthlyGrandTotals.map((m) => ({
      ...m,
      revenue: Math.round(m.revenue * 100) / 100,
    })),
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
