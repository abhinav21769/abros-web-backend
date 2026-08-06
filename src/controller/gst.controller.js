const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { ERRORS } = require("../utils/messages");
const {
  getGstQuarterlySummary,
  getGstDefaults,
} = require("../services/gst.service");

const getQuarterlySummary = async (req, res) => {
  try {
    const defaults = getGstDefaults();
    const financialYear =
      parseInt(req.query.financialYear, 10) || defaults.financialYear;
    const quarter = parseInt(req.query.quarter, 10) || defaults.quarter;

    const data = await getGstQuarterlySummary({ financialYear, quarter });

    return sendSuccess(res, { data });
  } catch (error) {
    if (
      error.message === "Invalid financial year" ||
      error.message === "Invalid quarter"
    ) {
      return sendError(res, {
        message: ERRORS.validation,
        code: ERROR_CODES.VALIDATION_ERROR,
        errorMessage: error.message,
        statusCode: 400,
      });
    }

    return sendError(res, {
      message: ERRORS.loadFailed.gstSummary,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.gstSummary,
      statusCode: 500,
    });
  }
};

module.exports = { getQuarterlySummary };
