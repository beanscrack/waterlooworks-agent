import type { Page } from "playwright";
import { SelectorError } from "../errors.js";
import { clean, parseDate, sectionsByLabel, stripIcons, valueAfterLabel } from "./pageUtils.js";
import { sel, DOC_LABELS, POSTING_LABELS } from "./selectors.js";
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
    const sections = sectionsByLabel(body, POSTING_LABELS);
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
