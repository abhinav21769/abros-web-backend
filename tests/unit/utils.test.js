const { ERROR_CODES, sendSuccess, sendError } = require("../../src/utils/response");
const {
  DEFAULT_GST_RATE,
  normalizeGstRate,
  normalizeDiscount,
  buildInvoiceTotals,
  calculateInvoiceTaxBreakdown,
} = require("../../src/utils/invoiceTax");
const {
  QUARTER_LABELS,
  getFinancialYearStart,
  getCurrentQuarter,
  getQuarterDateRange,
} = require("../../src/utils/quarterUtils");

describe("Response Utilities", () => {
  let mockRes;

  beforeEach(() => {
    mockRes = {
      statusCode: 200,
      status: jest.fn().mockImplementation(function (code) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn().mockImplementation(function (data) {
        this.jsonData = data;
        return this;
      }),
    };
  });

  test("sendSuccess sends default 200 response", () => {
    sendSuccess(mockRes, { message: "Success message", data: { id: 1 } });
    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      message: "Success message",
      data: { id: 1 },
      error: null,
    });
  });

  test("sendSuccess supports custom status code", () => {
    sendSuccess(mockRes, { message: "Created", data: { id: 2 }, statusCode: 201 });
    expect(mockRes.status).toHaveBeenCalledWith(201);
  });

  test("sendError sends formatted error response", () => {
    sendError(mockRes, {
      message: "Item not found",
      code: ERROR_CODES.NOT_FOUND,
      statusCode: 404,
    });
    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      message: "Item not found",
      data: null,
      error: {
        code: ERROR_CODES.NOT_FOUND,
        message: "Item not found",
      },
    });
  });

  test("sendError defaults to 500 and INTERNAL_ERROR", () => {
    sendError(mockRes, { message: "Server error" });
    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      message: "Server error",
      data: null,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: "Server error",
      },
    });
  });
});

describe("Invoice Tax Calculations", () => {
  test("normalizeGstRate returns default rate for invalid values", () => {
    expect(normalizeGstRate(undefined)).toBe(DEFAULT_GST_RATE);
    expect(normalizeGstRate(-5)).toBe(DEFAULT_GST_RATE);
    expect(normalizeGstRate("invalid")).toBe(DEFAULT_GST_RATE);
    expect(normalizeGstRate(0)).toBe(0);
    expect(normalizeGstRate(12)).toBe(12);
  });

  test("normalizeDiscount restricts between 0 and 100", () => {
    expect(normalizeDiscount(-10)).toBe(0);
    expect(normalizeDiscount(150)).toBe(100);
    expect(normalizeDiscount(15)).toBe(15);
    expect(normalizeDiscount(null)).toBe(0);
  });

  test("buildInvoiceTotals calculates subtotal, cgst, sgst, and rounded total", () => {
    const items = [
      {
        medicineName: "Paracetamol",
        quantity: 10,
        rate: 100,
        discount: 10, // 10 * 100 = 1000 - 10% = 900
        gstRate: 12,  // 6% CGST (54), 6% SGST (54)
      },
      {
        medicineName: "Amoxicillin",
        quantity: 2,
        rate: 50,
        discount: 0,  // 100
        gstRate: 18,  // 9% CGST (9), 9% SGST (9)
      },
    ];

    const result = buildInvoiceTotals(items);

    expect(result.subtotal).toBe(1000); // 900 + 100
    // CGST: 54 + 9 = 63, SGST: 54 + 9 = 63
    // Exact total: 1000 + 63 + 63 = 1126
    expect(result.total).toBe(1126);
    expect(result.items.length).toBe(2);
    expect(result.items[0].amount).toBe(900);
    expect(result.items[1].amount).toBe(100);
  });

  test("calculateInvoiceTaxBreakdown returns accurate tax breakdown", () => {
    const items = [
      {
        quantity: 5,
        rate: 200,
        discount: 0,
        gstRate: 5, // 2.5% CGST (25), 2.5% SGST (25) -> GST 50
      },
    ];

    const breakdown = calculateInvoiceTaxBreakdown(items);
    expect(breakdown.subtotal).toBe(1000);
    expect(breakdown.cgst).toBe(25);
    expect(breakdown.sgst).toBe(25);
    expect(breakdown.gst).toBe(50);
    expect(breakdown.total).toBe(1050);
  });
});

describe("Quarter Utilities", () => {
  test("QUARTER_LABELS mapping", () => {
    expect(QUARTER_LABELS[1]).toBe("Q1 (Apr – Jun)");
    expect(QUARTER_LABELS[4]).toBe("Q4 (Jan – Mar)");
  });

  test("getFinancialYearStart returns correct year based on month", () => {
    const juneDate = new Date("2026-06-15T10:00:00Z");
    expect(getFinancialYearStart(juneDate)).toBe(2026);

    const febDate = new Date("2026-02-15T10:00:00Z");
    expect(getFinancialYearStart(febDate)).toBe(2025);
  });

  test("getCurrentQuarter returns correct quarter in financial year", () => {
    expect(getCurrentQuarter(new Date("2026-05-10"))).toBe(1);
    expect(getCurrentQuarter(new Date("2026-08-10"))).toBe(2);
    expect(getCurrentQuarter(new Date("2026-11-10"))).toBe(3);
    expect(getCurrentQuarter(new Date("2026-02-10"))).toBe(4);
  });

  test("getQuarterDateRange calculates valid date bounds", () => {
    const q1 = getQuarterDateRange(2026, 1);
    expect(q1.financialYear).toBe(2026);
    expect(q1.quarter).toBe(1);
    expect(q1.fromDate).toBe("2026-04-01");
    expect(q1.toDate).toBe("2026-06-30");

    const q4 = getQuarterDateRange(2026, 4);
    expect(q4.fromDate).toBe("2027-01-01");
    expect(q4.toDate).toBe("2027-03-31");
  });

  test("getQuarterDateRange throws on invalid input", () => {
    expect(() => getQuarterDateRange(1990, 1)).toThrow("Invalid financial year");
    expect(() => getQuarterDateRange(2026, 5)).toThrow("Invalid quarter");
  });
});
