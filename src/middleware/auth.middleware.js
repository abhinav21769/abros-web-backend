const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const { ERROR_CODES, sendError } = require("../utils/response");
const { ERRORS } = require("../utils/messages");

const USER_CACHE_TTL_MS = 5 * 60 * 1000;
const userCache = new Map();

const getCachedUser = async (userId) => {
  const cacheKey = String(userId);
  const cached = userCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const user = await User.findById(userId)
    .select("-password")
    .populate("company", "name logo isActive onboardingCompleted")
    .lean();
  if (user) {
    userCache.set(cacheKey, {
      user,
      expiresAt: Date.now() + USER_CACHE_TTL_MS,
    });
  }

  return user;
};

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return sendError(res, {
        message: ERRORS.auth.unauthorized,
        code: ERROR_CODES.UNAUTHORIZED,
        errorMessage: ERRORS.auth.unauthorized,
        statusCode: 401,
      });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return sendError(res, {
        message: ERRORS.auth.misconfigured,
        code: ERROR_CODES.INTERNAL_ERROR,
        errorMessage: ERRORS.auth.misconfigured,
        statusCode: 500,
      });
    }

    const payload = jwt.verify(token, secret);
    const user = await getCachedUser(payload.userId);

    if (!user || !user.isActive) {
      return sendError(res, {
        message: ERRORS.auth.unauthorized,
        code: ERROR_CODES.UNAUTHORIZED,
        errorMessage: ERRORS.auth.unauthorized,
        statusCode: 401,
      });
    }

    // C-1 FIX: a user whose company was deactivated must not keep working off a
    // cached token - the tenant gate is checked on every request, not at login.
    if (!user.company || user.company.isActive === false) {
      return sendError(res, {
        message: ERRORS.auth.unauthorized,
        code: ERROR_CODES.UNAUTHORIZED,
        errorMessage: ERRORS.auth.unauthorized,
        statusCode: 401,
      });
    }

    req.user = user;
    // Every tenant-scoped query reads this instead of digging into req.user, so
    // a missed scope is easy to spot in review.
    req.companyId = user.company._id;
    return next();
  } catch (error) {
    return sendError(res, {
      message: ERRORS.auth.unauthorized,
      code: ERROR_CODES.UNAUTHORIZED,
      errorMessage: ERRORS.auth.unauthorized,
      statusCode: 401,
    });
  }
};

const requireAdminSecret = (req, res, next) => {
  const adminSecret = process.env.ADMIN_SECRET;
  const providedSecret = req.headers["x-admin-secret"];

  if (!adminSecret || providedSecret !== adminSecret) {
    return sendError(res, {
      message: ERRORS.auth.forbidden,
      code: ERROR_CODES.FORBIDDEN,
      errorMessage: ERRORS.auth.forbidden,
      statusCode: 403,
    });
  }

  return next();
};

// Role gate. A viewer may read everything in their own company and change
// nothing; the UI hides the controls, this is what actually enforces it.
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return sendError(res, {
      message: ERRORS.auth.forbidden,
      code: ERROR_CODES.FORBIDDEN,
      errorMessage: ERRORS.auth.readOnly,
      statusCode: 403,
    });
  }
  return next();
};

const requireAdmin = requireRole("admin");

// Blanket write gate for the data routers: every mutation there is a POST, PUT,
// PATCH or DELETE, so one guard covers routes added later too.
const denyWritesForViewers = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  return requireAdmin(req, res, next);
};

// Cache invalidation for the 5-minute user cache: called when a user's role or
// active flag changes so the change is not delayed behind the TTL.
const invalidateUserCache = (userId) => {
  if (userId == null) {
    userCache.clear();
    return;
  }
  userCache.delete(String(userId));
};

module.exports = {
  authenticate,
  requireAdminSecret,
  requireRole,
  requireAdmin,
  denyWritesForViewers,
  invalidateUserCache,
};
