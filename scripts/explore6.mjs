import fs from "node:fs";
import { chromium } from "playwright";
const profile = "browser-profile", base = "https://waterlooworks.uwaterloo.ca";
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1500, height: 1000 } });
await ctx.addCookies(JSON.parse(fs.readFileSync(`${profile}/storage-state.json`, "utf8")).cookies);
const page = await ctx.newPage();
const log = (...a) => console.log(...a);
const save = (n, s) => fs.writeFileSync(`dumps/${n}`, s);
const vis = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter(e => e.getBoundingClientRect().width > 0).map(e => `${e.tagName.toLowerCase()}${e.type ? ":" + e.type : ""}|${e.getAttribute("aria-label") || e.name || e.id || e.placeholder || ""}|${(e.innerText || e.value || "").trim().replace(/\s+/g, " ").slice(0, 60)}`), sel);

// (1) archived documents
await page.goto(`${base}/myAccount/co-op/full/documents.htm`, { waitUntil: "networkidle" });
await page.locator('table.stat-table tr:has-text("Archived Documents") a:has-text("View")').first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1200);
log("archived headers:", await page.evaluate(() => [...document.querySelectorAll("#doc_commonTableTableID thead th")].map(x => x.innerText.trim())));
log("archived rows:", await page.evaluate(() => [...document.querySelectorAll("#doc_commonTableTableID tbody tr")].map(r => [...r.querySelectorAll("td")].map(c => c.innerText.trim().replace(/\s+/g, " ").slice(0, 50)))));

// (2) jobs search → find a row with Apply
await page.goto(`${base}/myAccount/co-op/full/jobs.htm`, { waitUntil: "networkidle" }); await page.waitForTimeout(1000);
const kw = page.locator('input[placeholder*="keyword" i]').first();
await kw.fill("software"); await kw.press("Enter"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(2500);
save("jobs-results.html", await page.content());
log("results table headers:", await page.evaluate(() => [...document.querySelectorAll("table.data-viewer-table thead th")].map(x => x.innerText.trim().replace(/\s+/g, " "))));
log("results row0 cells:", await page.evaluate(() => { const r = document.querySelector("table.data-viewer-table tbody tr"); return r ? [...r.querySelectorAll("th,td")].map(c => c.innerText.trim().replace(/\s+/g, " ").slice(0, 50)) : "none"; }));
log("results row0 buttons:", await page.evaluate(() => { const r = document.querySelector("table.data-viewer-table tbody tr"); return r ? [...r.querySelectorAll("button,a")].map(b => (b.getAttribute("aria-label") || b.innerText).trim().slice(0, 40)) : "none"; }));
// find first row that is NOT applied (no "Applied" text) and has an Apply-ish button
const rows = page.locator("table.data-viewer-table tbody tr");
const n = await rows.count(); log("result rows:", n);
let target = -1;
for (let i = 0; i < Math.min(n, 40); i++) {
  const t = (await rows.nth(i).innerText()).replace(/\s+/g, " ");
  const hasApply = (await rows.nth(i).locator('button[aria-label*="Apply" i], a:has-text("Apply"), button:has-text("Apply")').count()) > 0;
  if (hasApply && !/Applied/.test(t)) { target = i; log("target row:", i, t.slice(0, 160)); break; }
}
if (target < 0) { log("no apply row found; row texts:", await rows.evaluateAll(rs => rs.slice(0, 5).map(r => r.innerText.replace(/\s+/g, " ").slice(0, 120)))); }
else {
  const r = rows.nth(target);
  await r.locator('button[aria-label*="Apply" i], a:has-text("Apply"), button:has-text("Apply")').first().click();
  await page.waitForTimeout(3000); await page.waitForLoadState("networkidle").catch(() => {});
  save("apply-form.html", await page.content());
  log("apply url:", page.url());
  const container = await page.evaluate(() => { const c = [...document.querySelectorAll(".modal.is--visible, [role=dialog], form, main")].filter(e => e.getBoundingClientRect().width > 300 && /Résumé|Resume|Package/i.test(e.innerText)).sort((a, b) => a.innerText.length - b.innerText.length)[0]; return c ? c.tagName + "." + c.className.slice(0, 60) + "\n" + c.innerText : "none"; });
  save("apply-form.txt", container); log("apply container text:", container.replace(/\n{2,}/g, "\n").slice(0, 3000));
  log("apply form controls:", (await vis(".modal.is--visible input, .modal.is--visible select, .modal.is--visible button, form input, form select, form button")).slice(0, 60));
  log("apply selects+options:", await page.evaluate(() => [...document.querySelectorAll("select")].filter(s => s.getBoundingClientRect().width > 0).map(s => ({ name: s.name || s.id, label: s.labels?.[0]?.innerText?.trim(), options: [...s.options].map(o => o.value + "=" + o.text.trim().slice(0, 40)) }))));
  log("apply radios/checks:", await page.evaluate(() => [...document.querySelectorAll('input[type=radio],input[type=checkbox]')].filter(s => s.getBoundingClientRect().width > 0).map(s => `${s.type}:${s.name}:${s.value}:${s.labels?.[0]?.innerText?.trim().slice(0,60)}`)));
  await page.keyboard.press("Escape");
}
await ctx.close();
