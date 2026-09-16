const request = require("supertest");
const app = require("../../app");
const Invoice = require("../../src/models/invoice.model");
const Medicine = require("../../src/models/medicine.model");
const StockLedger = require("../../src/models/stockLedger.model");
const {
  createTestCompany,
  createTestUser,
  createTestCustomer,
  createTestMedicine,
} = require("./helpers");

// Two tenants sharing one deployment. Every check here is about what one of them
// can see or touch of the other's books.
describe("Tenant isolation", () => {
  let acme;
  let globex;
  let acmeToken;
  let globexToken;

  beforeEach(async () => {
    acme = await createTestCompany({ name: "Acme Pharma" });
    globex = await createTestCompany({ name: "Globex Pharma" });

    ({ token: acmeToken } = await createTestUser({
      company: acme,
      username: "acme_admin",
    }));
    ({ token: globexToken } = await createTestUser({
      company: globex,
      username: "globex_admin",
    }));
  });

  const authed = (token) => ({ Authorization: `Bearer ${token}` });

  test("lists only the caller's own customers", async () => {
    await createTestCustomer({ company: acme, name: "Acme Customer" });
    await createTestCustomer({ company: globex, name: "Globex Customer" });

    const res = await request(app)
      .get("/api/customers?limit=50")
      .set(authed(acmeToken));

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].name).toBe("Acme Customer");
    expect(res.body.data.pagination.totalItems).toBe(1);
  });

  test("lists only the caller's own medicines", async () => {
    await createTestMedicine({ company: acme, name: "Acme Paracetamol" });
    await createTestMedicine({ company: globex, name: "Globex Paracetamol" });

    const res = await request(app)
      .get("/api/medicines?limit=50")
      .set(authed(acmeToken));

    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].name).toBe("Acme Paracetamol");
  });

  test("cannot read another company's medicine by id", async () => {
    const medicine = await createTestMedicine({ company: globex });

    const res = await request(app)
      .get(`/api/medicines/${medicine._id}`)
      .set(authed(acmeToken));

    expect(res.status).toBe(404);
  });

  test("cannot update or delete another company's customer", async () => {
    const customer = await createTestCustomer({ company: globex });

    const update = await request(app)
      .put(`/api/customers/${customer._id}`)
      .set(authed(acmeToken))
      .send({ name: "Hijacked" });
    expect(update.status).toBe(404);

    const remove = await request(app)
      .delete(`/api/customers/${customer._id}`)
      .set(authed(acmeToken));
    expect(remove.status).toBe(404);

    const stillThere = await request(app)
      .get(`/api/customers/${customer._id}`)
      .set(authed(globexToken));
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.data.name).toBe(customer.name);
  });

  test("cannot bill against another company's stock", async () => {
    const ourCustomer = await createTestCustomer({ company: acme });
    const theirMedicine = await createTestMedicine({
      company: globex,
      batches: [
        {
          batchNumber: "THEIRS-01",
          expiryDate: new Date(Date.now() + 365 * 86400000),
          mrp: 100,
          rate: 80,
          ptr: 70,
          quantity: 50,
        },
      ],
    });

    const res = await request(app)
      .post("/api/invoices")
      .set(authed(acmeToken))
      .send({
        invoiceType: "sale",
        customer: ourCustomer._id,
        paymentType: "cash",
        items: [
          {
            medicine: theirMedicine._id,
            medicineName: theirMedicine.name,
            quantity: 5,
            rate: 80,
            gstRate: 5,
          },
        ],
      });

    expect(res.status).toBe(400);

    // Their stock is untouched and no invoice was filed either side.
    const untouched = await Medicine.findById(theirMedicine._id);
    expect(untouched.batches[0].quantity).toBe(50);
    expect(await Invoice.countDocuments()).toBe(0);
  });

  test("cannot bill to another company's customer", async () => {
    const theirCustomer = await createTestCustomer({ company: globex });
    const ourMedicine = await createTestMedicine({ company: acme });

    const res = await request(app)
      .post("/api/invoices")
      .set(authed(acmeToken))
      .send({
        invoiceType: "sale",
        customer: theirCustomer._id,
        paymentType: "cash",
        items: [
          {
            medicine: ourMedicine._id,
            medicineName: ourMedicine.name,
            quantity: 1,
            rate: 80,
            gstRate: 5,
          },
        ],
      });

    expect(res.status).toBe(404);
    expect(await Invoice.countDocuments()).toBe(0);
  });

  test("invoice numbers run per company, so both start at 001", async () => {
    const acmeCustomer = await createTestCustomer({ company: acme });
    const globexCustomer = await createTestCustomer({ company: globex });
    const acmeMedicine = await createTestMedicine({ company: acme });
    const globexMedicine = await createTestMedicine({ company: globex });

    const bill = (token, customer, medicine) =>
      request(app)
        .post("/api/invoices")
        .set(authed(token))
        .send({
          invoiceType: "sale",
          customer: customer._id,
          paymentType: "cash",
          items: [
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              quantity: 1,
              rate: 80,
              gstRate: 5,
            },
          ],
        });

    const first = await bill(acmeToken, acmeCustomer, acmeMedicine);
    const second = await bill(globexToken, globexCustomer, globexMedicine);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data.invoiceNumber).toBe(second.body.data.invoiceNumber);
  });

  test("dashboard, GST and ledger totals count only the caller's own data", async () => {
    const globexCustomer = await createTestCustomer({ company: globex });
    const globexMedicine = await createTestMedicine({ company: globex });

    await request(app)
      .post("/api/invoices")
      .set(authed(globexToken))
      .send({
        invoiceType: "sale",
        customer: globexCustomer._id,
        paymentType: "cash",
        items: [
          {
            medicine: globexMedicine._id,
            medicineName: globexMedicine.name,
            quantity: 2,
            rate: 100,
            gstRate: 5,
          },
        ],
      });

    const stats = await request(app)
      .get("/api/dashboard/stats")
      .set(authed(acmeToken));
    expect(stats.status).toBe(200);
    expect(stats.body.data.invoices.sales.stats.totalInvoices).toBe(0);
    expect(stats.body.data.customers.stats.totalCustomers).toBe(0);
    expect(stats.body.data.inventory.stats.totalStock).toBe(0);

    const gst = await request(app)
      .get("/api/gst/quarterly-summary")
      .set(authed(acmeToken));
    expect(gst.status).toBe(200);

    const ledger = await request(app).get("/api/ledger").set(authed(acmeToken));
    expect(ledger.body.data.items).toHaveLength(0);
    // The movement was recorded - just not on this tenant's ledger.
    expect(await StockLedger.countDocuments()).toBeGreaterThan(0);
  });

  test("a company is never taken from the request body", async () => {
    const res = await request(app)
      .post("/api/customers")
      .set(authed(acmeToken))
      .send({
        company: String(globex._id),
        name: "Planted Customer",
        address: "Somewhere",
      });

    expect(res.status).toBe(201);
    expect(String(res.body.data.company)).toBe(String(acme._id));
  });
});
