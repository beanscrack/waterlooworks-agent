import type { BrowserContext, Page } from "playwright";
import { SelectorError } from "../errors.js";
import { clean, findColumn, parseDate, settle, stripIcons } from "./pageUtils.js";
import { PostingPanel, type PostingInfo } from "./PostingPanel.js";
import { routes, sel } from "./selectors.js";

export interface JobSearchRow {
  jobId: string;
  title: string;
  employer?: string;
  city?: string;
  deadline?: Date;
  hasApplyButton: boolean;
  /** Present when the viewer shows an application status inline (e.g. "Applied"). */
  appliedHint: boolean;
}

export interface ListAllOptions {
  maxRows?: number;
  /** Invoked for each new row before the grid pages away from it. */
  onRow?: (row: JobSearchRow) => Promise<void>;
  onPage?: (seen: number, total?: number) => void;
}

export class JobsPage {
  constructor(private page: Page, private baseUrl: string) {}

  async open(): Promise<void> {
    await this.page.goto(new URL(routes.jobs, this.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await settle(this.page);
  }

  /** Keyword search accepts a job ID; returns the matching row or undefined. */
  async searchById(jobId: string): Promise<JobSearchRow | undefined> {
    const input = this.page.locator(sel.jobs.keyword).first();
    if ((await input.count()) === 0) throw new SelectorError("Job search keyword input not found.");
    await input.fill(jobId);
    await input.press("Enter");
    await settle(this.page, 2000);
    const headers = (await this.page.locator(sel.viewer.headers).allInnerTexts()).map(stripIcons);
    if (!headers.length) return undefined;
    const ci = {
      id: findColumn(headers, [/id$/i, /^select all id/i]),
      title: findColumn(headers, [/^job title/i]),
      employer: findColumn(headers, [/^organization/i]),
      city: findColumn(headers, [/^city/i]),
      deadline: findColumn(headers, [/^app deadline/i]),
    };
    const rows = this.page.locator(sel.viewer.rows);
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const text = clean(await row.innerText());
      if (!new RegExp(`\\b${jobId}\\b`).test(text)) continue;
      const cells = (await row.locator("th, td").allInnerTexts()).map(clean);
      return {
        jobId,
        title: clean(await row.locator(sel.viewer.titleLink).first().innerText().catch(() => stripIcons(cells[ci.title] ?? ""))),
        employer: ci.employer >= 0 ? cells[ci.employer] : undefined,
        city: ci.city >= 0 ? cells[ci.city] : undefined,
        deadline: ci.deadline >= 0 ? parseDate(cells[ci.deadline]) : undefined,
        hasApplyButton: (await row.locator(sel.viewer.button(sel.viewer.applyLabel)).count()) > 0,
        appliedHint: /\bApplied\b/.test(text),
      };
    }
    return undefined;
  }


  /** Turn the "My Program" quick-filter pill on (or off) and wait for the grid to reload. */
  async setMyProgramFilter(on: boolean): Promise<void> {
    const key = sel.jobs.myProgramKey;
    const pill = this.page.locator(sel.jobs.quickFilter(key)).first();
    if ((await pill.count()) === 0) throw new SelectorError('Job search "My Program" quick filter not found.');
    const isOn = async () => (await this.page.locator(sel.jobs.quickFilterOn(key)).count()) > 0;
    if ((await isOn()) === on) return;
    await pill.click();
    await settle(this.page, 2000);
    if ((await isOn()) !== on) {
      throw new SelectorError(`Job search "My Program" filter did not switch ${on ? "on" : "off"}.`);
    }
  }

  /** "1296 results" / "1 - 50" → total and the range currently shown. */
  private async pageRange(): Promise<{ total: number; from: number; to: number } | undefined> {
    const text = clean(await this.page.locator(sel.pagination.data).first().innerText().catch(() => ""));
    const total = text.match(/([\d,]+)\s+results/);
    const range = text.match(/([\d,]+)\s*-\s*([\d,]+)/);
    if (!total || !range) return undefined;
    const n = (s: string) => Number(s.replace(/,/g, ""));
    return { total: n(total[1]), from: n(range[1]), to: n(range[2]) };
  }

  /** Read every row on the current page of the results grid. */
  private async rowsOnPage(): Promise<JobSearchRow[]> {
    const headers = (await this.page.locator(sel.viewer.headers).allInnerTexts()).map(stripIcons);
    if (!headers.length) throw new SelectorError("Job search results table has no headers.");
    const ci = {
      id: findColumn(headers, [/^job id/i, /id$/i, /^select all id/i]),
      title: findColumn(headers, [/^job title/i]),
      employer: findColumn(headers, [/^organization/i]),
      city: findColumn(headers, [/^city/i]),
      deadline: findColumn(headers, [/^app deadline/i]),
    };
    if (ci.id < 0) throw new SelectorError("Job search results table has no ID column.");
    const rows = this.page.locator(sel.viewer.rows);
    const n = await rows.count();
    const out: JobSearchRow[] = [];
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const cells = (await row.locator("th, td").allInnerTexts()).map(clean);
      const jobId = stripIcons(cells[ci.id] ?? "").match(/\d{4,}/)?.[0];
      if (!jobId) continue;
      const text = clean(await row.innerText());
      out.push({
        jobId,
        title: clean(await row.locator(sel.viewer.titleLink).first().innerText().catch(() => stripIcons(cells[ci.title] ?? ""))),
        employer: ci.employer >= 0 ? cells[ci.employer] : undefined,
        city: ci.city >= 0 ? cells[ci.city] : undefined,
        deadline: ci.deadline >= 0 ? parseDate(cells[ci.deadline]) : undefined,
        hasApplyButton: (await row.locator(sel.viewer.button(sel.viewer.applyLabel)).count()) > 0,
        appliedHint: /\bApplied\b/.test(text),
      });
    }
    return out;
  }

  /**
   * Walk every page of the results grid. Stops when the reported range reaches the total, when a
   * page yields no new job IDs, or at `maxRows`.
   */
  async listAll(opts: ListAllOptions = {}): Promise<JobSearchRow[]> {
    const seen = new Map<string, JobSearchRow>();
    for (let page = 1; ; page++) {
      const before = seen.size;
      for (const r of await this.rowsOnPage()) {
        if (seen.has(r.jobId)) continue;
        seen.set(r.jobId, r);
        // Called while this row's page is still rendered, so the posting can be opened in place.
        if (opts.onRow) await opts.onRow(r);
        if (opts.maxRows && seen.size >= opts.maxRows) break;
      }
      const range = await this.pageRange();
      opts.onPage?.(seen.size, range?.total);
      if (seen.size === before) break;
      if (opts.maxRows && seen.size >= opts.maxRows) break;
      if (range && range.to >= range.total) break;
      const next = this.page.locator(sel.pagination.next).first();
      if ((await next.count()) === 0 || !(await next.isVisible().catch(() => false))) break;
      await next.click();
      await settle(this.page, 1500);
      if (page > 200) throw new SelectorError("Job search pagination did not terminate.");
    }
    const all = [...seen.values()];
    return opts.maxRows ? all.slice(0, opts.maxRows) : all;
  }

  async openPosting(jobId: string): Promise<PostingInfo> {
    const row = this.page.locator(sel.viewer.rows).filter({ hasText: jobId }).first();
    await row.locator(sel.viewer.titleLink).first().click();
    const panel = new PostingPanel(this.page);
    await panel.waitFor();
    const info = await panel.read();
    await panel.close();
    return info;
  }

  /** Click the row's Apply button; WaterlooWorks opens the wizard in a new tab. */
  async openApplyPopup(ctx: BrowserContext, jobId: string): Promise<Page> {
    const row = this.page.locator(sel.viewer.rows).filter({ hasText: jobId }).first();
    const btn = row.locator(sel.viewer.button(sel.viewer.applyLabel)).first();
    if ((await btn.count()) === 0) throw new SelectorError(`Job ${jobId}: no Apply button (already applied or closed).`);
    const [popup] = await Promise.all([ctx.waitForEvent("page", { timeout: 20_000 }), btn.click()]);
    await popup.waitForLoadState("domcontentloaded");
    await settle(popup, 2000);
    return popup;
  }
}
