import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Logger } from "../logger.js";

export interface BrowserSessionOptions {
  profileDir: string;
  baseUrl: string;
  headless: boolean;
  log: Logger;
  timeoutMs?: number;
}

/**
 * Owns the persistent Chromium context (spec section 5). Login state lives in
 * `profileDir` and is never read back into application code.
 */
export class BrowserSession {
  private context?: BrowserContext;
  constructor(private opts: BrowserSessionOptions) {}

  get baseUrl() {
    return this.opts.baseUrl;
  }

  async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.opts.log.debug({ profileDir: this.opts.profileDir, headless: this.opts.headless }, "launching browser");
    this.context = await chromium.launchPersistentContext(this.opts.profileDir, {
      headless: this.opts.headless,
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    this.context.setDefaultTimeout(this.opts.timeoutMs ?? 20_000);
    await this.restoreState(this.context);
    return this.context;
  }

  private get statePath() {
    return path.join(this.opts.profileDir, "storage-state.json");
  }

  /**
   * WaterlooWorks uses session-only cookies, which Chromium drops when the process exits even with a
   * persistent profile. We therefore persist Playwright's storage state (cookies) inside the profile dir
   * after login and re-inject it on launch. The file stays local and is never exposed to callers.
   */
  private async restoreState(ctx: BrowserContext) {
    if (!fs.existsSync(this.statePath)) return;
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as { cookies?: Parameters<BrowserContext["addCookies"]>[0] };
      if (state.cookies?.length) await ctx.addCookies(state.cookies);
      this.opts.log.debug({ count: state.cookies?.length ?? 0 }, "restored session cookies");
    } catch (e) {
      this.opts.log.warn({ err: (e as Error).message }, "could not restore session state");
    }
  }

  async saveState() {
    const ctx = await this.getContext();
    const state = await ctx.storageState();
    fs.mkdirSync(this.opts.profileDir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify({ cookies: state.cookies }), { mode: 0o600 });
    this.opts.log.debug("saved session state");
  }

  clearState() {
    fs.rmSync(this.statePath, { force: true });
  }

  async newPage(): Promise<Page> {
    const ctx = await this.getContext();
    return ctx.newPage();
  }

  /** Reuse the first open page if present, else create one. */
  async page(): Promise<Page> {
    const ctx = await this.getContext();
    return ctx.pages()[0] ?? (await ctx.newPage());
  }

  url(path: string): string {
    return new URL(path, this.opts.baseUrl).toString();
  }

  async close() {
    await this.context?.close();
    this.context = undefined;
  }
}
