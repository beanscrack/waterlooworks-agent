import type { Locator, Page } from "playwright";

export const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Strip Material icon ligature names that Orbis renders as text inside headers/cells. */
export const stripIcons = (s: string) =>
  clean(s.replace(/\b(swap_vert|keyboard_arrow_(down|up|left|right)|fast_(rewind|forward)|preview|print|cancel|fiber_manual_record|create_new_folder|do_not_disturb|playlist_add)\b/g, " ").replace(/\(\d+\)/g, " "));

/** Parse Orbis dates: "Sep 17, 2026 9:00 AM", "September 09, 2026 @ 01:43 PM". */
export function parseDate(text: string): Date | undefined {
  const t = clean(text).replace(" @ ", " ");
  if (!t) return undefined;
  const d = new Date(t);
  return isNaN(d.getTime()) ? undefined : d;
}

export function findColumn(headers: string[], patterns: RegExp[]): number {
  for (const p of patterns) {
    const i = headers.findIndex((h) => p.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

export async function settle(page: Page, ms = 1200): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

export async function visibleCount(loc: Locator): Promise<number> {
  const n = await loc.count();
  let v = 0;
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) v++;
  return v;
}

/** Text that follows a label line in a block of innerText. */
export function valueAfterLabel(text: string, label: string): string | undefined {
  const lines = text.split("\n").map((l) => l.trim());
  const i = lines.findIndex((l) => l === label || l.startsWith(label));
  if (i < 0) return undefined;
  const inline = lines[i].slice(label.length).replace(/^:\s*/, "").trim();
  if (inline) return inline;
  for (let j = i + 1; j < lines.length; j++) if (lines[j]) return lines[j];
  return undefined;
}

export function inferDocumentType(label: string): "resume" | "cover_letter" | "transcript" | "work_history" | "other" {
  const l = label.toLowerCase();
  if (/r[eé]sum[eé]/.test(l)) return "resume";
  if (/cover/.test(l)) return "cover_letter";
  if (/grade report|transcript/.test(l)) return "transcript";
  if (/work history|work term/.test(l)) return "work_history";
  return "other";
}

/**
 * Split a posting's innerText into `label -> body` using a closed set of known field labels as
 * boundaries. Employer-written headings inside a section ("About the role:") are not boundaries,
 * so multi-paragraph descriptions survive intact.
 */
export function sectionsByLabel(text: string, labels: readonly string[]): Record<string, string> {
  const lines = text.split("\n").map((l) => l.trim());
  const isLabel = (l: string) => labels.find((k) => l === k || l === `${k}:`);
  const marks: { label: string; line: number }[] = [];
  lines.forEach((l, i) => {
    const k = isLabel(l);
    if (k) marks.push({ label: k, line: i });
  });
  const out: Record<string, string> = {};
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].line : lines.length;
    const body = lines
      .slice(m.line + 1, end)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    // A label can legitimately appear twice (e.g. in a sidebar); keep the richest occurrence.
    if (body && body.length > (out[m.label]?.length ?? 0)) out[m.label] = body;
  });
  return out;
}
