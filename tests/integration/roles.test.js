const request = require("supertest");
const app = require("../../app");
const Customer = require("../../src/models/customer.model");
const { createTestUser, createTestCustomer, createTestMedicine } = require("./helpers");

// A viewer may read everything in their own company and change nothing.
describe("Viewer role", () => {
  let viewerToken;
  let adminToken;
  let company;

  beforeEach(async () => {
    const admin = await createTestUser({ username: "role_admin", role: "admin" });
    adminToken = admin.token;
    company = admin.company;

    const viewer = await createTestUser({
      company,
      username: "role_viewer",
      role: "viewer",
    });
    viewerToken = viewer.token;
  });

  const asViewer = () => ({ Authorization: `Bearer ${viewerToken}` });
  const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });

  test("can read the company's data", async () => {
    await createTestCustomer({ company, name: "Readable Customer" });

    const customers = await request(app).get("/api/customers").set(asViewer());
    expect(customers.status).toBe(200);
    expect(customers.body.data.items).toHaveLength(1);

    const medicines = await request(app).get("/api/medicines").set(asViewer());
    expect(medicines.status).toBe(200);

    const dashboard = await request(app)
      .get("/api/dashboard/stats")
      .set(asViewer());
    expect(dashboard.status).toBe(200);
  });

  test("cannot create, update or delete customers", async () => {
    const customer = await createTestCustomer({ company });

    const create = await request(app)
      .post("/api/customers")
      .set(asViewer())
      .send({ name: "Nope", address: "Nowhere" });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe("FORBIDDEN");

    const update = await request(app)
      .put(`/api/customers/${customer._id}`)
      .set(asViewer())
      .send({ name: "Renamed" });
    expect(update.status).toBe(403);

    const remove = await request(app)
      .delete(`/api/customers/${customer._id}`)
      .set(asViewer());
    expect(remove.status).toBe(403);

    const unchanged = await Customer.findById(customer._id);
    expect(unchanged.name).toBe(customer.name);
  });

  test("cannot create medicines or invoices", async () => {
    const customer = await createTestCustomer({ company });
    const medicine = await createTestMedicine({ company });

    const newMedicine = await request(app)
      .post("/api/medicines")
      .set(asViewer())
      .send({ name: "Nope", packagingType: "1x1" });
    expect(newMedicine.status).toBe(403);

    const invoice = await request(app)
      .post("/api/invoices")
      .set(asViewer())
      .send({
        invoiceType: "sale",
        customer: customer._id,
        paymentType: "cash",
        items: [
          {
            medicine: medicine._id,
            medicineName: medicine.name,
            quantity: 1,
            rate: 10,
            gstRate: 5,
          },
        ],
      });
    expect(invoice.status).toBe(403);
  });

  test("cannot reach user management at all", async () => {
    const list = await request(app).get("/api/users").set(asViewer());
    expect(list.status).toBe(403);

    const create = await request(app)
      .post("/api/users")
      .set(asViewer())
      .send({ username: "sneaky", password: "password123" });
    expect(create.status).toBe(403);
  });

  test("can read the company profile but not change it", async () => {
    const read = await request(app).get("/api/company").set(asViewer());
    expect(read.status).toBe(200);
    expect(read.body.data.company.name).toBe(company.name);

    const write = await request(app)
      .put("/api/company")
      .set(asViewer())
      .send({ name: "Renamed By Viewer" });
    expect(write.status).toBe(403);
  });

  test("an admin on the same company can do all of it", async () => {
    const create = await request(app)
      .post("/api/customers")
      .set(asAdmin())
      .send({ name: "Admin Customer", address: "Somewhere" });
    expect(create.status).toBe(201);

    const profile = await request(app)
      .put("/api/company")
      .set(asAdmin())
      .send({ phone: "9876543210" });
    expect(profile.status).toBe(200);
    expect(profile.body.data.company.phone).toBe("9876543210");
  });

  test("a demoted admin loses write access without waiting for the token to expire", async () => {
    const target = await createTestUser({
      company,
      username: "soon_viewer",
      role: "admin",
    });

    // Warm the middleware's user cache with the admin role.
    const before = await request(app)
      .post("/api/customers")
      .set({ Authorization: `Bearer ${target.token}` })
      .send({ name: "Still Admin", address: "Somewhere" });
    expect(before.status).toBe(201);

    const demote = await request(app)
      .patch(`/api/users/${target.user._id}`)
      .set(asAdmin())
      .send({ role: "viewer" });
    expect(demote.status).toBe(200);

    const after = await request(app)
      .post("/api/customers")
      .set({ Authorization: `Bearer ${target.token}` })
      .send({ name: "No Longer Admin", address: "Somewhere" });
    expect(after.status).toBe(403);
  });
});
