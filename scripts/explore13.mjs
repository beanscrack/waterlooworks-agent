import fs from "node:fs";
import { chromium } from "playwright";
const profile = "browser-profile", base = "https://waterlooworks.uwaterloo.ca";
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1500, height: 1000 } });
await ctx.addCookies(JSON.parse(fs.readFileSync(`${profile}/storage-state.json`, "utf8")).cookies);
const page = await ctx.newPage();
for (const label of ["Résumé", "Cover Letter", "Other - Per Job Posting"]) {
  await page.goto(`${base}/myAccount/co-op/full/documents.htm`, { waitUntil: "networkidle" });
  const link = page.locator(`table.stat-table tr:has-text("${label}") a:has-text("View")`).first();
  const onclick = (await link.getAttribute("onclick")).replace(/numOfDays'?\s*:\s*'\d+'/, "numOfDays':'-1'");
  await page.evaluate((c) => new Function(c)(), onclick); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1200);
  const info = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#doc_commonTableTableID tbody tr")];
    const badges = rows.filter(r => r.querySelector(".badge")).map(r => (r.querySelector("input.ms_check")?.id || "") + " :: " + [...r.querySelectorAll(".badge")].map(b => b.textContent.trim()).join(",") + " :: " + r.querySelectorAll("td")[2]?.textContent.trim().replace(/\s+/g, " ").slice(0, 40));
    const rowBtns = [...new Set(rows.flatMap(r => [...r.querySelectorAll("a.btn")].map(a => a.textContent.trim())))];
    const bulk = [...document.querySelectorAll("a[onclick*='doc_commonTable_guard']")].map(a => a.textContent.trim());
    return { rows: rows.length, badges, rowBtns, bulk, pagerText: document.querySelector(".gridPager")?.textContent.trim().slice(0, 100) };
  });
  console.log(label, JSON.stringify(info, null, 1));
}
await ctx.close();
