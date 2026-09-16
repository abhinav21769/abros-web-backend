const SUCCESS = {
  medicine: {
    created: "Medicine added to inventory.",
    updated: "Medicine details saved.",
    deleted: "Medicine removed from inventory.",
  },
  customer: {
    created: "Customer added successfully.",
    updated: "Customer details saved.",
    deleted: "Customer removed successfully.",
  },
  invoice: {
    created: "Invoice created successfully.",
    updated: "Invoice updated successfully.",
    deleted: "Invoice deleted successfully.",
  },
  purchase: {
    created: "Purchase entry saved and stock updated.",
  },
  auth: {
    login: "Signed in successfully.",
    userCreated: "User created successfully.",
    userUpdated: "User details saved.",
    userDeleted: "User removed successfully.",
    passwordChanged: "Password updated successfully.",
  },
  company: {
    created: "Company created successfully.",
    updated: "Company profile saved.",
    onboarded: "Company setup completed.",
  },
};

const ERRORS = {
  generic: "Something went wrong. Please try again.",
  payloadTooLarge: "That file is too large. Please use an image under 300KB.",
  validation: "Please check the form and fill in all required details.",
  notFound: {
    medicine: "This medicine could not be found.",
    customer: "This customer could not be found.",
    customerByDlNo: "No customer found with this Drug License number.",
    invoice: "This invoice could not be found.",
    purchase: "This purchase entry could not be found.",
    company: "This company could not be found.",
    user: "This user could not be found.",
    route: "The page or link you used is not available.",
  },
  loadFailed: {
    medicines: "Could not load medicines. Please refresh and try again.",
    medicine: "Could not load medicine details. Please try again.",
    expiringMedicines: "Could not load expiring medicines. Please try again.",
    expiredMedicines: "Could not load expired medicines. Please try again.",
    inventoryStats: "Could not load inventory summary. Please try again.",
    customers: "Could not load customers. Please refresh and try again.",
    customer: "Could not load customer details. Please try again.",
    customerStats: "Could not load customer summary. Please try again.",
    invoices: "Could not load invoices. Please refresh and try again.",
    invoice: "Could not load invoice details. Please try again.",
    invoiceStats: "Could not load invoice summary. Please try again.",
    dashboardStats: "Could not load dashboard summary. Please try again.",
    gstSummary: "Could not load GST return summary. Please try again.",
    invoiceNumber: "Could not create a new invoice number. Please try again.",
    purchases: "Could not load purchase entries. Please refresh and try again.",
    purchase: "Could not load purchase details. Please try again.",
    purchaseNumber: "Could not create a new purchase number. Please try again.",
    ledger: "Could not load stock ledger. Please refresh and try again.",
    company: "Could not load company details. Please refresh and try again.",
    users: "Could not load users. Please refresh and try again.",
  },
  saveFailed: {
    medicine: "Could not save medicine. Please check the details and try again.",
    customer: "Could not save customer. Please check the details and try again.",
    invoice: "Could not save invoice. Please check the details and try again.",
    purchase: "Could not save purchase entry. Please check the details and try again.",
    company: "Could not save company details. Please check the details and try again.",
    user: "Could not save user. Please check the details and try again.",
  },
  insufficientStock:
    "Not enough stock in inventory for one or more medicines on this invoice.",
  deleteFailed: {
    medicine: "Could not remove medicine. Please try again.",
    customer: "Could not remove customer. Please try again.",
    invoice: "Could not delete invoice. Please try again.",
  },
  immutable: {
    invoiceNumber:
      "Invoice number cannot be changed after the invoice is issued.",
  },
  duplicate: {
    gstin: "A customer with this GSTIN already exists.",
    dlNo: "A customer with this Drug License number already exists.",
    invoiceNumber: "This invoice number is already in use. Please use a different number.",
    username: "This username is already taken.",
    telegramChatId: "This Telegram chat is already linked to another company.",
  },
  auth: {
    unauthorized: "Please sign in to continue.",
    forbidden: "You are not allowed to perform this action.",
    readOnly: "Your account has view-only access. Ask an admin to make this change.",
    lastAdmin: "This is the only admin on the account. Promote another user before changing this one.",
    selfRoleChange: "You cannot change your own role.",
    selfDelete: "You cannot remove your own account.",
    invalidCredentials: "Invalid username or password.",
    loginFailed: "Could not sign in. Please try again.",
    userCreateFailed: "Could not create user. Please check the details and try again.",
    misconfigured: "Authentication is not configured on the server.",
  },
};

const VALIDATION_MESSAGES = {
  "Medicine name is required": "Please enter the medicine name.",
  "Expiry date is required": "Please select an expiry date.",
  "Expiry date must be in the future": "Expiry date must be a future date.",
  "Packaging type is required": "Please enter the packaging type.",
  "MRP is required": "Please enter the MRP.",
  "MRP cannot be negative": "MRP cannot be less than zero.",
  "Rate is required": "Please enter the rate.",
  "Rate cannot be negative": "Rate cannot be less than zero.",
  "PTR is required": "PTR could not be calculated. Please check the MRP.",
  "PTR cannot be negative": "PTR cannot be less than zero.",
  "Quantity cannot be negative": "Quantity cannot be less than zero.",
  "Customer name is required": "Please enter the customer name.",
  "Company name is required": "Please enter your company name.",
  "Company is required": "Your account is not linked to a company. Please contact an admin.",
  "Logo must be an image under 300KB.": "Please upload a PNG or JPG logo smaller than 300KB.",
  "Address is required": "Please enter the customer address.",
  "Invoice number is required": "Please enter an invoice number.",
  "Customer is required": "Please select a customer.",
  "At least one item is required": "Please add at least one item to the invoice.",
  "Medicine is required": "Please select a medicine from inventory for each line item.",
  "Medicine name is required": "Please enter the medicine name for each item.",
  "Quantity is required": "Please enter the quantity for each item.",
  "Quantity must be at least 1": "Quantity must be at least 1.",
};

const DUPLICATE_FIELD_LABELS = {
  gstin: ERRORS.duplicate.gstin,
  dlNo: ERRORS.duplicate.dlNo,
  invoiceNumber: ERRORS.duplicate.invoiceNumber,
  username: ERRORS.duplicate.username,
  telegramChatId: ERRORS.duplicate.telegramChatId,
};

function simplifyValidationMessage(message) {
  return VALIDATION_MESSAGES[message] || message;
}

function getValidationMessage(error) {
  if (error?.name !== "ValidationError" || !error.errors) {
    return null;
  }

  const firstError = Object.values(error.errors)[0];
  if (!firstError?.message) {
    return ERRORS.validation;
  }

  return simplifyValidationMessage(firstError.message);
}

function getDuplicateMessage(error) {
  if (error?.code !== 11000) {
    return null;
  }

  // Unique indexes are compound on `company`, so the first key is always the
  // tenant - the field that actually clashed is the next one.
  const field = Object.keys(error.keyPattern || {}).find((key) => key !== "company");
  return DUPLICATE_FIELD_LABELS[field] || ERRORS.validation;
}

function getUserMessage(error, fallback = ERRORS.generic) {
  if (error?.name === "InsufficientStockError") {
    return error.message;
  }

  return (
    getDuplicateMessage(error) ||
    getValidationMessage(error) ||
    fallback
  );
}

module.exports = {
  SUCCESS,
  ERRORS,
  getUserMessage,
  getValidationMessage,
  getDuplicateMessage,
};
