// Shared shapes for the auth/company/user payloads so the client always sees the
// same fields no matter which endpoint answered.

const toCompanySummary = (company) => {
  if (!company) return null;
  return {
    id: company._id,
    name: company.name,
    logo: company.logo || null,
    onboardingCompleted: Boolean(company.onboardingCompleted),
  };
};

const toCompanyProfile = (company) => {
  if (!company) return null;
  return {
    id: company._id,
    name: company.name,
    logo: company.logo || null,
    addressLine: company.addressLine || "",
    city: company.city || "",
    state: company.state || "",
    pincode: company.pincode || "",
    phone: company.phone || "",
    email: company.email || "",
    gstin: company.gstin || "",
    dlNumbers: company.dlNumbers || [],
    bank: {
      name: company.bank?.name || "",
      ifsc: company.bank?.ifsc || "",
      accountNumber: company.bank?.accountNumber || "",
    },
    upiVpa: company.upiVpa || "",
    invoicePrefix: company.invoicePrefix || "INV",
    purchasePrefix: company.purchasePrefix || "PO",
    terms: company.terms || [],
    telegramChatId: company.telegramChatId || "",
    onboardingCompleted: Boolean(company.onboardingCompleted),
    onboardingCompletedAt: company.onboardingCompletedAt || null,
    createdAt: company.createdAt,
  };
};

const toUserResponse = (user) => {
  if (!user) return null;
  const company = user.company;
  return {
    id: user._id,
    username: user.username,
    name: user.name,
    role: user.role,
    isActive: user.isActive !== false,
    createdAt: user.createdAt,
    // company may be populated (object) or a bare id depending on the caller.
    company:
      company && typeof company === "object" && company._id
        ? toCompanySummary(company)
        : company || null,
  };
};

module.exports = { toCompanySummary, toCompanyProfile, toUserResponse };
