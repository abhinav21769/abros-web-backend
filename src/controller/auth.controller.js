const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Company = require("../models/company.model");
const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { SUCCESS, ERRORS, getUserMessage } = require("../utils/messages");
const { toCompanySummary, toUserResponse } = require("../utils/serializers");

const signToken = (userId) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }

  return jwt.sign({ userId }, secret, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

const logger = require("../utils/logger");

const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      logger.warn("Login attempt missing username or password");
      return sendError(res, {
        message: ERRORS.auth.invalidCredentials,
        code: ERROR_CODES.VALIDATION_ERROR,
        errorMessage: ERRORS.auth.invalidCredentials,
        statusCode: 400,
      });
    }

    const user = await User.findOne({
      username: String(username).trim().toLowerCase(),
    })
      .select("+password")
      .populate("company");

    if (!user || !user.isActive) {
      logger.warn(`Failed login attempt for unknown/inactive username: '${username}'`);
      return sendError(res, {
        message: ERRORS.auth.invalidCredentials,
        code: ERROR_CODES.UNAUTHORIZED,
        errorMessage: ERRORS.auth.invalidCredentials,
        statusCode: 401,
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      logger.warn(`Failed login attempt for user: '${username}' (Invalid password)`);
      return sendError(res, {
        message: ERRORS.auth.invalidCredentials,
        code: ERROR_CODES.UNAUTHORIZED,
        errorMessage: ERRORS.auth.invalidCredentials,
        statusCode: 401,
      });
    }

    // A user whose company was deactivated cannot sign in, even with the right
    // password - same rule the request middleware applies per request.
    if (!user.company || user.company.isActive === false) {
      logger.warn(`Login blocked for user '${username}': company missing or inactive`);
      return sendError(res, {
        message: ERRORS.auth.invalidCredentials,
        code: ERROR_CODES.UNAUTHORIZED,
        errorMessage: ERRORS.auth.invalidCredentials,
        statusCode: 401,
      });
    }

    const token = signToken(user._id);

    return sendSuccess(res, {
      message: SUCCESS.auth.login,
      data: {
        token,
        user: toUserResponse(user),
        company: toCompanySummary(user.company),
      },
    });
  } catch (error) {
    logger.error("Login failed", error);
    return sendError(res, {
      message: ERRORS.auth.loginFailed,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.auth.loginFailed,
      statusCode: 500,
    });
  }
};

const getMe = async (req, res) => {
  return sendSuccess(res, {
    data: {
      user: toUserResponse(req.user),
      company: toCompanySummary(req.user.company),
    },
  });
};

// Admin-secret bootstrap: creates a tenant together with the admin who will
// finish onboarding from inside the app. Everything else about the company is
// left blank on purpose - the owner fills it in through the wizard.
const createCompany = async (req, res) => {
  try {
    const { companyName, username, password, name } = req.body;

    if (!companyName || !username || !password) {
      return sendError(res, {
        message: ERRORS.validation,
        code: ERROR_CODES.VALIDATION_ERROR,
        errorMessage: ERRORS.validation,
        statusCode: 400,
      });
    }

    const existing = await User.findOne({
      username: String(username).trim().toLowerCase(),
    }).lean();
    if (existing) {
      return sendError(res, {
        message: ERRORS.duplicate.username,
        code: ERROR_CODES.DUPLICATE_KEY,
        errorMessage: ERRORS.duplicate.username,
        statusCode: 400,
      });
    }

    const company = await Company.create({ name: companyName });

    let user;
    try {
      user = await User.create({
        company: company._id,
        username,
        password,
        name,
        role: "admin",
      });
    } catch (error) {
      // Without a usable transaction on standalone Mongo, clean up by hand so a
      // failed user create does not leave an orphan company behind.
      await Company.deleteOne({ _id: company._id });
      throw error;
    }

    return sendSuccess(res, {
      message: SUCCESS.company.created,
      data: {
        company: toCompanySummary(company),
        user: toUserResponse(user),
      },
      statusCode: 201,
    });
  } catch (error) {
    logger.error("Company creation failed", error);
    return sendError(res, {
      message: ERRORS.saveFailed.company,
      code:
        error.code === 11000
          ? ERROR_CODES.DUPLICATE_KEY
          : ERROR_CODES.VALIDATION_ERROR,
      errorMessage: getUserMessage(error, ERRORS.saveFailed.company),
      statusCode: 400,
    });
  }
};

// Admin-secret escape hatch for adding a user to an existing company. Day-to-day
// user management happens in-app through /api/users.
const createUser = async (req, res) => {
  try {
    const { username, password, name, role, companyId } = req.body;

    if (!companyId || !mongoose.isValidObjectId(companyId)) {
      return sendError(res, {
        message: ERRORS.notFound.company,
        code: ERROR_CODES.VALIDATION_ERROR,
        errorMessage: ERRORS.notFound.company,
        statusCode: 400,
      });
    }

    const company = await Company.findById(companyId).lean();
    if (!company) {
      return sendError(res, {
        message: ERRORS.notFound.company,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.company,
        statusCode: 404,
      });
    }

    const user = await User.create({
      company: company._id,
      username,
      password,
      name,
      role: role === "admin" ? "admin" : "viewer",
    });

    return sendSuccess(res, {
      message: SUCCESS.auth.userCreated,
      data: { user: toUserResponse(user) },
      statusCode: 201,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.auth.userCreateFailed,
      code:
        error.code === 11000
          ? ERROR_CODES.DUPLICATE_KEY
          : ERROR_CODES.VALIDATION_ERROR,
      errorMessage: getUserMessage(error, ERRORS.auth.userCreateFailed),
      statusCode: 400,
    });
  }
};

module.exports = {
  login,
  getMe,
  createCompany,
  createUser,
};
