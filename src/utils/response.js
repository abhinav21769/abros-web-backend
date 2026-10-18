const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  DUPLICATE_KEY: "DUPLICATE_KEY",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  SECTION_LOCKED: "SECTION_LOCKED",
};

const sendSuccess = (
  res,
  { message = "", data = {}, statusCode = 200 } = {},
) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    error: null,
  });
};

const sendError = (
  res,
  {
    message = "",
    code = ERROR_CODES.INTERNAL_ERROR,
    errorMessage = "",
    statusCode = 500,
  } = {},
) => {
  return res.status(statusCode).json({
    success: false,
    message,
    data: null,
    error: {
      code,
      message: errorMessage || message,
    },
  });
};

module.exports = { ERROR_CODES, sendSuccess, sendError };
