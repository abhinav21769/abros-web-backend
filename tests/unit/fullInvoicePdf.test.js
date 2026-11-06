// The Telegram PDF must read the same as the one the UI downloads. These cases
// pin the places the two had drifted apart.

const jspdfModule = require("jspdf");
const QRCode = require("qrcode");

const drawn = [];
const BaseJsPdf = jspdfModule.jsPDF;

class SpyJsPdf extends BaseJsPdf {
  constructor(...args) {
    super(...args);
    const text = this.text.bind(this);
    this.text = (value, ...rest) => {
      drawn.push(Array.isArray(value) ? value.join("|") : String(value));
      return text(value, ...rest);
    };
  }
}

let originalToDataURL;
let buildInvoicePdf;

beforeAll(() => {
  jspdfModule.jsPDF = SpyJsPdf;
  originalToDataURL = QRCode.toDataURL;
  QRCode.toDataURL = async (uri) => {
    drawn.push(`QR:${uri}`);
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  };
  ({ buildInvoicePdf } = require("../../src/utils/fullInvoicePdf"));
});

afterAll(() => {
  jspdfModule.jsPDF = BaseJsPdf;
  QRCode.toDataURL = originalToDataURL;
});

beforeEach(() => {
  drawn.length = 0;
});

const invoice = {
  invoiceNumber: "AH-2026-045",
  invoiceType: "sale",
  status: "paid",
  paymentType: "cash",
  // IST midnight on 7 Nov 2026 - 6 Nov in UTC.
  invoiceDate: new Date("2026-11-07T00:00:00+05:30"),
  customer: { name: "Rishi Gautam", address: "Ambala City", contact: "9876543210" },
  items: [
    {
      medicine: { name: "Rosmont 20", packagingType: "10x10", manufacturer: "Rosmont Pharma", gstRate: 12 },
      medicineName: "Rosmont 20",
      batchNumber: "B1",
      expiryDate: new Date("2027-04-01T00:00:00+05:30"),
      mrp: 60,
      quantity: 20,
      free: 2,
      rate: 45.5,
      discount: 5,
      gstRate: 12,
      amount: 864.5,
    },
  ],
};

describe("fullInvoicePdf parity with the UI invoice", () => {
  it("prints dates in IST, not the server's timezone", async () => {
    await buildInvoicePdf(invoice);
    expect(drawn).toContain("07-11-26");
    expect(drawn).not.toContain("06-11-26");
    expect(drawn).toContain("04-27");
  });

  it("shows the line amount including GST", async () => {
    await buildInvoicePdf(invoice);
    // 864.50 taxable + 6% + 6% CGST/SGST
    expect(drawn).toContain("968.24");
    expect(drawn).not.toContain("864.50");
  });

  it("encodes the UPI request the same way the UI does", async () => {
    process.env.UPI_ID = "shop@bank";
    await buildInvoicePdf(invoice);
    delete process.env.UPI_ID;

    const qr = drawn.find((entry) => entry.startsWith("QR:"));
    expect(qr).toContain("pa=shop%40bank");
    expect(qr).toContain("am=968.00");
    expect(qr).toContain("tn=Invoice+AH-2026-045");
  });
});
