import fs from "node:fs";
import { chromium } from "playwright";
const profile = "browser-profile", base = "https://waterlooworks.uwaterloo.ca";
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1400, height: 1000 } });
await ctx.addCookies(JSON.parse(fs.readFileSync(`${profile}/storage-state.json`, "utf8")).cookies);
const page = await ctx.newPage();
const dump = async (n) => { fs.writeFileSync(`dumps/${n}.html`, await page.content()); console.log(`[dump] ${n} ${page.url()}`); };
const txt = async (sel, max = 2500) => (await page.locator(sel).first().innerText().catch(() => "n/a")).replace(/\n{2,}/g, "\n").slice(0, max);
const modals = () => page.evaluate(() => [...document.querySelectorAll('.modal, [role="dialog"], .drawer, .sidebar, .panel--slide, [class*="modal"], [class*="dialog"]')].filter(e => e.offsetParent !== null || e.getBoundingClientRect().width > 0).map(e => ({ tag: e.tagName, cls: e.className.slice(0, 80), text: e.innerText.replace(/\s+/g, " ").slice(0, 1500) })));

// 1. Applied list → View Application on first row
await page.goto(`${base}/myAccount/co-op/full/applications.htm`, { waitUntil: "networkidle" });
await page.locator('tr:has-text("Applied") a:has-text("View")').first().click();
await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
console.log("pagination text:", await txt('[class*="pagination"], [class*="pager"], nav[aria-label*="agination"]', 300));
const row = page.locator("table.data-viewer-table tbody tr").first();
await row.locator('button[aria-label="View Application"]').click();
await page.waitForTimeout(2500); await page.waitForLoadState("networkidle").catch(() => {});
await dump("app-detail");
console.log("url after view:", page.url());
console.log("visible dialogs:", JSON.stringify(await modals(), null, 1).slice(0, 4000));

// 2. Cancel dialog (do NOT confirm)
await page.goto(`${base}/myAccount/co-op/full/applications.htm`, { waitUntil: "networkidle" });
await page.locator('tr:has-text("Applied") a:has-text("View")').first().click();
await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
await page.locator("table.data-viewer-table tbody tr").first().locator('button[aria-label="Cancel Application"]').click();
await page.waitForTimeout(1500);
await dump("cancel-dialog");
console.log("cancel dialogs:", JSON.stringify(await modals(), null, 1).slice(0, 3000));
console.log("dialog buttons:", await page.evaluate(() => [...document.querySelectorAll('.modal button, [role="dialog"] button, [class*="modal"] button')].filter(b => b.offsetParent !== null).map(b => b.innerText.trim() + "|" + b.className.slice(0, 60))));
await page.keyboard.press("Escape"); await page.waitForTimeout(500);

// 3. Application Packages
await page.goto(`${base}/myAccount/co-op/full/documents.htm`, { waitUntil: "networkidle" });
await page.locator('table.stat-table tr:has-text("Application Packages") a:has-text("View")').first().click();
await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
await dump("packages");
console.log("packages headers:", await page.evaluate(() => [...document.querySelectorAll("#doc_commonTableTableID thead th")].map(x => x.innerText.trim())));
console.log("packages first rows:", await page.evaluate(() => [...document.querySelectorAll("#doc_commonTableTableID tbody tr")].slice(0, 3).map(r => [...r.querySelectorAll("td")].map(c => c.innerText.trim().replace(/\s+/g, " ").slice(0, 80)))));
console.log("packages first row html:", (await page.locator("#doc_commonTableTableID tbody tr").first().evaluate(r => r.outerHTML).catch(() => "n/a")).replace(/\s+/g, " ").slice(0, 2500));

// 4. Jobs page landing
await page.goto(`${base}/myAccount/co-op/full/jobs.htm`, { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
await dump("jobs");
console.log("jobs page text:", await txt("main, #mainContentDiv, body", 1800));
console.log("jobs inputs:", await page.evaluate(() => [...document.querySelectorAll("input, select, button")].filter(e => e.offsetParent !== null).slice(0, 40).map(e => `${e.tagName}:${e.type||""}:${e.name||e.id||e.getAttribute("aria-label")||e.placeholder||e.innerText.trim().slice(0,30)}`)));
await ctx.close();
