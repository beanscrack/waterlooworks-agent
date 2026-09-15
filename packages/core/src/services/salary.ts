/**
 * WaterlooWorks compensation text is free-form employer prose ("Competitive Salary: $60/hour",
 * "$15,000 for each 4-month term", "annualized salary of $57,000 - $60,000"). We extract the pay
 * figures and normalise them to an hourly rate purely so the spreadsheet can be sorted; the
 * verbatim text always travels with it.
 */

export type SalaryUnit = "hour" | "day" | "week" | "month" | "year" | "term";

export interface ParsedSalary {
  min?: number;
  max?: number;
  unit?: SalaryUnit;
  /** Length of the work term, when the figure covers a whole term ("$15,000 per 4-month term"). */
  termMonths?: number;
  currency?: "CAD" | "USD";
  /** `min`..`max` converted to an hourly rate at 40 h/week; midpoint when a range. */
  hourly?: number;
  /** The sentence the figures came from, for eyeballing a suspicious row. */
  evidence?: string;
}

const WEEKS_PER_MONTH = 52 / 12;
const HOURS_PER_WEEK = 40;

/** Hours in one pay period, at a 40 h week. */
function hoursIn(unit: SalaryUnit, termMonths = 4): number {
  switch (unit) {
    case "hour":
      return 1;
    case "day":
      return 8;
    case "week":
      return HOURS_PER_WEEK;
    case "month":
      return WEEKS_PER_MONTH * HOURS_PER_WEEK;
    case "year":
      return 52 * HOURS_PER_WEEK;
    case "term":
      return termMonths * WEEKS_PER_MONTH * HOURS_PER_WEEK;
  }
}

const UNIT_WORDS: [RegExp, SalaryUnit][] = [
  [/\b(?:per\s+|\/\s*|an\s+)?(?:hour|hr|hourly)\b/i, "hour"],
  [/\b(?:per\s+|\/\s*)?(?:day|daily|diem)\b/i, "day"],
  [/\b(?:per\s+|\/\s*)?(?:week|wk|weekly)\b/i, "week"],
  [/\b(?:per\s+|\/\s*)?(?:month|mo|monthly)\b/i, "month"],
  [/\b(?:per\s+|\/\s*)?(?:year|yr|annum|annual\w*)\b/i, "year"],
  [/\b(?:per\s+|\/\s*)?(?:work\s+)?term\b/i, "term"],
];

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, twelve: 12, sixteen: 16 };

/**
 * "4-month term", "the complete 4 month duration", "four-month work term" — here "month" states how
 * long the term is, not how often you are paid. The trailing "term"/"duration" is masked along with
 * it, or "pro-rated for the four-month term" reads as term pay and buries the "annualized" that
 * actually states the basis. Reading it as a pay period turns a term total into a
 * monthly rate and inflates it roughly fourfold, so these spans are masked out before we look for a
 * pay unit, and the term length they carry is kept.
 */
const DURATION =
  /\b(\d{1,2}|one|two|three|four|five|six|eight|twelve|sixteen)[\s-]*(month|week)s?(?:\s+(?:work\s+)?(?:term|duration|period|placement|contract|internship|co-?op))?/gi;

interface Duration {
  months?: number;
  /** The sentence with duration phrases blanked out, indices preserved. */
  masked: string;
}

function readDuration(sentence: string): Duration {
  let months: number | undefined;
  const masked = sentence.replace(DURATION, (match, count: string, unit: string) => {
    const n = /^\d+$/.test(count) ? Number(count) : NUMBER_WORDS[count.toLowerCase()];
    if (n !== undefined && unit.toLowerCase() === "month" && months === undefined) months = n;
    if (n !== undefined && unit.toLowerCase() === "week" && months === undefined) months = n / WEEKS_PER_MONTH;
    return " ".repeat(match.length);
  });
  return { months, masked };
}

const num = (s: string) => Number(s.replace(/[,\s$]/g, ""));

/** A money figure: $60, 8,000, $9.5k, $200K. */
const MONEY = String.raw`\$?\s*\d[\d,]*(?:\.\d+)?\s*[kK]?`;
const RANGE = new RegExp(String.raw`(${MONEY})\s*(?:-|–|—|to)\s*(${MONEY})`, "g");
const SINGLE = new RegExp(`(${MONEY})`, "g");

function scale(raw: string): number {
  const v = num(raw.replace(/[kK]\s*$/, ""));
  return /[kK]\s*$/.test(raw) ? v * 1000 : v;
}

/**
 * The unit attached to a figure is the *closest* unit word, not the first one we happen to test:
 * "$2500 - $2850/month, for 35 hours of work per week" is monthly pay, and both words are in range.
 * Text after the figure wins ties, since "$60/hour" is the overwhelmingly common shape.
 */
function unitNear(masked: string, at: number): SalaryUnit | undefined {
  const WINDOW = 40;
  const after = masked.slice(at, at + WINDOW);
  const before = masked.slice(Math.max(0, at - WINDOW), at);
  let best: { unit: SalaryUnit; distance: number } | undefined;
  const consider = (unit: SalaryUnit, distance: number) => {
    if (!best || distance < best.distance) best = { unit, distance };
  };
  for (const [re, unit] of UNIT_WORDS) {
    const a = after.match(re);
    if (a?.index !== undefined) consider(unit, a.index);
    // Nearest occurrence behind the figure is the last one in the preceding window.
    const b = [...before.matchAll(new RegExp(re.source, re.flags + "g"))].pop();
    if (b?.index !== undefined) consider(unit, before.length - b.index + 0.5);
  }
  return best?.unit;
}

/** Only figures that look like pay; filters out "401(k) 4% match", "2027", phone numbers. */
function plausible(v: number, unit: SalaryUnit | undefined, termMonths = 4): boolean {
  if (!Number.isFinite(v) || v <= 0 || !unit) return false;
  const perHour = v / hoursIn(unit, termMonths);
  // A co-op rate below minimum wage or above a few hundred an hour is a misparse, not a salary.
  return perHour >= 12 && perHour <= 400;
}

/** Sentences describing food, parking or gym perks carry dollar figures that are not pay. */
const PERK = /\b(lunch|meal|food|snack|parking|transit|uber|gym|equinox|membership|discount|wellness|phone|internet|relocation|housing|travel|conference|learning budget)\b/i;
const PAY_LABEL = /\b(salary|salaries|wage|pay|paid|compensation|rate|stipend|earn|remuneration)\b/i;

export function parseSalary(text: string | undefined): ParsedSalary {
  if (!text) return {};
  const currency = /\bUSD\b|\bUS\$/i.test(text) ? "USD" : /\bCAD\b|\bC\$/i.test(text) ? "CAD" : undefined;
  const candidates: (ParsedSalary & { labelled: boolean })[] = [];

  for (const sentence of text.split(/\n|(?<=[.;])\s+/)) {
    if (!/\d/.test(sentence) || !/\$|salary|wage|pay|rate|compensation|stipend/i.test(sentence)) continue;
    const labelled = PAY_LABEL.test(sentence);
    // A perk line only counts if it also names pay ("Salary: $X" beside "free lunch").
    if (PERK.test(sentence) && !labelled) continue;

    const { months, masked } = readDuration(sentence);
    const termMonths = months ?? 4;
    const add = (min: number, max: number, unit: SalaryUnit | undefined) => {
      if (!plausible(min, unit, termMonths) || !plausible(max, unit, termMonths)) return false;
      candidates.push({
        min: Math.min(min, max),
        max: Math.max(min, max),
        unit,
        termMonths: unit === "term" ? termMonths : undefined,
        currency,
        labelled,
        evidence: sentence.trim(),
      });
      return true;
    };
    /** A lump sum quoted against a term length is term pay, not a rate. */
    const unitFor = (at: number): SalaryUnit | undefined => unitNear(masked, at) ?? (months !== undefined ? "term" : undefined);

    RANGE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let matchedRange = false;
    while ((m = RANGE.exec(sentence))) {
      if (add(scale(m[1]), scale(m[2]), unitFor(m.index + m[0].length))) matchedRange = true;
    }
    if (matchedRange) continue;
    SINGLE.lastIndex = 0;
    while ((m = SINGLE.exec(sentence))) {
      if (!m[1].includes("$") && !labelled) continue;
      const v = scale(m[1]);
      add(v, v, unitFor(m.index + m[0].length));
    }
  }

  if (!candidates.length) return { currency };
  // An explicitly labelled figure ("Salary: …") beats an unlabelled one; among equals, the largest,
  // since employers quote the base rate alongside smaller allowances.
  const best = candidates.sort((a, b) => Number(b.labelled) - Number(a.labelled) || hourlyOf(b) - hourlyOf(a))[0];
  const { labelled: _labelled, ...salary } = best;
  return { ...salary, hourly: hourlyOf(best) || undefined };
}

function hourlyOf(s: ParsedSalary): number {
  if (!s.unit || s.min === undefined) return 0;
  const mid = (s.min + (s.max ?? s.min)) / 2;
  return Math.round((mid / hoursIn(s.unit, s.termMonths)) * 100) / 100;
}

export function formatSalary(s: ParsedSalary): string {
  if (s.min === undefined || !s.unit) return "";
  const money = (v: number) => `$${v.toLocaleString("en-CA", { maximumFractionDigits: 2 })}`;
  const range = s.max !== undefined && s.max !== s.min ? `${money(s.min)}–${money(s.max)}` : money(s.min);
  const unit = s.unit === "term" ? `${s.termMonths ?? 4}-month term` : s.unit;
  return `${range}/${unit}${s.currency ? ` ${s.currency}` : ""}`;
}
