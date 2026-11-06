const {
  answerChoice,
  applyInterpretation,
  createDraft,
  draftFromInvoice,
  draftProblems,
  draftToCreatePayload,
  draftToUpdatePayload,
  formatDraft,
  sanitizeInterpretation,
} = require("../../src/services/billDraft.service");

const catalog = {
  customers: [
    { _id: "c1", name: "Rishi Gautam", address: "Ambala" },
    { _id: "c2", name: "Sharma Medical", address: "Karnal" },
  ],
  medicines: [
    { _id: "m1", name: "Rosmont 10", ptr: 40, gstRate: 12, quantity: 100 },
    { _id: "m2", name: "Rosmont 20", ptr: 45, gstRate: 12, quantity: 100 },
    { _id: "m3", name: "Dolo 650", ptr: 21, gstRate: 5, quantity: 3 },
    { _id: "m4", name: "No Price Tonic", quantity: 10 },
  ],
};

const interpret = (raw) => sanitizeInterpretation(raw);

describe("billDraft", () => {
  describe("sanitizeInterpretation", () => {
    it("clamps and coerces whatever the AI returned", () => {
      const result = interpret({
        intent: "create",
        customerName: "  rishi  ",
        items: [
          { medicineName: "dolo", quantity: "5.4", discount: 250, rate: -3, free: "x" },
          { medicineName: "" },
        ],
      });
      expect(result.customerName).toBe("rishi");
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        quantity: 5,
        discount: 100,
        rate: 0,
        free: null,
      });
    });

    it("treats an unknown intent as 'other'", () => {
      expect(interpret({ intent: "launch missiles" }).intent).toBe("other");
    });
  });

  describe("creating", () => {
    it("builds a draft from a clear instruction", () => {
      const draft = applyInterpretation(
        createDraft(),
        interpret({
          intent: "create",
          customerName: "rishi gautam",
          items: [{ medicineName: "rosmont 20", quantity: 20 }],
        }),
        catalog,
      );

      expect(draft.customer).toMatchObject({ id: "c1", name: "Rishi Gautam" });
      expect(draft.items).toHaveLength(1);
      expect(draft.items[0]).toMatchObject({
        name: "Rosmont 20",
        quantity: 20,
        rate: 45,
        rateGuessed: true,
      });
      expect(draftProblems(draft)).toEqual([]);
      expect(draftToCreatePayload(draft, "c1")).toMatchObject({
        invoiceType: "sale",
        customer: "c1",
        paymentType: "cash",
        status: "paid",
      });
    });

    it("asks which strength instead of guessing", () => {
      const draft = applyInterpretation(
        createDraft(),
        interpret({
          customerName: "rishi gautam",
          items: [{ medicineName: "rosmont", quantity: 20 }],
        }),
        catalog,
      );

      expect(draft.items).toHaveLength(0);
      expect(draft.choices).toHaveLength(1);
      expect(draftProblems(draft)).toContain("Answer the question above first.");

      answerChoice(draft, "1", catalog);
      expect(draft.items[0]).toMatchObject({ name: "Rosmont 20", quantity: 20 });
      expect(draft.choices).toHaveLength(0);
    });

    it("never silently invents a customer", () => {
      const draft = applyInterpretation(
        createDraft(),
        interpret({ customerName: "Zorro Chemists", items: [{ medicineName: "dolo", quantity: 1 }] }),
        catalog,
      );

      expect(draft.customer).toBeNull();
      expect(draft.choices[0]).toMatchObject({ kind: "customer", candidates: [] });

      answerChoice(draft, "new", catalog);
      expect(draft.customer).toMatchObject({ id: null, name: "Zorro Chemists", isNew: true });
    });

    it("skips a medicine that is not in inventory and says so", () => {
      const draft = applyInterpretation(
        createDraft(),
        interpret({ customerName: "sharma", items: [{ medicineName: "zinc syrup", quantity: 2 }] }),
        catalog,
      );

      expect(draft.items).toHaveLength(0);
      expect(draft.notes.join(" ")).toMatch(/not in your inventory/);
    });

    it("blocks confirming a line that has no rate", () => {
      const draft = applyInterpretation(
        createDraft(),
        interpret({ customerName: "sharma", items: [{ medicineName: "no price tonic", quantity: 2 }] }),
        catalog,
      );

      expect(draftProblems(draft).join(" ")).toMatch(/No rate for No Price Tonic/);
    });

    it("warns when the quantity exceeds stock", () => {
      const draft = applyInterpretation(
        createDraft(),
        interpret({ customerName: "sharma", items: [{ medicineName: "dolo", quantity: 10 }] }),
        catalog,
      );
      expect(formatDraft(draft)).toMatch(/only 3 in stock/);
    });

    it("sets credit bills to pending", () => {
      const draft = applyInterpretation(
        createDraft(),
        interpret({
          customerName: "sharma",
          paymentType: "credit",
          items: [{ medicineName: "dolo", quantity: 1 }],
        }),
        catalog,
      );
      expect(draftToCreatePayload(draft, "c2").status).toBe("pending");
    });
  });

  describe("editing", () => {
    const makeDraft = () =>
      applyInterpretation(
        createDraft(),
        interpret({
          customerName: "rishi gautam",
          items: [
            { medicineName: "rosmont 20", quantity: 20 },
            { medicineName: "dolo", quantity: 2 },
          ],
        }),
        catalog,
      );

    it("adds free units and a discount to one line", () => {
      const draft = makeDraft();
      applyInterpretation(
        draft,
        interpret({
          intent: "edit",
          updateItems: [{ target: "rosmont", free: 5, discount: 10 }],
        }),
        catalog,
      );
      expect(draft.items[0]).toMatchObject({ free: 5, discount: 10, quantity: 20 });
      expect(draft.items[1]).toMatchObject({ free: 0, discount: 0 });
    });

    it("applies a discount to every line with 'all'", () => {
      const draft = makeDraft();
      applyInterpretation(
        draft,
        interpret({ intent: "edit", updateItems: [{ target: "all", discount: 5 }] }),
        catalog,
      );
      expect(draft.items.map((i) => i.discount)).toEqual([5, 5]);
    });

    it("addresses a line by number", () => {
      const draft = makeDraft();
      applyInterpretation(
        draft,
        interpret({ intent: "edit", updateItems: [{ target: "#2", quantity: 3 }] }),
        catalog,
      );
      expect(draft.items[1].quantity).toBe(3);
    });

    it("removes a line and reports it", () => {
      const draft = makeDraft();
      applyInterpretation(draft, interpret({ intent: "edit", removeItems: ["dolo"] }), catalog);
      expect(draft.items.map((i) => i.name)).toEqual(["Rosmont 20"]);
      expect(draft.removed).toEqual(["Dolo 650"]);
    });

    it("adds quantity to an existing line instead of duplicating it", () => {
      const draft = makeDraft();
      applyInterpretation(
        draft,
        interpret({ intent: "edit", addItems: [{ medicineName: "rosmont 20", quantity: 5 }] }),
        catalog,
      );
      expect(draft.items).toHaveLength(2);
      expect(draft.items[0].quantity).toBe(25);
    });

    it("refuses an ambiguous target instead of changing the wrong line", () => {
      const draft = applyInterpretation(
        createDraft(),
        interpret({
          customerName: "sharma",
          items: [
            { medicineName: "rosmont 10", quantity: 1 },
            { medicineName: "rosmont 20", quantity: 1 },
          ],
        }),
        catalog,
      );
      applyInterpretation(
        draft,
        interpret({ intent: "edit", updateItems: [{ target: "rosmont", quantity: 9 }] }),
        catalog,
      );
      expect(draft.items.map((i) => i.quantity)).toEqual([1, 1]);
      expect(draft.notes.join(" ")).toMatch(/more than one line/);
    });
  });

  describe("editing a saved invoice", () => {
    const invoice = {
      _id: "inv1",
      invoiceNumber: "AH-2026-045",
      paymentType: "cash",
      customer: { _id: "c1", name: "Rishi Gautam", address: "Ambala" },
      items: [
        {
          medicine: { _id: "m2" },
          medicineName: "Rosmont 20",
          quantity: 20,
          free: 0,
          rate: 45,
          discount: 0,
          gstRate: 12,
          batchNumber: "B1",
          mrp: 60,
        },
      ],
    };

    it("keeps the batch on an unchanged line", () => {
      const draft = draftFromInvoice(invoice, catalog);
      applyInterpretation(
        draft,
        interpret({ intent: "edit", updateItems: [{ target: "rosmont", discount: 5 }] }),
        catalog,
      );
      const payload = draftToUpdatePayload(draft, "c1");
      expect(payload.items[0]).toMatchObject({ batchNumber: "B1", discount: 5 });
    });

    it("drops the batch when the quantity changes so FEFO can reallocate", () => {
      const draft = draftFromInvoice(invoice, catalog);
      applyInterpretation(
        draft,
        interpret({ intent: "edit", updateItems: [{ target: "rosmont", quantity: 30 }] }),
        catalog,
      );
      const payload = draftToUpdatePayload(draft, "c1");
      expect(payload.items[0].batchNumber).toBeUndefined();
      expect(formatDraft(draft)).toMatch(/qty was 20/);
    });

    it("moves a bill to pending when switched to credit", () => {
      const draft = draftFromInvoice(invoice, catalog);
      applyInterpretation(draft, interpret({ intent: "edit", paymentType: "credit" }), catalog);
      expect(draftToUpdatePayload(draft, "c1")).toMatchObject({
        paymentType: "credit",
        status: "pending",
      });
    });
  });
});
