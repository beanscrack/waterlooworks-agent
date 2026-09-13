import type { Page } from "playwright";
import { SelectorError, UnknownStateError } from "../errors.js";
import type { ApplicationStatus } from "../models/index.js";
import { clean, findColumn, parseDate, settle, stripIcons } from "./pageUtils.js";
import { PostingPanel, type PostingInfo } from "./PostingPanel.js";
import { routes, sel } from "./selectors.js";

export interface AppRow {
  jobId: string;
  title: string;
  employer?: string;
  appStatusText: string;
  status: ApplicationStatus;
  jobStatusText?: string;
  term?: string;
  location?: string;
  city?: string;
  deadline?: Date;
  submittedAt?: Date;
  hasCancelButton: boolean;
  index: number;
  /** Which "Status of Applications" view this row came from. */
  statusLabel?: string;
}

export class ApplicationsPage {
  constructor(private page: Page, private baseUrl: string) {}

  async open(): Promise<void> {
    await this.page.goto(new URL(routes.applications, this.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await settle(this.page);
  }

  /** "Status of Applications" summary rows, e.g. [{label:"Applied", count:42}]. */
  async statuses(): Promise<{ label: string; count: number }[]> {
    const rows = this.page.locator(sel.stat.row);
    const n = await rows.count();
    const out: { label: string; count: number }[] = [];
    for (let i = 0; i < n; i++) {
      const cells = (await rows.nth(i).locator("td").allInnerTexts()).map(clean);
      if (cells.length >= 2 && /^\d+$/.test(cells[1]) && (await rows.nth(i).locator('a:has-text("View")').count()))
        out.push({ label: cells[0], count: Number(cells[1]) });
    }
    return out;
  }

  async openStatus(label: string): Promise<void> {
    const link = this.page.locator(sel.stat.viewLink(label)).first();
    if ((await link.count()) === 0) throw new SelectorError(`Applications status "${label}" has no View link.`);
    await link.click();
    await settle(this.page, 1500);
    await this.page.locator(sel.viewer.table).first().waitFor({ state: "visible", timeout: 20_000 });
  }

  async readRows(): Promise<AppRow[]> {
    const headers = (await this.page.locator(sel.viewer.headers).allInnerTexts()).map(stripIcons);
    const ci = {
      title: findColumn(headers, [/^job title/i]),
      jobId: findColumn(headers, [/^job id/i]),
      term: findColumn(headers, [/^term/i]),
      employer: findColumn(headers, [/^organization/i]),
      appStatus: findColumn(headers, [/^app status/i]),
      jobStatus: findColumn(headers, [/^job status/i]),
      location: findColumn(headers, [/^location/i]),
      city: findColumn(headers, [/^city/i]),
      deadline: findColumn(headers, [/^app deadline/i]),
      submitted: findColumn(headers, [/^app submitted on/i]),
    };
    if (ci.jobId < 0 || ci.title < 0) throw new SelectorError(`Applications viewer headers unexpected: ${headers.join(" | ")}`);
    const raw = await this.page.locator(sel.viewer.rows).evaluateAll((rows, args) =>
      rows.map((row, index) => ({
        index,
        cells: [...row.querySelectorAll("th, td")].map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()),
        title: (row.querySelector(args.titleLink)?.textContent ?? "").replace(/\s+/g, " ").trim(),
        hasCancel: !!row.querySelector(args.cancelBtn),
      })),
    { titleLink: sel.viewer.titleLink, cancelBtn: sel.viewer.button(sel.viewer.cancelLabel) });
    const out: AppRow[] = [];
    for (const r of raw) {
      const jobId = r.cells[ci.jobId];
      if (!/^\d+$/.test(jobId ?? "")) continue;
      const appStatusText = ci.appStatus >= 0 ? r.cells[ci.appStatus] : "";
      out.push({
        jobId,
        title: r.title || stripIcons(r.cells[ci.title] ?? ""),
        employer: ci.employer >= 0 ? r.cells[ci.employer] : undefined,
        appStatusText,
        status: parseStatus(appStatusText),
        jobStatusText: ci.jobStatus >= 0 ? r.cells[ci.jobStatus] : undefined,
        term: ci.term >= 0 ? r.cells[ci.term] : undefined,
        location: ci.location >= 0 ? r.cells[ci.location] : undefined,
        city: ci.city >= 0 ? r.cells[ci.city] : undefined,
        deadline: ci.deadline >= 0 ? parseDate(r.cells[ci.deadline]) : undefined,
        submittedAt: ci.submitted >= 0 ? parseDate(r.cells[ci.submitted]) : undefined,
        hasCancelButton: r.hasCancel,
        index: r.index,
      });
    }
    return out;
  }

  /** All applications across every status view, de-duplicated by job (latest submission wins). */
  async listAll(): Promise<AppRow[]> {
    await this.open();
    const statuses = await this.statuses();
    const byJob = new Map<string, AppRow>();
    for (const s of statuses) {
      await this.open();
      await this.openStatus(s.label);
      for (const r of await this.readRows()) {
        r.statusLabel = s.label;
        const prev = byJob.get(r.jobId);
        if (!prev || (r.submittedAt?.getTime() ?? 0) >= (prev.submittedAt?.getTime() ?? 0)) byJob.set(r.jobId, r);
      }
    }
    return [...byJob.values()];
  }

  private async rowForJob(jobId: string) {
    const match = (await this.readRows()).find((r) => r.jobId === jobId);
    if (!match) throw new SelectorError(`No viewer row for job ${jobId}.`);
    return this.page.locator(sel.viewer.rows).nth(match.index);
  }

  /** Open the posting overlay for a job in the currently displayed viewer. */
  async openPosting(jobId: string): Promise<PostingInfo> {
    const row = await this.rowForJob(jobId);
    await row.locator(sel.viewer.titleLink).first().click();
    const panel = new PostingPanel(this.page);
    await panel.waitFor();
    const info = await panel.read();
    await panel.close();
    return info;
  }

  /** Cancel via the row button + confirmation modal. Caller must re-read state afterwards. */
  async cancel(jobId: string): Promise<void> {
    const row = await this.rowForJob(jobId);
    const btn = row.locator(sel.viewer.button(sel.viewer.cancelLabel)).first();
    if ((await btn.count()) === 0) throw new SelectorError(`Job ${jobId}: no "Cancel Application" button; refusing to guess.`);
    await btn.click();
    const modal = this.page.locator(sel.confirmModal.visible).first();
    await modal.waitFor({ state: "visible", timeout: 10_000 });
    const text = clean(await modal.innerText());
    if (!sel.confirmModal.deleteText.test(text)) {
      await this.page.keyboard.press("Escape");
      throw new UnknownStateError(`Unexpected confirmation dialog text: "${text.slice(0, 120)}"`);
    }
    await this.page.locator(sel.confirmModal.ok).first().click();
    await settle(this.page, 2000);
  }
}

export function parseStatus(text: string): ApplicationStatus {
  const t = text.toLowerCase();
  if (!t) return "unknown";
  if (/cancel|withdraw|deleted/.test(t)) return "cancelled";
  if (/expired|not selected|unsuccessful|closed|filled/.test(t)) return "expired";
  if (/applied|submitted|selected|interview|ranked|employed|offer|screen|viewed/.test(t)) return "submitted";
  return "unknown";
}
