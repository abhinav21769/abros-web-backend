const IST = "Asia/Kolkata";

const QUARTER_LABELS = {
  1: "Q1 (Apr – Jun)",
  2: "Q2 (Jul – Sep)",
  3: "Q3 (Oct – Dec)",
  4: "Q4 (Jan – Mar)",
};

const getIstCalendarParts = (value = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(value);

  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
};

const pad = (value) => String(value).padStart(2, "0");

const lastDayOfMonth = (year, month) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const toIstStartOfDay = (year, month, day) =>
  new Date(`${year}-${pad(month)}-${pad(day)}T00:00:00+05:30`);

const toIstEndOfDay = (year, month, day) =>
  new Date(`${year}-${pad(month)}-${pad(day)}T23:59:59.999+05:30`);

const getFinancialYearStart = (date = new Date()) => {
  const { year, month } = getIstCalendarParts(date);
  return month >= 4 ? year : year - 1;
};

const getCurrentQuarter = (date = new Date()) => {
  const { month } = getIstCalendarParts(date);
  if (month >= 4 && month <= 6) return 1;
  if (month >= 7 && month <= 9) return 2;
  if (month >= 10 && month <= 12) return 3;
  return 4;
};

const getQuarterDateRange = (financialYear, quarter) => {
  const fy = Number(financialYear);
  const q = Number(quarter);

  if (!Number.isInteger(fy) || fy < 2000) {
    throw new Error("Invalid financial year");
  }
  if (!Number.isInteger(q) || q < 1 || q > 4) {
    throw new Error("Invalid quarter");
  }

  const ranges = {
    1: { startYear: fy, startMonth: 4, endYear: fy, endMonth: 6 },
    2: { startYear: fy, startMonth: 7, endYear: fy, endMonth: 9 },
    3: { startYear: fy, startMonth: 10, endYear: fy, endMonth: 12 },
    4: { startYear: fy + 1, startMonth: 1, endYear: fy + 1, endMonth: 3 },
  };

  const range = ranges[q];
  const from = toIstStartOfDay(range.startYear, range.startMonth, 1);
  const to = toIstEndOfDay(
    range.endYear,
    range.endMonth,
    lastDayOfMonth(range.endYear, range.endMonth),
  );

  const fyLabel = `FY ${fy}-${String(fy + 1).slice(-2)}`;

  return {
    from,
    to,
    financialYear: fy,
    quarter: q,
    label: `${QUARTER_LABELS[q]}, ${fyLabel}`,
    fromDate: `${range.startYear}-${pad(range.startMonth)}-01`,
    toDate: `${range.endYear}-${pad(range.endMonth)}-${pad(lastDayOfMonth(range.endYear, range.endMonth))}`,
  };
};

module.exports = {
  QUARTER_LABELS,
  getFinancialYearStart,
  getCurrentQuarter,
  getQuarterDateRange,
};
