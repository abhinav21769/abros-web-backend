const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { ERRORS } = require("../utils/messages");
const {
  getDashboardStatsData,
  getProductWiseMonthlySalesData,
  getCustomerWiseSalesData,
  getCustomerProductMonthlySalesData,
} = require("../services/stats.service");

const getDashboardStats = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await getDashboardStatsData(days);

    return sendSuccess(res, { data });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.dashboardStats,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.dashboardStats,
      statusCode: 500,
    });
  }
};

const getProductWiseMonthlySales = async (req, res) => {
  try {
    const { year, financialYear, search } = req.query;
    const data = await getProductWiseMonthlySalesData({ year, financialYear, search });

    return sendSuccess(res, { data });
  } catch (error) {
    return sendError(res, {
      message: "Failed to load quarterly product sales report",
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: error.message || "Failed to load quarterly product sales report",
      statusCode: 500,
    });
  }
};

const getCustomerWiseSales = async (req, res) => {
  try {
    const { year, financialYear, search } = req.query;
    const data = await getCustomerWiseSalesData({ year, financialYear, search });

    return sendSuccess(res, { data });
  } catch (error) {
    return sendError(res, {
      message: "Failed to load quarterly customer sales report",
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: error.message || "Failed to load quarterly customer sales report",
      statusCode: 500,
    });
  }
};

const getCustomerProductMonthlySales = async (req, res) => {
  try {
    const { year, financialYear, customerId, search } = req.query;
    const data = await getCustomerProductMonthlySalesData({ year, financialYear, customerId, search });

    return sendSuccess(res, { data });
  } catch (error) {
    return sendError(res, {
      message: "Failed to load customer product monthly sales report",
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: error.message || "Failed to load customer product monthly sales report",
      statusCode: 500,
    });
  }
};

module.exports = {
  getDashboardStats,
  getProductWiseMonthlySales,
  getCustomerWiseSales,
  getCustomerProductMonthlySales,
};
