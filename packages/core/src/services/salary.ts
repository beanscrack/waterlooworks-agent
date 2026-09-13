/**
 * WaterlooWorks compensation text is free-form employer prose ("Competitive Salary: $60/hour",
 * "$8,000 - $9,500 CAD per month"). We extract the pay figures and normalise them to an hourly
 * rate purely so the spreadsheet can be sorted; the verbatim text always travels with it.
 */

export type SalaryUnit = "hour" | "day" | "week" | "month" | "year" | "term";

export interface ParsedSalary {
  min?: number;
  max?: number;
  unit?: SalaryUnit;
  currency?: "CAD" | "USD";
  /** `min`..`max` converted to an hourly rate at 40 h/week; midpoint when a range. */
  hourly?: number;
  /** The sentence the figures came from, for eyeballing a suspicious row. */
  evidence?: string;
}

/** Hours in each pay period, at a 40 h week — the co-op norm. */
const HOURS: Record<SalaryUnit, number> = {
  hour: 1,
  day: 8,
  week: 40,
  month: (40 * 52) / 12,
  year: 40 * 52,
  term: 40 * 17, // a 4-month work term
};

const UNIT_WORDS: [RegExp, SalaryUnit][] = [
  [/\b(?:per\s+|\/\s*|an\s+)?(?:hour|hr|hourly)\b/i, "hour"],
  [/\b(?:per\s+|\/\s*)?(?:day|daily|diem)\b/i, "day"],
  [/\b(?:per\s+|\/\s*)?(?:week|wk|weekly)\b/i, "week"],
  [/\b(?:per\s+|\/\s*)?(?:month|mo|monthly)\b/i, "month"],
  [/\b(?:per\s+|\/\s*)?(?:year|yr|annum|annual(?:ly)?)\b/i, "year"],
  [/\b(?:per\s+|\/\s*)?(?:work\s+)?term\b/i, "term"],
];

const num = (s: string) => Number(s.replace(/[,\s$]/g, ""));

/** A money figure: $60, 8,000, $9.5k. */
const MONEY = String.raw`\$?\s*\d[\d,]*(?:\.\d+)?\s*[kK]?`;
const RANGE = new RegExp(String.raw`(${MONEY})\s*(?:-|–|—|to)\s*(${MONEY})`, "g");
const SINGLE = new RegExp(`(${MONEY})`, "g");

function scale(raw: string): number {
  const v = num(raw.replace(/[kK]$/, ""));
  return /[kK]\s*$/.test(raw) ? v * 1000 : v;
}

function unitNear(text: string, at: number): SalaryUnit | undefined {
  // The unit almost always follows the figure ("$60/hour"); look ahead first, then just behind.
  const after = text.slice(at, at + 40);
  const before = text.slice(Math.max(0, at - 40), at);
  for (const [re, unit] of UNIT_WORDS) if (re.test(after)) return unit;
  for (const [re, unit] of UNIT_WORDS) if (re.test(before)) return unit;
  return undefined;
}

/** Only figures that look like pay; filters out "401(k) 4% match", "2027", phone numbers. */
function plausible(v: number, unit: SalaryUnit | undefined): boolean {
  if (!Number.isFinite(v) || v <= 0) return false;
  switch (unit) {
    case "hour":
      return v >= 10 && v <= 500;
    case "day":
      return v >= 50 && v <= 3000;
    case "week":
      return v >= 200 && v <= 20000;
    case "month":
      return v >= 800 && v <= 80000;
    case "term":
      return v >= 3000 && v <= 300000;
    case "year":
      return v >= 10000 && v <= 1000000;
    default:
      return false;
  }
}

export function parseSalary(text: string | undefined): ParsedSalary {
  if (!text) return {};
  const currency = /\bUSD\b|\bUS\$/i.test(text) ? "USD" : /\bCAD\b|\bC\$/i.test(text) ? "CAD" : undefined;
  const sentences = text.split(/\n|(?<=[.;])\s+/).filter((s) => /\d/.test(s) && /\$|salary|wage|pay|rate|compensation|stipend/i.test(s));
  const candidates: ParsedSalary[] = [];

  for (const s of sentences) {
    RANGE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let matchedRange = false;
    while ((m = RANGE.exec(s))) {
      const unit = unitNear(s, m.index + m[0].length);
      const lo = scale(m[1]);
      const hi = scale(m[2]);
      if (plausible(lo, unit) && plausible(hi, unit)) {
        candidates.push({ min: Math.min(lo, hi), max: Math.max(lo, hi), unit, currency, evidence: s.trim() });
        matchedRange = true;
      }
    }
    if (matchedRange) continue;
    SINGLE.lastIndex = 0;
    while ((m = SINGLE.exec(s))) {
      if (!m[1].includes("$") && !/salary|wage|pay|rate|stipend/i.test(s)) continue;
      const unit = unitNear(s, m.index + m[0].length);
      const v = scale(m[1]);
      if (plausible(v, unit)) candidates.push({ min: v, max: v, unit, currency, evidence: s.trim() });
    }
  }

  if (!candidates.length) return { currency, evidence: undefined };
  // Prefer the highest figure: employers list the base rate alongside smaller perks and stipends.
  const best = candidates.sort((a, b) => hourlyOf(b) - hourlyOf(a))[0];
  return { ...best, hourly: hourlyOf(best) || undefined };
}

function hourlyOf(s: ParsedSalary): number {
  if (!s.unit || s.min === undefined) return 0;
  const mid = (s.min + (s.max ?? s.min)) / 2;
  return Math.round((mid / HOURS[s.unit]) * 100) / 100;
}

export function formatSalary(s: ParsedSalary): string {
  if (s.min === undefined || !s.unit) return "";
  const money = (v: number) => `$${v.toLocaleString("en-CA", { maximumFractionDigits: 2 })}`;
  const range = s.max !== undefined && s.max !== s.min ? `${money(s.min)}–${money(s.max)}` : money(s.min);
  return `${range}/${s.unit}${s.currency ? ` ${s.currency}` : ""}`;
}
