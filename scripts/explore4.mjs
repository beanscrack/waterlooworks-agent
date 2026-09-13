import fs from "node:fs";
import { chromium } from "playwright";
const profile = "browser-profile", base = "https://waterlooworks.uwaterloo.ca";
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
await ctx.addCookies(JSON.parse(fs.readFileSync(`${profile}/storage-state.json`, "utf8")).cookies);
const page = await ctx.newPage();
const log = (...a) => console.log(...a);
const save = (n, s) => fs.writeFileSync(`dumps/${n}`, s);
const visText = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter(e => e.getBoundingClientRect().width > 0).map(e => (e.getAttribute("aria-label") || e.innerText || e.value || "").trim().replace(/\s+/g, " ").slice(0, 60)).filter(Boolean), sel);
const openApplied = async () => { await page.goto(`${base}/myAccount/co-op/full/applications.htm`, { waitUntil: "networkidle" }); await page.locator('tr:has-text("Applied") a:has-text("View")').first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500); };

try {
  // (a) package PDF
  await page.goto(`${base}/myAccount/co-op/full/documents.htm`, { waitUntil: "networkidle" });
  await page.locator('table.stat-table tr:has-text("Application Packages") a:has-text("View")').first().click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
  const r0 = page.locator("#doc_commonTableTableID tbody tr").first();
  log("pkg row0 name:", await r0.locator("td").nth(2).innerText());
  const dlp = page.waitForEvent("download", { timeout: 30000 });
  await r0.locator('a:has-text("Download PDF")').click();
  const dl = await dlp; await dl.saveAs("dumps/package0.pdf"); log("[pdf] package0 saved");
} catch (e) { log("package download failed:", e.message.split("\n")[0]); }

// (b) applications viewer settings / column config
await openApplied();
const settings = page.locator('button[aria-label*="etting" i], button:has-text("settings"), button:has(i:text("settings"))').first();
log("settings btn count:", await settings.count());
if (await settings.count()) {
  await settings.click(); await page.waitForTimeout(1200);
  save("viewer-settings.html", await page.content());
  log("settings modal text:", (await page.locator(".modal.is--visible, [role=dialog]").first().innerText().catch(() => "none")).replace(/\s+/g, " ").slice(0, 2500));
  await page.keyboard.press("Escape"); await page.waitForTimeout(400);
}
const artTrack = page.locator('button:has(i:text("art_track"))').first();
if (await artTrack.count()) { await artTrack.click(); await page.waitForTimeout(1200); log("art_track panel text:", (await page.locator(".modal.is--visible, [role=dialog], [class*=drawer]").first().innerText().catch(() => "none")).replace(/\s+/g, " ").slice(0, 2000)); await page.keyboard.press("Escape"); }

// (c) posting panel full text + buttons
await openApplied();
await page.locator("table.data-viewer-table tbody tr").first().locator("th a").first().click();
await page.waitForTimeout(3000);
save("posting.html", await page.content());
const panelText = await page.evaluate(() => { const c = [...document.querySelectorAll("main, [class*=panel], [class*=posting], [class*=drawer], [class*=overlay]")].filter(e => e.getBoundingClientRect().width > 300 && e.innerText.includes("Application Deadline")).sort((a, b) => a.innerText.length - b.innerText.length)[0]; return c ? c.className + "\n" + c.innerText : document.body.innerText; });
save("posting.txt", panelText);
log("posting panel class+text head:", panelText.replace(/\n{2,}/g, "\n").slice(0, 1800));
log("posting buttons:", await visText('button, a.btn, [role=tab], [class*=tab] a'));

// (d) jobs page controls
await page.goto(`${base}/myAccount/co-op/full/jobs.htm`, { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
save("jobs.html", await page.content());
log("jobs visible controls:", (await visText("input, select, button, a.btn, [role=tab], a")).filter(t => !/keyboard_arrow|^$/.test(t)).slice(0, 80));
await ctx.close();
