const mongoose = require("mongoose");
const User = require("../models/user.model");
const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { SUCCESS, ERRORS, getUserMessage } = require("../utils/messages");
const { toUserResponse } = require("../utils/serializers");
const { invalidateUserCache } = require("../middleware/auth.middleware");
const logger = require("../utils/logger");

const normalizeRole = (value) => (value === "admin" ? "admin" : "viewer");

const countOtherAdmins = (companyId, excludeUserId) =>
  User.countDocuments({
    company: companyId,
    role: "admin",
    isActive: true,
    _id: { $ne: excludeUserId },
  });

const listUsers = async (req, res) => {
  try {
    const users = await User.find({ company: req.companyId })
      .sort({ createdAt: 1 })
      .lean();

    return sendSuccess(res, {
      data: { items: users.map(toUserResponse), total: users.length },
    });
  } catch (error) {
    logger.error("Failed to list users", error);
    return sendError(res, {
      message: ERRORS.loadFailed.users,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.users,
      statusCode: 500,
    });
  }
};

const createUser = async (req, res) => {
  try {
    const { username, password, name, role } = req.body;

    const user = await User.create({
      // Always the caller's own company - a tenant admin cannot place a user
      // anywhere else, whatever the body says.
      company: req.companyId,
      username,
      password,
      name,
      role: normalizeRole(role),
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

const updateUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return sendError(res, {
        message: ERRORS.notFound.user,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.user,
        statusCode: 404,
      });
    }

    const user = await User.findOne({ _id: id, company: req.companyId }).select(
      "+password",
    );

    if (!user) {
      return sendError(res, {
        message: ERRORS.notFound.user,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.user,
        statusCode: 404,
      });
    }

    const isSelf = String(user._id) === String(req.user._id);
    const { name, role, isActive, password } = req.body;

    if (role !== undefined && normalizeRole(role) !== user.role) {
      // Locking yourself out of your own admin rights is never what was meant.
      if (isSelf) {
        return sendError(res, {
          message: ERRORS.auth.forbidden,
          code: ERROR_CODES.FORBIDDEN,
          errorMessage: ERRORS.auth.selfRoleChange,
          statusCode: 400,
        });
      }

      if (user.role === "admin" && (await countOtherAdmins(req.companyId, user._id)) === 0) {
        return sendError(res, {
          message: ERRORS.auth.forbidden,
          code: ERROR_CODES.VALIDATION_ERROR,
          errorMessage: ERRORS.auth.lastAdmin,
          statusCode: 400,
        });
      }

      user.role = normalizeRole(role);
    }

    if (isActive !== undefined && Boolean(isActive) !== user.isActive) {
      if (isSelf && !isActive) {
        return sendError(res, {
          message: ERRORS.auth.forbidden,
          code: ERROR_CODES.FORBIDDEN,
          errorMessage: ERRORS.auth.selfDelete,
          statusCode: 400,
        });
      }

      if (
        !isActive &&
        user.role === "admin" &&
        (await countOtherAdmins(req.companyId, user._id)) === 0
      ) {
        return sendError(res, {
          message: ERRORS.auth.forbidden,
          code: ERROR_CODES.VALIDATION_ERROR,
          errorMessage: ERRORS.auth.lastAdmin,
          statusCode: 400,
        });
      }

      user.isActive = Boolean(isActive);
    }

    if (name !== undefined) {
      user.name = name;
    }

    if (password) {
      // Assigning triggers the model's hashing hook.
      user.password = password;
    }

    await user.save();
    // The request middleware caches users for five minutes; without this a
    // demoted user keeps their admin rights until the TTL runs out.
    invalidateUserCache(user._id);

    return sendSuccess(res, {
      message: password ? SUCCESS.auth.passwordChanged : SUCCESS.auth.userUpdated,
      data: { user: toUserResponse(user) },
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.saveFailed.user,
      code:
        error.code === 11000
          ? ERROR_CODES.DUPLICATE_KEY
          : ERROR_CODES.VALIDATION_ERROR,
      errorMessage: getUserMessage(error, ERRORS.saveFailed.user),
      statusCode: 400,
    });
  }
};

const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return sendError(res, {
        message: ERRORS.notFound.user,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.user,
        statusCode: 404,
      });
    }

    if (String(id) === String(req.user._id)) {
      return sendError(res, {
        message: ERRORS.auth.forbidden,
        code: ERROR_CODES.FORBIDDEN,
        errorMessage: ERRORS.auth.selfDelete,
        statusCode: 400,
      });
    }

    const user = await User.findOne({ _id: id, company: req.companyId });

    if (!user) {
      return sendError(res, {
        message: ERRORS.notFound.user,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.user,
        statusCode: 404,
      });
    }

    if (user.role === "admin" && (await countOtherAdmins(req.companyId, user._id)) === 0) {
      return sendError(res, {
        message: ERRORS.auth.forbidden,
        code: ERROR_CODES.VALIDATION_ERROR,
        errorMessage: ERRORS.auth.lastAdmin,
        statusCode: 400,
      });
    }

    await User.deleteOne({ _id: user._id, company: req.companyId });
    invalidateUserCache(user._id);

    return sendSuccess(res, {
      message: SUCCESS.auth.userDeleted,
      data: { id: user._id },
    });
  } catch (error) {
    logger.error("Failed to delete user", error);
    return sendError(res, {
      message: ERRORS.generic,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.generic,
      statusCode: 500,
    });
  }
};

module.exports = { listUsers, createUser, updateUser, deleteUser };
