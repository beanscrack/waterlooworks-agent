import type { Page } from "playwright";
import { SelectorError } from "../errors.js";
import { clean, parseDate, stripIcons, valueAfterLabel } from "./pageUtils.js";
import { sel, DOC_LABELS } from "./selectors.js";
import type { DocumentType } from "../models/index.js";

export interface PostingInfo {
  jobId: string;
  title: string;
  employer: string;
  division?: string;
  deadline?: Date;
  /** WaterlooWorks labels, e.g. "Résumé", "Grade Report". */
  requiredDocLabels: string[];
  requiredDocTypes: DocumentType[];
  additionalInfo?: string;
  /** Every posting field the panel rendered, keyed by its WaterlooWorks label. */
  sections: Record<string, string>;
}

/** The in-page posting overlay opened from either the applications viewer or job search. */
export class PostingPanel {
  constructor(private page: Page) {}

  async waitFor(): Promise<void> {
    await this.page.locator(sel.posting.header).first().waitFor({ state: "visible", timeout: 20_000 });
    await this.page.waitForTimeout(800);
  }

  /**
   * Every posting field, keyed by its WaterlooWorks label. Read from the label/value containers
   * the page renders rather than by splitting text, so an employer heading inside a description
   * ("About the role:") can never be mistaken for a field boundary, and fields we have never seen
   * are captured too.
   */
  async readSections(): Promise<Record<string, string>> {
    const fields = this.page.locator(sel.posting.field);
    const n = await fields.count();
    if (n === 0) throw new SelectorError("Posting panel has no label/value fields.");
    const out: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      const field = fields.nth(i);
      const label = clean(await field.locator(sel.posting.fieldLabel).first().innerText().catch(() => "")).replace(/:$/, "");
      if (!label) continue;
      // The whole container minus its label line: employers mix <p> lead-ins with <ul> bullets
      // ("You will:" followed by a list), and reading only the paragraphs drops the list.
      const body = stripLabel(await field.innerText(), label)
        .split("\n")
        .map((l) => l.trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      // A label can repeat (overview vs. detail tab); keep the richest occurrence.
      if (body && body.length > (out[label]?.length ?? 0)) out[label] = body;
    }
    return out;
  }

  async read(): Promise<PostingInfo> {
    const header = this.page.locator(sel.posting.header).first();
    if ((await header.count()) === 0) throw new SelectorError("Posting panel header not found.");
    const headerText = stripIcons(await header.innerText());
    const m = headerText.match(/^(\d+)\s+(.*)$/);
    const jobId = m?.[1] ?? "";
    const title = clean(m?.[2] ?? (await this.page.locator(sel.posting.title).first().innerText().catch(() => "")));
    const orgLine = clean(await header.locator("xpath=following-sibling::div[1]").first().innerText().catch(() => ""));
    const [employer, division] = orgLine.split(/\s+-\s+/);
    const body = await this.page.locator("body").innerText();
    const deadline = parseDate(valueAfterLabel(body, sel.posting.deadlineLabel) ?? "");
    const sections = await this.readSections();
    const req = valueAfterLabel(body, sel.posting.requiredDocsLabel) ?? "";
    const requiredDocLabels = req.split(",").map(clean).filter(Boolean);
    const requiredDocTypes = requiredDocLabels
      .map((l) => DOC_LABELS.find((d) => d.label.toLowerCase() === l.toLowerCase())?.type)
      .filter((t): t is DocumentType => !!t);
    return {
      jobId,
      title,
      employer: clean(employer ?? ""),
      division: division ? clean(division) : undefined,
      deadline,
      requiredDocLabels,
      requiredDocTypes,
      additionalInfo: sections["Additional Application Information"] ?? valueAfterLabel(body, "Additional Application Information:"),
      sections,
    };
  }

  async close(): Promise<void> {
    await this.page.keyboard.press("Escape").catch(() => {});
    await this.page.waitForTimeout(300);
  }
}

/** Container innerText starts with the label line; drop it to leave the value. */
function stripLabel(text: string, label: string): string {
  const t = text.trimStart();
  for (const prefix of [`${label}:`, label]) {
    if (t.startsWith(prefix)) return t.slice(prefix.length);
  }
  return t;
}
