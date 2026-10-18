const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { ERROR_CODES, sendError } = require("../utils/response");
const { ERRORS } = require("../utils/messages");

// Customer Services sits behind a second password on top of the normal login.
// Unlocking issues a short-lived token scoped to that section and to the user
// who unlocked it; the frontend keeps it in memory only, so leaving the page
// locks it again. Locked responses are 403 (not 401) so the client does not
// treat them as a lost session and sign the user out.
const CUSTOMER_SERVICES_SCOPE = "customer-services";
const SECTION_TOKEN_HEADER = "x-section-token";
const SECTION_TOKEN_TTL = "30m";

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest();

const isSectionPasswordConfigured = () =>
  Boolean(process.env.CUSTOMER_SERVICES_PASSWORD);

// Hashing both sides first gives equal-length buffers, so the comparison is
// constant-time regardless of what was typed.
const checkSectionPassword = (password) => {
  const expected = process.env.CUSTOMER_SERVICES_PASSWORD;
  if (!expected || typeof password !== "string" || !password) return false;
  return crypto.timingSafeEqual(hash(password), hash(expected));
};

const signSectionToken = (userId) =>
  jwt.sign(
    { userId: String(userId), scope: CUSTOMER_SERVICES_SCOPE },
    process.env.JWT_SECRET,
    { expiresIn: SECTION_TOKEN_TTL },
  );

const sendLocked = (res) =>
  sendError(res, {
    message: ERRORS.sectionLock.locked,
    code: ERROR_CODES.SECTION_LOCKED,
    errorMessage: ERRORS.sectionLock.locked,
    statusCode: 403,
  });

// Runs after `authenticate`, so req.user is already the signed-in user.
const requireSectionUnlock = (req, res, next) => {
  const token = req.headers[SECTION_TOKEN_HEADER];
  if (!token) return sendLocked(res);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (
      payload.scope !== CUSTOMER_SERVICES_SCOPE ||
      payload.userId !== String(req.user?._id)
    ) {
      return sendLocked(res);
    }
    return next();
  } catch (error) {
    return sendLocked(res);
  }
};

module.exports = {
  SECTION_TOKEN_TTL,
  checkSectionPassword,
  isSectionPasswordConfigured,
  requireSectionUnlock,
  signSectionToken,
};
