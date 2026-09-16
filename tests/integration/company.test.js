const request = require("supertest");
const app = require("../../app");
const Company = require("../../src/models/company.model");
const User = require("../../src/models/user.model");
const { createTestUser, createTestCompany } = require("./helpers");

describe("Company profile and onboarding", () => {
  let token;
  let company;

  beforeEach(async () => {
    company = await createTestCompany({
      name: "Fresh Pharma",
      onboardingCompleted: false,
    });
    ({ token } = await createTestUser({ company, username: "fresh_admin" }));
  });

  const authed = () => ({ Authorization: `Bearer ${token}` });

  const ONE_PIXEL_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  test("a new company starts un-onboarded", async () => {
    const res = await request(app).get("/api/company").set(authed());

    expect(res.status).toBe(200);
    expect(res.body.data.company.onboardingCompleted).toBe(false);
    expect(res.body.data.company.name).toBe("Fresh Pharma");
  });

  test("completing onboarding stores the profile and flips the flag", async () => {
    const res = await request(app)
      .post("/api/company/onboarding")
      .set(authed())
      .send({
        name: "Fresh Pharma Pvt Ltd",
        logo: ONE_PIXEL_PNG,
        addressLine: "12 Market Road",
        city: "Ambala",
        state: "Haryana",
        pincode: "134003",
        phone: "9876543210",
        gstin: "06AAAAA0000A1Z5",
        dlNumbers: ["DL-20B-001", "", "DL-21B-002"],
        bank: { name: "PNB", ifsc: "punb0120310", accountNumber: "10401132" },
        upiVpa: "fresh@paytm",
        invoicePrefix: "fp",
      });

    expect(res.status).toBe(200);
    const saved = res.body.data.company;
    expect(saved.onboardingCompleted).toBe(true);
    expect(saved.name).toBe("Fresh Pharma Pvt Ltd");
    expect(saved.logo).toBe(ONE_PIXEL_PNG);
    expect(saved.gstin).toBe("06AAAAA0000A1Z5");
    // Blank licence rows from the form are dropped, not stored.
    expect(saved.dlNumbers).toEqual(["DL-20B-001", "DL-21B-002"]);
    expect(saved.bank.ifsc).toBe("PUNB0120310");
    expect(saved.invoicePrefix).toBe("FP");

    const inDb = await Company.findById(company._id);
    expect(inDb.onboardingCompleted).toBe(true);
    expect(inDb.onboardingCompletedAt).toBeInstanceOf(Date);
  });

  test("the invoice series uses the company's own prefix", async () => {
    await request(app)
      .put("/api/company")
      .set(authed())
      .send({ invoicePrefix: "FP" });

    const res = await request(app)
      .get("/api/invoices/generate-number")
      .set(authed());

    expect(res.status).toBe(200);
    expect(res.body.data.invoiceNumber).toMatch(/^FP-\d{4}-001$/);
  });

  test("rejects a logo that is not an image", async () => {
    const res = await request(app)
      .put("/api/company")
      .set(authed())
      .send({ logo: "data:text/html;base64,PHNjcmlwdD4=" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects a logo over the size cap", async () => {
    const huge = `data:image/png;base64,${"A".repeat(400_001)}`;

    const res = await request(app)
      .put("/api/company")
      .set(authed())
      .send({ logo: huge });

    expect(res.status).toBe(400);
  });

  test("ignores fields that are not the company's to set", async () => {
    const res = await request(app)
      .put("/api/company")
      .set(authed())
      .send({ isActive: false, onboardingCompleted: true, name: "Renamed" });

    expect(res.status).toBe(200);
    const inDb = await Company.findById(company._id);
    expect(inDb.name).toBe("Renamed");
    expect(inDb.isActive).toBe(true);
    // Only the onboarding endpoint may flip this.
    expect(inDb.onboardingCompleted).toBe(false);
  });

  test("one company cannot claim another's Telegram chat", async () => {
    const other = await createTestCompany({ name: "Other Pharma" });
    await Company.updateOne({ _id: other._id }, { telegramChatId: "12345" });

    const res = await request(app)
      .put("/api/company")
      .set(authed())
      .send({ telegramChatId: "12345" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("DUPLICATE_KEY");
  });
});

describe("Company user management", () => {
  let adminToken;
  let admin;
  let company;

  beforeEach(async () => {
    const created = await createTestUser({ username: "owner", role: "admin" });
    adminToken = created.token;
    admin = created.user;
    company = created.company;
  });

  const authed = () => ({ Authorization: `Bearer ${adminToken}` });

  test("creates a viewer inside the admin's own company", async () => {
    const res = await request(app)
      .post("/api/users")
      .set(authed())
      .send({
        username: "shopviewer",
        password: "password123",
        name: "Shop Viewer",
        role: "viewer",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe("viewer");

    const inDb = await User.findOne({ username: "shopviewer" });
    expect(String(inDb.company)).toBe(String(company._id));
  });

  test("a company passed in the body is ignored", async () => {
    const other = await createTestCompany({ name: "Elsewhere" });

    const res = await request(app)
      .post("/api/users")
      .set(authed())
      .send({
        company: String(other._id),
        username: "plantedviewer",
        password: "password123",
      });

    expect(res.status).toBe(201);
    const inDb = await User.findOne({ username: "plantedviewer" });
    expect(String(inDb.company)).toBe(String(company._id));
  });

  test("lists only the admin's own company's users", async () => {
    const other = await createTestCompany({ name: "Elsewhere" });
    await createTestUser({ company: other, username: "stranger" });
    await createTestUser({ company, username: "colleague", role: "viewer" });

    const res = await request(app).get("/api/users").set(authed());

    expect(res.status).toBe(200);
    const usernames = res.body.data.items.map((u) => u.username);
    expect(usernames).toContain("owner");
    expect(usernames).toContain("colleague");
    expect(usernames).not.toContain("stranger");
  });

  test("cannot touch a user in another company", async () => {
    const other = await createTestCompany({ name: "Elsewhere" });
    const { user: stranger } = await createTestUser({
      company: other,
      username: "stranger",
    });

    const update = await request(app)
      .patch(`/api/users/${stranger._id}`)
      .set(authed())
      .send({ role: "viewer" });
    expect(update.status).toBe(404);

    const remove = await request(app)
      .delete(`/api/users/${stranger._id}`)
      .set(authed());
    expect(remove.status).toBe(404);
  });

  test("refuses to leave the company without an admin", async () => {
    const { user: viewer } = await createTestUser({
      company,
      username: "onlyviewer",
      role: "viewer",
    });

    // Self-demotion is refused outright.
    const self = await request(app)
      .patch(`/api/users/${admin._id}`)
      .set(authed())
      .send({ role: "viewer" });
    expect(self.status).toBe(400);

    // And so is deleting the last admin, even by another admin's hand.
    const secondAdmin = await createTestUser({
      company,
      username: "secondadmin",
      role: "admin",
    });
    const removeFirst = await request(app)
      .delete(`/api/users/${admin._id}`)
      .set({ Authorization: `Bearer ${secondAdmin.token}` });
    expect(removeFirst.status).toBe(200);

    const removeLast = await request(app)
      .delete(`/api/users/${secondAdmin.user._id}`)
      .set({ Authorization: `Bearer ${secondAdmin.token}` });
    expect(removeLast.status).toBe(400);

    expect(viewer.role).toBe("viewer");
  });

  test("resets another user's password", async () => {
    const { user: viewer } = await createTestUser({
      company,
      username: "forgetful",
      role: "viewer",
      password: "oldpassword",
    });

    const res = await request(app)
      .patch(`/api/users/${viewer._id}`)
      .set(authed())
      .send({ password: "brandnewpassword" });
    expect(res.status).toBe(200);

    const login = await request(app).post("/api/auth/login").send({
      username: "forgetful",
      password: "brandnewpassword",
    });
    expect(login.status).toBe(200);
  });
});
