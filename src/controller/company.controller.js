const Company = require("../models/company.model");
const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { SUCCESS, ERRORS, getUserMessage } = require("../utils/messages");
const { toCompanyProfile } = require("../utils/serializers");
const { invalidateCompanyCache } = require("../middleware/auth.middleware");
const logger = require("../utils/logger");

// Only these may be written from the app. Anything else on the document
// (isActive, timestamps) is administrative and stays out of reach.
const EDITABLE_FIELDS = [
  "name",
  "logo",
  "addressLine",
  "city",
  "state",
  "pincode",
  "phone",
  "email",
  "gstin",
  "upiVpa",
  "invoicePrefix",
  "purchasePrefix",
  "telegramChatId",
];

const pickCompanyPayload = (body = {}) => {
  const payload = {};

  EDITABLE_FIELDS.forEach((field) => {
    if (body[field] !== undefined) {
      payload[field] = body[field];
    }
  });

  if (Array.isArray(body.dlNumbers)) {
    payload.dlNumbers = body.dlNumbers
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }

  if (Array.isArray(body.terms)) {
    payload.terms = body.terms
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }

  if (body.bank && typeof body.bank === "object") {
    payload.bank = {
      name: body.bank.name || "",
      ifsc: body.bank.ifsc || "",
      accountNumber: body.bank.accountNumber || "",
    };
  }

  // An empty string clears the logo; undefined leaves it untouched.
  if (body.logo === "" || body.logo === null) {
    payload.logo = undefined;
  }

  return payload;
};

const loadCompany = async (companyId) => Company.findById(companyId);

const getCompany = async (req, res) => {
  try {
    const company = await loadCompany(req.companyId);

    if (!company) {
      return sendError(res, {
        message: ERRORS.notFound.company,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.company,
        statusCode: 404,
      });
    }

    return sendSuccess(res, { data: { company: toCompanyProfile(company) } });
  } catch (error) {
    logger.error("Failed to load company", error);
    return sendError(res, {
      message: ERRORS.loadFailed.company,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.company,
      statusCode: 500,
    });
  }
};

const saveCompany = async (req, res, { completeOnboarding }) => {
  try {
    const company = await loadCompany(req.companyId);

    if (!company) {
      return sendError(res, {
        message: ERRORS.notFound.company,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.company,
        statusCode: 404,
      });
    }

    const payload = pickCompanyPayload(req.body);
    Object.entries(payload).forEach(([field, value]) => {
      company.set(field, value);
    });

    if (completeOnboarding && !company.onboardingCompleted) {
      company.onboardingCompleted = true;
      company.onboardingCompletedAt = new Date();
    }

    await company.save();
    // Every request caches the user together with their company, so the saved
    // profile has to invalidate those entries or the app keeps serving the old
    // name, logo and onboarding flag until the TTL runs out.
    invalidateCompanyCache(company._id);

    return sendSuccess(res, {
      message: completeOnboarding
        ? SUCCESS.company.onboarded
        : SUCCESS.company.updated,
      data: { company: toCompanyProfile(company) },
    });
  } catch (error) {
    logger.error("Failed to save company", error);
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

const updateCompany = (req, res) =>
  saveCompany(req, res, { completeOnboarding: false });

// The wizard's final step. Same write as an ordinary profile save, but it also
// flips the flag the app uses to stop redirecting the owner back into setup.
const completeOnboarding = (req, res) =>
  saveCompany(req, res, { completeOnboarding: true });

module.exports = { getCompany, updateCompany, completeOnboarding };
