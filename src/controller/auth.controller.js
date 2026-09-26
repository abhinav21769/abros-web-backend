const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { SUCCESS, ERRORS, getUserMessage } = require("../utils/messages");

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
    }).select("+password");

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

    const token = signToken(user._id);

    return sendSuccess(res, {
      message: SUCCESS.auth.login,
      data: {
        token,
        user: {
          id: user._id,
          username: user.username,
          name: user.name,
        },
      },
    });
  } catch (error) {
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
      user: {
        id: req.user._id,
        username: req.user.username,
        name: req.user.name,
      },
    },
  });
};

const createUser = async (req, res) => {
  try {
    const { username, password, name } = req.body;

    const user = await User.create({
      username,
      password,
      name,
    });

    return sendSuccess(res, {
      message: SUCCESS.auth.userCreated,
      data: {
        user: {
          id: user._id,
          username: user.username,
          name: user.name,
        },
      },
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
  createUser,
};
