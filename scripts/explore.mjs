// Selector-calibration helper: click through Orbis buildForm() buttons and dump rendered HTML.
import fs from "node:fs";
import { chromium } from "playwright";
const profile = "browser-profile";
const base = "https://waterlooworks.uwaterloo.ca";
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1400, height: 1000 } });
const st = JSON.parse(fs.readFileSync(`${profile}/storage-state.json`, "utf8"));
await ctx.addCookies(st.cookies);
const page = await ctx.newPage();
const dump = async (name) => { fs.writeFileSync(`dumps/${name}.html`, await page.content()); console.log(`[dump] ${name} ${page.url()}`); };
const tables = async (label) => {
  const info = await page.evaluate(() => [...document.querySelectorAll("table")].map((t, i) => ({
    i, cls: t.className, id: t.id,
    headers: [...t.querySelectorAll("thead th, thead td, tr:first-child th")].map((x) => x.innerText.trim().replace(/\s+/g, " ")),
    rows: t.querySelectorAll("tbody tr").length,
    first: [...t.querySelectorAll("tbody tr")].slice(0, 2).map((r) => [...r.querySelectorAll("td,th")].map((c) => c.innerText.trim().replace(/\s+/g, " ").slice(0, 60))),
  })));
  console.log(`--- tables on ${label}`); for (const t of info) console.log(JSON.stringify(t));
};
const step = process.argv[2] ?? "all";

if (step === "all" || step === "apps") {
  await page.goto(`${base}/myAccount/co-op/full/applications.htm`, { waitUntil: "networkidle" });
  const view = page.locator('tr:has-text("Applied") a:has-text("View")').first();
  console.log("Applied/View buttons:", await view.count());
  await view.click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
  await dump("applied"); await tables("applied");
  const firstRow = page.locator("table tbody tr").filter({ hasText: /\d{5,}/ }).first();
  console.log("first data row html:\n", (await firstRow.evaluate((r) => r.outerHTML).catch(() => "n/a")).slice(0, 3000));
}
if (step === "all" || step === "docs") {
  await page.goto(`${base}/myAccount/co-op/full/documents.htm`, { waitUntil: "networkidle" });
  const statRows = await page.locator("table.stat-table tbody tr").allInnerTexts();
  console.log("doc stat rows:", statRows.map((s) => s.replace(/\s+/g, " ")));
  const v = page.locator('table.stat-table tr:has-text("Résumé") a:has-text("View")').first();
  if (await v.count()) { await v.click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500); await dump("resumes"); await tables("resumes");
    const r = page.locator("table tbody tr").filter({ hasText: /Résumé/ }).first();
    console.log("first resume row html:\n", (await r.evaluate((x) => x.outerHTML).catch(() => "n/a")).slice(0, 3000));
  } else console.log("no Résumé View button; page tables:"), await tables("documents-landing");
}
await ctx.close();
