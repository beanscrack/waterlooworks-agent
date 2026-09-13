import type { Page } from "playwright";
import { loginHostHints, loginPathHints, routes, sel } from "./selectors.js";

export class LoginPage {
  constructor(private page: Page, private baseUrl: string) {}

  static looksLikeLoginUrl(url: string): boolean {
    try {
      const u = new URL(url);
      if (loginHostHints.some((h) => u.host.includes(h))) return true;
      if (loginPathHints.some((p) => u.pathname.toLowerCase().includes(p.toLowerCase()))) return true;
    } catch {
      /* ignore */
    }
    return false;
  }

  async isAuthenticated(): Promise<boolean> {
    await this.page.goto(new URL(routes.dashboard, this.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("networkidle").catch(() => {});
    if (LoginPage.looksLikeLoginUrl(this.page.url())) return false;
    if (!this.page.url().includes("/myAccount/")) return false;
    return (await this.page.locator(sel.authenticatedMarker).count()) > 0;
  }

  async interactiveLogin(timeoutMs: number, onProgress?: (msg: string) => void): Promise<boolean> {
    await this.page.goto(new URL(routes.login, this.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    onProgress?.("Complete the Waterloo login (and MFA) in the browser window…");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.page.isClosed()) return false;
      const url = this.page.url();
      if (url.includes("/myAccount/") && !LoginPage.looksLikeLoginUrl(url)) {
        await this.page.waitForLoadState("domcontentloaded").catch(() => {});
        if ((await this.page.locator(sel.authenticatedMarker).count()) > 0) return true;
      }
      await this.page.waitForTimeout(1000);
    }
    return false;
  }

  async logout(): Promise<void> {
    await this.page.goto(new URL("/logout.htm", this.baseUrl).toString(), { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.page.context().clearCookies();
  }
}
