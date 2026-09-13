import fs from "node:fs";
import { chromium } from "playwright";
const profile = "browser-profile", base = "https://waterlooworks.uwaterloo.ca";
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
await ctx.addCookies(JSON.parse(fs.readFileSync(`${profile}/storage-state.json`, "utf8")).cookies);
const page = await ctx.newPage();
const dump = async (n) => { fs.writeFileSync(`dumps/${n}.html`, await page.content()); console.log(`[dump] ${n} ${page.url()}`); };
const vis = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter(e => e.getBoundingClientRect().width > 0).map(e => `${e.tagName}:${e.type||""}:${e.name||e.id||e.getAttribute("aria-label")||e.placeholder||""}:${(e.innerText||e.value||"").trim().replace(/\s+/g," ").slice(0,40)}`), sel);

// 1. From applied list, click job title link → posting page
await page.goto(`${base}/myAccount/co-op/full/applications.htm`, { waitUntil: "networkidle" });
await page.locator('tr:has-text("Applied") a:has-text("View")').first().click();
await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
const row = page.locator("table.data-viewer-table tbody tr").first();
const [popup] = await Promise.all([ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null), row.locator("th a").first().click()]);
const post = popup ?? page;
await post.waitForLoadState("networkidle").catch(() => {}); await post.waitForTimeout(2500);
fs.writeFileSync("dumps/posting.html", await post.content());
console.log("[posting] url:", post.url(), "popup?", !!popup);
console.log("posting headings/tabs:", await post.evaluate(() => [...document.querySelectorAll('h1,h2,h3,[role="tab"], .tab, nav a, button')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.innerText.trim().replace(/\s+/g, " ").slice(0, 50)).filter(Boolean).slice(0, 60)));
const body = (await post.locator("body").innerText()).replace(/\n{2,}/g, "\n");
for (const kw of ["Application Deadline", "Résumé", "Resume", "Cover Letter", "Package", "Apply", "Cancel", "Job Posting Status", "Application Status", "Additional Application Information", "Documents Required"]) {
  const i = body.indexOf(kw); console.log(`  kw ${kw}: ${i >= 0 ? JSON.stringify(body.slice(Math.max(0, i - 60), i + 200)) : "none"}`);
}
if (popup) await popup.close();

// 2. Jobs page search UI
await page.goto(`${base}/myAccount/co-op/full/jobs.htm`, { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
console.log("jobs controls:", (await vis("input, select, button, a.btn, [role=tab]")).slice(0, 60));

// 3. Download one résumé PDF + one package PDF
await page.goto(`${base}/myAccount/co-op/full/documents.htm`, { waitUntil: "networkidle" });
await page.locator('table.stat-table tr:has-text("Résumé") a:has-text("View")').first().click();
await page.waitForLoadState("networkidle"); await page.waitForTimeout(1200);
for (const [i, name] of [[0, "resume0"], [1, "resume1"]]) {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.locator("#doc_commonTableTableID tbody tr").nth(i).locator('a:has-text("Download PDF")').click()]);
  await dl.saveAs(`dumps/${name}.pdf`); console.log(`[pdf] ${name} <- ${dl.suggestedFilename()}`);
}
await page.goto(`${base}/myAccount/co-op/full/documents.htm`, { waitUntil: "networkidle" });
await page.locator('table.stat-table tr:has-text("Application Packages") a:has-text("View")').first().click();
await page.waitForLoadState("networkidle"); await page.waitForTimeout(1200);
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.locator("#doc_commonTableTableID tbody tr").first().locator('a:has-text("Download PDF")').click()]);
await dl.saveAs("dumps/package0.pdf"); console.log("[pdf] package0 <-", dl.suggestedFilename());
await ctx.close();
