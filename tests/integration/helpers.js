const jwt = require("jsonwebtoken");
const User = require("../../src/models/user.model");
const Company = require("../../src/models/company.model");
const Customer = require("../../src/models/customer.model");
const Medicine = require("../../src/models/medicine.model");

const createTestCompany = async (overrides = {}) => {
  const unique = Date.now() + Math.random().toString(36).substring(2, 7);
  return Company.create({
    name: overrides.name || `Test Pharma ${unique}`,
    gstin: overrides.gstin || undefined,
    onboardingCompleted:
      overrides.onboardingCompleted !== undefined
        ? overrides.onboardingCompleted
        : true,
    ...overrides,
  });
};

// Every record belongs to a company. A test that does not care which one gets
// the single company for that test - collections are wiped between tests, so
// the first helper call creates it and the rest reuse it. A test that does care
// passes `company` explicitly.
const getDefaultCompany = async () => {
  const existing = await Company.findOne().sort({ createdAt: 1 });
  return existing || createTestCompany();
};

const createTestUser = async (overrides = {}) => {
  const unique = Date.now() + Math.random().toString(36).substring(2, 7);
  const company = overrides.company || (await getDefaultCompany());
  const user = await User.create({
    username: overrides.username || `testuser_${unique}`,
    password: overrides.password || "password123",
    name: overrides.name || "Test User",
    isActive: overrides.isActive !== undefined ? overrides.isActive : true,
    role: overrides.role || "admin",
    ...overrides,
    company: company._id || company,
  });

  const token = jwt.sign(
    { userId: user._id },
    process.env.JWT_SECRET || "test-jwt-secret-key-123456",
    { expiresIn: "1d" },
  );

  return { user, token, company };
};

const createTestCustomer = async (overrides = {}) => {
  const unique = Date.now() + Math.random().toString(36).substring(2, 7);
  const company = overrides.company || (await getDefaultCompany());
  return Customer.create({
    company: company._id || company,
    name: overrides.name || `Pharmacy Test ${unique}`,
    address: overrides.address || "123 Medical Enclave, New Delhi",
    contact: overrides.contact || "9876543210",
    gstin: overrides.gstin || `07AAAAA${Math.floor(1000 + Math.random() * 9000)}A1Z5`,
    dlNo: overrides.dlNo || `DL-${unique}`,
    ...overrides,
  });
};

const createTestMedicine = async (overrides = {}) => {
  const unique = Date.now() + Math.random().toString(36).substring(2, 7);
  const company = overrides.company || (await getDefaultCompany());
  return Medicine.create({
    company: company._id || company,
    name: overrides.name || `Amoxicillin ${unique}mg`,
    packagingType: overrides.packagingType || "10x10 Strip",
    manufacturer: overrides.manufacturer || "Abros Pharma",
    hsn: overrides.hsn || "300490",
    gstRate: overrides.gstRate !== undefined ? overrides.gstRate : 5,
    batches: overrides.batches || [
      {
        batchNumber: `BAT-${unique}`,
        expiryDate: new Date(Date.now() + 365 * 86400000),
        mrp: 120,
        rate: 80,
        ptr: 75,
        quantity: 100,
      },
    ],
    ...overrides,
  });
};

module.exports = {
  createTestCompany,
  getDefaultCompany,
  createTestUser,
  createTestCustomer,
  createTestMedicine,
};
