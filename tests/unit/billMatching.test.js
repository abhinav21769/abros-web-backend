const { resolveEntity, scoreName } = require("../../src/services/billMatching.service");

const names = (list) => list.map((item) => item.name);
const customers = [
  { name: "Rishi Gautam Medical Store", address: "Ambala City" },
  { name: "Rishi Gautam", address: "Yamunanagar" },
  { name: "Rishi Kumar", address: "Ambala Cantt" },
  { name: "Sharma Medical Hall", address: "Karnal" },
];
const medicines = [
  { name: "Rosmont 10" },
  { name: "Rosmont 20" },
  { name: "Paracetamol 500" },
  { name: "Dolo 650" },
];

describe("billMatching", () => {
  describe("scoreName", () => {
    it("scores identical names 1 regardless of case and punctuation", () => {
      expect(scoreName("dolo-650", "Dolo 650")).toBe(1);
    });

    it("never treats different strengths as close", () => {
      expect(scoreName("rosmont 20", "Rosmont 10")).toBeLessThan(0.55);
    });

    it("tolerates a typo", () => {
      expect(scoreName("rosmount", "Rosmont")).toBeGreaterThan(0.55);
    });
  });

  describe("resolveEntity", () => {
    it("matches a unique name", () => {
      const result = resolveEntity("sharma", customers, (c) => c.name);
      expect(result.status).toBe("match");
      expect(result.match.name).toBe("Sharma Medical Hall");
    });

    it("does not match 'rishi gautam' to the wrong Rishi", () => {
      const result = resolveEntity("rishi gautam", customers, (c) => c.name);
      expect(names(result.candidates)).not.toContain("Rishi Kumar");
    });

    it("asks when two customers fit equally well", () => {
      const result = resolveEntity("rishi gautam", customers, (c) => c.name);
      // An exact name wins outright over the longer 'Medical Store' variant.
      expect(result.status).toBe("match");
      expect(result.match.name).toBe("Rishi Gautam");

      const either = resolveEntity("gautam", customers, (c) => c.name);
      expect(either.status).toBe("ambiguous");
      expect(names(either.candidates)).toEqual(
        expect.arrayContaining(["Rishi Gautam", "Rishi Gautam Medical Store"]),
      );
    });

    it("uses a location hint to break a tie", () => {
      const result = resolveEntity("gautam", customers, (c) => c.name, {
        hint: "ambala",
        getHint: (c) => c.address,
      });
      expect(result.status).toBe("match");
      expect(result.match.name).toBe("Rishi Gautam Medical Store");
    });

    it("asks which strength when the medicine name is not specific", () => {
      const result = resolveEntity("rosmont", medicines, (m) => m.name);
      expect(result.status).toBe("ambiguous");
      expect(names(result.candidates)).toEqual(["Rosmont 10", "Rosmont 20"]);
    });

    it("picks the exact strength when it is given", () => {
      const result = resolveEntity("rosmont 20", medicines, (m) => m.name);
      expect(result.status).toBe("match");
      expect(result.match.name).toBe("Rosmont 20");
    });

    it("flags a fuzzy match so the draft can say so", () => {
      const result = resolveEntity("paracetmol 500", medicines, (m) => m.name);
      expect(result.status).toBe("match");
      expect(result.match.name).toBe("Paracetamol 500");
      expect(result.fuzzy).toBe(true);
    });

    it("reports none rather than guessing", () => {
      const result = resolveEntity("zinc syrup", medicines, (m) => m.name);
      expect(result.status).toBe("none");
      expect(result.candidates).toEqual([]);
    });
  });
});
