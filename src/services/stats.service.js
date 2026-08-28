const Medicine = require("../models/medicine.model");
const Customer = require("../models/customer.model");
const Invoice = require("../models/invoice.model");
const { getFinancialYearStart } = require("../utils/quarterUtils");

const facetCount = (arr) => arr[0]?.count ?? 0;
const facetSum = (arr) => arr[0]?.total ?? 0;

const getInventoryStatsData = async (days = 30) => {
  const today = new Date();
  const futureDate = new Date();
  futureDate.setDate(today.getDate() + days);

  const medicines = await Medicine.find().lean();

  let totalProducts = medicines.length;
  let activeStockCount = 0;
  let expiredStockCount = 0;
  let expiringStockCount = 0;
  let lowStockCount = 0;
  let totalQuantity = 0;
  let totalInventoryValue = 0;

  const expiredList = [];
  const expiringList = [];

  medicines.forEach((med) => {
    const batches = med.batches && med.batches.length > 0
      ? med.batches
      : [
          {
            batchNumber: med.batchNumber || "BATCH-01",
            expiryDate: med.expiryDate || new Date(),
            mrp: med.mrp || med.rate || 0,
            rate: med.rate || med.mrp || 0,
            quantity: med.quantity || 0,
          },
        ];

    const medTotalQty = batches.reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);
    totalQuantity += medTotalQty;

    if (medTotalQty < 10) {
      lowStockCount += 1;
    }

    let medHasActive = false;

    batches.forEach((b) => {
      const qty = Number(b.quantity) || 0;
      const rate = Number(b.rate) || 0;
      totalInventoryValue += qty * rate;

      if (qty <= 0) return;

      const exp = new Date(b.expiryDate);
      if (exp < today) {
        expiredStockCount += 1;
        expiredList.push({
          _id: med._id,
          name: med.name,
          batchNumber: b.batchNumber,
          expiryDate: b.expiryDate,
          quantity: b.quantity,
          mrp: b.mrp,
          manufacturer: med.manufacturer,
        });
      } else {
        medHasActive = true;
        if (exp >= today && exp <= futureDate) {
          expiringStockCount += 1;
          expiringList.push({
            _id: med._id,
            name: med.name,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate,
            quantity: b.quantity,
            mrp: b.mrp,
            manufacturer: med.manufacturer,
          });
        }
      }
    });

    if (medHasActive) {
      activeStockCount += 1;
    }
  });

  expiredList.sort((a, b) => new Date(b.expiryDate) - new Date(a.expiryDate));
  expiringList.sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));

  return {
    stats: {
      totalStock: totalProducts,
      activeStock: activeStockCount,
      expiredStock: expiredStockCount,
      expiringStock: expiringStockCount,
      expiringWithinDays: days,
      lowStockCount,
      totalQuantity,
      totalInventoryValue: Math.round(totalInventoryValue * 100) / 100,
    },
    expiredMedicines: {
      count: expiredStockCount,
      list: expiredList.slice(0, 10),
    },
    expiringMedicines: {
      count: expiringStockCount,
      withinDays: days,
      list: expiringList.slice(0, 10),
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
  // Aggregation pipelines bypass the schema's deleted-invoice filter, so the
  // condition is repeated in every $match that reads invoices.
  const saleMatch = { invoiceType: { $ne: "purchase" }, deletedAt: null };
  const purchaseMatch = { invoiceType: "purchase", deletedAt: null };

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

const QUARTER_LABELS = [
  "Q1 (Apr – Jun)",
  "Q2 (Jul – Sep)",
  "Q3 (Oct – Dec)",
  "Q4 (Jan – Mar)",
];

const MONTH_LABELS = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"
];

function getFYMonthIndex(month) {
  return month >= 4 ? month - 4 : month + 8;
}

function getCurrentFinancialYear() {
  return getFinancialYearStart();
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

  const startDate = new Date(`${selectedFY}-04-01T00:00:00+05:30`);
  const endDate = new Date(`${selectedFY + 1}-03-31T23:59:59.999+05:30`);

  const matchStage = {
    invoiceType: { $ne: "purchase" },
    status: { $in: ["paid", "pending"] },
    invoiceDate: { $gte: startDate, $lte: endDate },
    deletedAt: null,
  };

  const pipeline = [
    { $match: matchStage },
    { $unwind: "$items" },
    {
      $lookup: {
        from: "customers",
        localField: "customer",
        foreignField: "_id",
        as: "customerDoc",
      },
    },
    { $unwind: { path: "$customerDoc", preserveNullAndEmptyArrays: true } },
  ];

  if (search && search.trim()) {
    const sTerm = search.trim();
    pipeline.push({
      $match: {
        $or: [
          { "items.medicineName": { $regex: sTerm, $options: "i" } },
          { "customerDoc.name": { $regex: sTerm, $options: "i" } },
        ],
      },
    });
  }

  pipeline.push({
    $group: {
      _id: {
        medicineName: "$items.medicineName",
        month: { $month: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
      },
      totalQuantity: { $sum: "$items.quantity" },
      totalFree: { $sum: "$items.free" },
      totalRevenue: { $sum: "$items.amount" },
      customerNames: { $addToSet: { $ifNull: ["$customerDoc.name", "Walk-in Customer"] } },
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
            if: {
              $gte: [
                { $month: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
                4,
              ],
            },
            then: { $year: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
            else: {
              $subtract: [
                { $year: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
                1,
              ],
            },
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
  let grandTotalFree = 0;
  const quarterlyGrandTotals = Array(4)
    .fill(0)
    .map((_, i) => ({ label: QUARTER_LABELS[i], quantity: 0, free: 0, revenue: 0 }));
  const monthlyGrandTotals = Array(12)
    .fill(0)
    .map((_, i) => ({ monthName: MONTH_LABELS[i], monthNumber: i < 9 ? i + 4 : i - 8, quantity: 0, free: 0, revenue: 0 }));

  aggregateResults.forEach((row) => {
    const productName = row._id.medicineName || "Unknown Product";
    const month = row._id.month;
    const qIdx = getQuarterIndex(month);
    const mIdx = getFYMonthIndex(month);

    if (!productMap.has(productName)) {
      productMap.set(productName, {
        medicineName: productName,
        customerNames: [],
        totalQuantity: 0,
        totalFree: 0,
        totalRevenue: 0,
        quarterlyData: Array(4)
          .fill(0)
          .map((_, i) => ({ label: QUARTER_LABELS[i], quantity: 0, free: 0, revenue: 0, orderCount: 0 })),
        monthlyData: Array(12)
          .fill(0)
          .map((_, i) => ({ monthName: MONTH_LABELS[i], monthNumber: i < 9 ? i + 4 : i - 8, quantity: 0, free: 0, revenue: 0, orderCount: 0 })),
      });
    }

    const prod = productMap.get(productName);
    if (row.customerNames && Array.isArray(row.customerNames)) {
      row.customerNames.forEach((cName) => {
        if (cName && !prod.customerNames.includes(cName)) {
          prod.customerNames.push(cName);
        }
      });
    }
    const revenueVal = Math.round(row.totalRevenue * 100) / 100;

    prod.quarterlyData[qIdx].quantity += row.totalQuantity;
    prod.quarterlyData[qIdx].free += row.totalFree || 0;
    prod.quarterlyData[qIdx].revenue = Math.round((prod.quarterlyData[qIdx].revenue + revenueVal) * 100) / 100;
    prod.quarterlyData[qIdx].orderCount += row.invoiceIds.length;

    prod.monthlyData[mIdx].quantity += row.totalQuantity;
    prod.monthlyData[mIdx].free += row.totalFree || 0;
    prod.monthlyData[mIdx].revenue = Math.round((prod.monthlyData[mIdx].revenue + revenueVal) * 100) / 100;
    prod.monthlyData[mIdx].orderCount += row.invoiceIds.length;

    prod.totalQuantity += row.totalQuantity;
    prod.totalFree += row.totalFree || 0;
    prod.totalRevenue += row.totalRevenue;

    grandTotalQuantity += row.totalQuantity;
    grandTotalFree += row.totalFree || 0;
    grandTotalRevenue += row.totalRevenue;

    quarterlyGrandTotals[qIdx].quantity += row.totalQuantity;
    quarterlyGrandTotals[qIdx].free += row.totalFree || 0;
    quarterlyGrandTotals[qIdx].revenue = Math.round((quarterlyGrandTotals[qIdx].revenue + revenueVal) * 100) / 100;

    monthlyGrandTotals[mIdx].quantity += row.totalQuantity;
    monthlyGrandTotals[mIdx].free += row.totalFree || 0;
    monthlyGrandTotals[mIdx].revenue = Math.round((monthlyGrandTotals[mIdx].revenue + revenueVal) * 100) / 100;
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
      grandTotalFree,
      topProduct,
      peakQuarter,
      peakMonth: peakQuarter,
      totalProductsCount: productsList.length,
    },
    quarterlyGrandTotals,
    monthlyGrandTotals,
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

const getCustomerWiseSalesData = async ({ year, financialYear, search } = {}) => {
  const currentFY = getCurrentFinancialYear();
  const selectedFY = financialYear
    ? parseInt(financialYear, 10)
    : year
    ? parseInt(year, 10)
    : currentFY;

  const startDate = new Date(`${selectedFY}-04-01T00:00:00+05:30`);
  const endDate = new Date(`${selectedFY + 1}-03-31T23:59:59.999+05:30`);

  const matchStage = {
    invoiceType: { $ne: "purchase" },
    status: { $in: ["paid", "pending"] },
    invoiceDate: { $gte: startDate, $lte: endDate },
    deletedAt: null,
  };

  const pipeline = [
    { $match: matchStage },
    {
      $lookup: {
        from: "customers",
        localField: "customer",
        foreignField: "_id",
        as: "customerDoc",
      },
    },
    { $unwind: { path: "$customerDoc", preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: {
          customerId: "$customer",
          customerName: { $ifNull: ["$customerDoc.name", "Walk-in Customer"] },
          month: { $month: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
        },
        contact: { $first: "$customerDoc.contact" },
        address: { $first: "$customerDoc.address" },
        gstin: { $first: "$customerDoc.gstin" },
        totalRevenue: { $sum: "$total" },
        paidRevenue: {
          $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$total", 0] },
        },
        pendingRevenue: {
          $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$total", 0] },
        },
        invoiceCount: { $sum: 1 },
        paidCount: {
          $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] },
        },
        pendingCount: {
          $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
        },
        invoiceIds: { $addToSet: "$_id" },
      },
    },
  ];

  const aggregateResults = await Invoice.aggregate(pipeline);

  const fyResults = await Invoice.aggregate([
    { $match: { invoiceType: { $ne: "purchase" }, status: { $in: ["paid", "pending"] } } },
    {
      $project: {
        financialYear: {
          $cond: {
            if: {
              $gte: [
                { $month: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
                4,
              ],
            },
            then: { $year: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
            else: {
              $subtract: [
                { $year: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
                1,
              ],
            },
          },
        },
      },
    },
    { $group: { _id: "$financialYear" } },
    { $sort: { _id: -1 } },
  ]);

  let availableFYs = fyResults.map((r) => r._id).filter(Boolean);
  if (!availableFYs.includes(selectedFY)) availableFYs.push(selectedFY);
  if (!availableFYs.includes(currentFY)) availableFYs.push(currentFY);
  availableFYs.sort((a, b) => b - a);

  const availableFinancialYears = availableFYs.map((fy) => ({
    value: fy,
    label: `FY ${fy}-${String(fy + 1).slice(-2)}`,
  }));

  const customerMap = new Map();
  let grandTotalRevenue = 0;
  let grandTotalPaidRevenue = 0;
  let grandTotalPendingRevenue = 0;
  let grandTotalInvoices = 0;
  const quarterlyGrandTotals = Array(4)
    .fill(0)
    .map(() => ({ revenue: 0, paidRevenue: 0, pendingRevenue: 0, invoiceCount: 0 }));

  const QUARTER_LABELS = [
    "Q1 (Apr – Jun)",
    "Q2 (Jul – Sep)",
    "Q3 (Oct – Dec)",
    "Q4 (Jan – Mar)",
  ];

  aggregateResults.forEach((row) => {
    const custIdStr = row._id.customerId ? String(row._id.customerId) : "walk-in";
    const custName = row._id.customerName || "Walk-in Customer";
    const month = row._id.month;
    const qIdx = getQuarterIndex(month);

    const key = custIdStr !== "walk-in" ? custIdStr : `walk-in_${custName}`;

    if (!customerMap.has(key)) {
      customerMap.set(key, {
        customerId: row._id.customerId || null,
        customerName: custName,
        contact: row.contact || "",
        address: row.address || "",
        gstin: row.gstin || "",
        totalRevenue: 0,
        paidRevenue: 0,
        pendingRevenue: 0,
        totalInvoices: 0,
        paidInvoices: 0,
        pendingInvoices: 0,
        quarterlyData: Array(4)
          .fill(0)
          .map(() => ({ revenue: 0, paidRevenue: 0, pendingRevenue: 0, invoiceCount: 0 })),
      });
    }

    const cust = customerMap.get(key);
    const revVal = Math.round(row.totalRevenue * 100) / 100;
    const paidRevVal = Math.round(row.paidRevenue * 100) / 100;
    const pendingRevVal = Math.round(row.pendingRevenue * 100) / 100;

    cust.quarterlyData[qIdx].revenue = Math.round((cust.quarterlyData[qIdx].revenue + revVal) * 100) / 100;
    cust.quarterlyData[qIdx].paidRevenue = Math.round((cust.quarterlyData[qIdx].paidRevenue + paidRevVal) * 100) / 100;
    cust.quarterlyData[qIdx].pendingRevenue = Math.round((cust.quarterlyData[qIdx].pendingRevenue + pendingRevVal) * 100) / 100;
    cust.quarterlyData[qIdx].invoiceCount += row.invoiceCount;

    cust.totalRevenue += row.totalRevenue;
    cust.paidRevenue += row.paidRevenue;
    cust.pendingRevenue += row.pendingRevenue;
    cust.totalInvoices += row.invoiceCount;
    cust.paidInvoices += row.paidCount;
    cust.pendingInvoices += row.pendingCount;

    grandTotalRevenue += row.totalRevenue;
    grandTotalPaidRevenue += row.paidRevenue;
    grandTotalPendingRevenue += row.pendingRevenue;
    grandTotalInvoices += row.invoiceCount;

    quarterlyGrandTotals[qIdx].revenue = Math.round((quarterlyGrandTotals[qIdx].revenue + revVal) * 100) / 100;
    quarterlyGrandTotals[qIdx].paidRevenue = Math.round((quarterlyGrandTotals[qIdx].paidRevenue + paidRevVal) * 100) / 100;
    quarterlyGrandTotals[qIdx].pendingRevenue = Math.round((quarterlyGrandTotals[qIdx].pendingRevenue + pendingRevVal) * 100) / 100;
    quarterlyGrandTotals[qIdx].invoiceCount += row.invoiceCount;
  });

  let customersList = Array.from(customerMap.values()).map((c) => ({
    ...c,
    totalRevenue: Math.round(c.totalRevenue * 100) / 100,
    paidRevenue: Math.round(c.paidRevenue * 100) / 100,
    pendingRevenue: Math.round(c.pendingRevenue * 100) / 100,
  }));

  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    customersList = customersList.filter(
      (c) =>
        c.customerName.toLowerCase().includes(q) ||
        (c.contact && c.contact.toLowerCase().includes(q)) ||
        (c.gstin && c.gstin.toLowerCase().includes(q)) ||
        (c.address && c.address.toLowerCase().includes(q))
    );
  }

  customersList.sort((a, b) => b.totalRevenue - a.totalRevenue);

  const topCustomer = customersList.length > 0 ? customersList[0].customerName : "N/A";
  const topCustomerAmount = customersList.length > 0 ? customersList[0].totalRevenue : 0;

  let peakQuarterIndex = 0;
  let peakQuarterRevenue = 0;
  quarterlyGrandTotals.forEach((q, idx) => {
    if (q.revenue > peakQuarterRevenue) {
      peakQuarterRevenue = q.revenue;
      peakQuarterIndex = idx;
    }
  });

  const peakQuarter = grandTotalRevenue > 0 ? `${QUARTER_LABELS[peakQuarterIndex]}` : "N/A";
  const selectedFYLabel = `FY ${selectedFY}-${String(selectedFY + 1).slice(-2)}`;

  return {
    financialYear: selectedFY,
    financialYearLabel: selectedFYLabel,
    availableFinancialYears,
    availableYears: availableFYs,
    summary: {
      grandTotalRevenue: Math.round(grandTotalRevenue * 100) / 100,
      grandTotalPaidRevenue: Math.round(grandTotalPaidRevenue * 100) / 100,
      grandTotalPendingRevenue: Math.round(grandTotalPendingRevenue * 100) / 100,
      grandTotalInvoices,
      topCustomer,
      topCustomerAmount,
      peakQuarter,
      activeCustomersCount: customersList.length,
    },
    quarterlyGrandTotals,
    customers: customersList,
  };
};

const getCustomerProductMonthlySalesData = async ({ year, financialYear, customerId, search } = {}) => {
  const currentFY = getCurrentFinancialYear();
  const selectedFY = financialYear
    ? parseInt(financialYear, 10)
    : year
    ? parseInt(year, 10)
    : currentFY;

  const startDate = new Date(`${selectedFY}-04-01T00:00:00+05:30`);
  const endDate = new Date(`${selectedFY + 1}-03-31T23:59:59.999+05:30`);

  const matchStage = {
    invoiceType: { $ne: "purchase" },
    status: { $in: ["paid", "pending"] },
    invoiceDate: { $gte: startDate, $lte: endDate },
    deletedAt: null,
  };

  if (customerId && customerId !== "all" && customerId !== "walk-in") {
    matchStage.customer = new (require("mongoose").Types.ObjectId)(customerId);
  }

  const pipeline = [
    { $match: matchStage },
    { $unwind: "$items" },
    {
      $lookup: {
        from: "customers",
        localField: "customer",
        foreignField: "_id",
        as: "customerDoc",
      },
    },
    { $unwind: { path: "$customerDoc", preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: {
          customerId: "$customer",
          customerName: { $ifNull: ["$customerDoc.name", "Walk-in Customer"] },
          medicineName: "$items.medicineName",
          month: { $month: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
        },
        contact: { $first: "$customerDoc.contact" },
        address: { $first: "$customerDoc.address" },
        gstin: { $first: "$customerDoc.gstin" },
        totalQuantity: { $sum: "$items.quantity" },
        totalFree: { $sum: "$items.free" },
        totalRevenue: { $sum: "$items.amount" },
        invoiceIds: { $addToSet: "$_id" },
      },
    },
  ];

  const aggregateResults = await Invoice.aggregate(pipeline);

  const fyResults = await Invoice.aggregate([
    { $match: { invoiceType: { $ne: "purchase" }, status: { $in: ["paid", "pending"] } } },
    {
      $project: {
        financialYear: {
          $cond: {
            if: {
              $gte: [
                { $month: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
                4,
              ],
            },
            then: { $year: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
            else: {
              $subtract: [
                { $year: { date: "$invoiceDate", timezone: "Asia/Kolkata" } },
                1,
              ],
            },
          },
        },
      },
    },
    { $group: { _id: "$financialYear" } },
    { $sort: { _id: -1 } },
  ]);

  let availableFYs = fyResults.map((r) => r._id).filter(Boolean);
  if (!availableFYs.includes(selectedFY)) availableFYs.push(selectedFY);
  if (!availableFYs.includes(currentFY)) availableFYs.push(currentFY);
  availableFYs.sort((a, b) => b - a);

  const availableFinancialYears = availableFYs.map((fy) => ({
    value: fy,
    label: `FY ${fy}-${String(fy + 1).slice(-2)}`,
  }));

  const customerMap = new Map();
  let grandTotalRevenue = 0;
  let grandTotalQuantity = 0;
  let grandTotalFree = 0;
  let topPair = { name: "N/A", revenue: 0 };

  const monthlyGrandTotals = Array(12)
    .fill(0)
    .map((_, i) => ({ monthName: MONTH_LABELS[i], quantity: 0, free: 0, revenue: 0 }));

  const quarterlyGrandTotals = Array(4)
    .fill(0)
    .map((_, i) => ({ label: `Q${i + 1}`, quantity: 0, free: 0, revenue: 0 }));

  aggregateResults.forEach((row) => {
    const custIdStr = row._id.customerId ? String(row._id.customerId) : "walk-in";
    const custName = row._id.customerName || "Walk-in Customer";
    const prodName = row._id.medicineName || "Unknown Product";
    const month = row._id.month;
    const fyMonthIdx = getFYMonthIndex(month);
    const qIdx = getQuarterIndex(month);

    const custKey = custIdStr !== "walk-in" ? custIdStr : `walk-in_${custName}`;

    if (!customerMap.has(custKey)) {
      customerMap.set(custKey, {
        customerId: row._id.customerId || null,
        customerName: custName,
        contact: row.contact || "",
        address: row.address || "",
        gstin: row.gstin || "",
        totalRevenue: 0,
        totalQuantity: 0,
        totalFree: 0,
        monthlyTotals: Array(12)
          .fill(0)
          .map((_, i) => ({ monthName: MONTH_LABELS[i], quantity: 0, free: 0, revenue: 0 })),
        quarterlyTotals: Array(4)
          .fill(0)
          .map((_, i) => ({ label: `Q${i + 1}`, quantity: 0, free: 0, revenue: 0 })),
        productsMap: new Map(),
      });
    }

    const custObj = customerMap.get(custKey);
    const revVal = Math.round(row.totalRevenue * 100) / 100;
    const qtyVal = row.totalQuantity || 0;
    const freeVal = row.totalFree || 0;

    if (!custObj.productsMap.has(prodName)) {
      custObj.productsMap.set(prodName, {
        medicineName: prodName,
        totalRevenue: 0,
        totalQuantity: 0,
        totalFree: 0,
        monthlyData: Array(12)
          .fill(0)
          .map((_, i) => ({ monthName: MONTH_LABELS[i], quantity: 0, free: 0, revenue: 0 })),
        quarterlyData: Array(4)
          .fill(0)
          .map((_, i) => ({ label: `Q${i + 1}`, quantity: 0, free: 0, revenue: 0 })),
      });
    }

    const prodObj = custObj.productsMap.get(prodName);

    prodObj.monthlyData[fyMonthIdx].quantity += qtyVal;
    prodObj.monthlyData[fyMonthIdx].free += freeVal;
    prodObj.monthlyData[fyMonthIdx].revenue = Math.round((prodObj.monthlyData[fyMonthIdx].revenue + revVal) * 100) / 100;

    prodObj.quarterlyData[qIdx].quantity += qtyVal;
    prodObj.quarterlyData[qIdx].free += freeVal;
    prodObj.quarterlyData[qIdx].revenue = Math.round((prodObj.quarterlyData[qIdx].revenue + revVal) * 100) / 100;

    prodObj.totalQuantity += qtyVal;
    prodObj.totalFree += freeVal;
    prodObj.totalRevenue += revVal;

    custObj.monthlyTotals[fyMonthIdx].quantity += qtyVal;
    custObj.monthlyTotals[fyMonthIdx].free += freeVal;
    custObj.monthlyTotals[fyMonthIdx].revenue = Math.round((custObj.monthlyTotals[fyMonthIdx].revenue + revVal) * 100) / 100;

    custObj.quarterlyTotals[qIdx].quantity += qtyVal;
    custObj.quarterlyTotals[qIdx].free += freeVal;
    custObj.quarterlyTotals[qIdx].revenue = Math.round((custObj.quarterlyTotals[qIdx].revenue + revVal) * 100) / 100;

    custObj.totalQuantity += qtyVal;
    custObj.totalFree += freeVal;
    custObj.totalRevenue += revVal;

    grandTotalQuantity += qtyVal;
    grandTotalFree += freeVal;
    grandTotalRevenue += revVal;

    monthlyGrandTotals[fyMonthIdx].quantity += qtyVal;
    monthlyGrandTotals[fyMonthIdx].free += freeVal;
    monthlyGrandTotals[fyMonthIdx].revenue = Math.round((monthlyGrandTotals[fyMonthIdx].revenue + revVal) * 100) / 100;

    quarterlyGrandTotals[qIdx].quantity += qtyVal;
    quarterlyGrandTotals[qIdx].free += freeVal;
    quarterlyGrandTotals[qIdx].revenue = Math.round((quarterlyGrandTotals[qIdx].revenue + revVal) * 100) / 100;

    if (prodObj.totalRevenue > topPair.revenue) {
      topPair = {
        name: `${custName} – ${prodName}`,
        revenue: prodObj.totalRevenue,
      };
    }
  });

  let customersList = Array.from(customerMap.values()).map((custObj) => {
    const productsList = Array.from(custObj.productsMap.values()).map((p) => ({
      ...p,
      totalRevenue: Math.round(p.totalRevenue * 100) / 100,
    }));
    productsList.sort((a, b) => b.totalRevenue - a.totalRevenue);

    const { productsMap, ...cleanCust } = custObj;
    return {
      ...cleanCust,
      totalRevenue: Math.round(cleanCust.totalRevenue * 100) / 100,
      products: productsList,
    };
  });

  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    customersList = customersList
      .map((c) => {
        const matchesCust =
          c.customerName.toLowerCase().includes(q) ||
          (c.contact && c.contact.toLowerCase().includes(q)) ||
          (c.gstin && c.gstin.toLowerCase().includes(q)) ||
          (c.address && c.address.toLowerCase().includes(q));

        if (matchesCust) return c;

        const matchingProds = c.products.filter((p) =>
          p.medicineName.toLowerCase().includes(q)
        );

        if (matchingProds.length > 0) {
          return {
            ...c,
            products: matchingProds,
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  customersList.sort((a, b) => b.totalRevenue - a.totalRevenue);

  let totalProductsCount = 0;
  customersList.forEach((c) => {
    totalProductsCount += c.products.length;
  });

  const selectedFYLabel = `FY ${selectedFY}-${String(selectedFY + 1).slice(-2)}`;

  return {
    financialYear: selectedFY,
    financialYearLabel: selectedFYLabel,
    availableFinancialYears,
    availableYears: availableFYs,
    summary: {
      grandTotalRevenue: Math.round(grandTotalRevenue * 100) / 100,
      grandTotalQuantity,
      activeCustomersCount: customersList.length,
      activeRelationshipsCount: totalProductsCount,
      topCustomerProduct: topPair.name,
      topCustomerProductAmount: Math.round(topPair.revenue * 100) / 100,
    },
    monthlyGrandTotals,
    quarterlyGrandTotals,
    customers: customersList,
  };
};

module.exports = {
  getInventoryStatsData,
  getCustomerStatsData,
  getInvoiceStatsData,
  getDashboardStatsData,
  getProductWiseMonthlySalesData,
  getCustomerWiseSalesData,
  getCustomerProductMonthlySalesData,
};
