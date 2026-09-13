import fs from "node:fs";
import { chromium } from "playwright";
const profile = "browser-profile", base = "https://waterlooworks.uwaterloo.ca";
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1500, height: 1000 } });
await ctx.addCookies(JSON.parse(fs.readFileSync(`${profile}/storage-state.json`, "utf8")).cookies);
const page = await ctx.newPage();
const log = (...a) => console.log(...a);
const vue = () => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("*")) {
    const v = el.__vue__; if (!v) continue;
    const d = v.$data || {}; const keys = Object.keys(d);
    if (keys.some(k => /posting|appData|application/i.test(k))) {
      const pick = {};
      for (const k of keys) { const val = d[k]; if (val && typeof val === "object") { pick[k] = Object.fromEntries(Object.entries(val).slice(0, 40).map(([a, b]) => [a, typeof b === "object" && b !== null ? (Array.isArray(b) ? `[array ${b.length}]` : "{obj:" + Object.keys(b).slice(0, 12).join(",") + "}") : String(b).slice(0, 80)])); } else pick[k] = String(val).slice(0, 80); }
      out.push({ tag: el.tagName + "#" + el.id + "." + el.className.slice(0, 40), data: pick });
    }
    if (out.length > 6) break;
  }
  return out;
});
// applications list → posting panel (applied job)
await page.goto(`${base}/myAccount/co-op/full/applications.htm`, { waitUntil: "networkidle" });
await page.locator('tr:has-text("Applied") a:has-text("View")').first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
log("== applications viewer vue:", JSON.stringify(await vue(), null, 1).slice(0, 3500));
await page.locator("table.data-viewer-table tbody tr").first().locator("th a").first().click(); await page.waitForTimeout(3000);
log("== posting panel vue (applied job):", JSON.stringify(await vue(), null, 1).slice(0, 6000));
log("panel header text:", await page.evaluate(() => document.querySelector(".dashboard-header__posting-title")?.parentElement?.innerText.replace(/\s+/g, " ").slice(0, 300)));
await ctx.close();
