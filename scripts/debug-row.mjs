import { chromium } from "playwright";
import fs from "node:fs";
import { ApplicationsPage } from "../packages/core/dist/browser/ApplicationsPage.js";
const profile = "browser-profile", base = "https://waterlooworks.uwaterloo.ca";
const ctx = await chromium.launchPersistentContext(profile, { headless: true });
await ctx.addCookies(JSON.parse(fs.readFileSync(`${profile}/storage-state.json`, "utf8")).cookies);
const page = await ctx.newPage();
const ap = new ApplicationsPage(page, base);
await ap.open(); await ap.openStatus("Applied");
console.log("rows in DOM:", await page.locator("table.data-viewer-table tbody tr").count());
console.log("regex filter:", await page.locator("table.data-viewer-table tbody tr").filter({ hasText: /(^|\s)486534(\s|$)/ }).count());
console.log("string filter:", await page.locator("table.data-viewer-table tbody tr").filter({ hasText: "486534" }).count());
console.log("row0 innerText JSON:", JSON.stringify(await page.locator("table.data-viewer-table tbody tr").first().innerText()).slice(0, 200));
try { const info = await ap.openPosting("486534"); console.log("posting:", JSON.stringify(info).slice(0, 500)); } catch (e) { console.log("openPosting error:", e.message.split("\n")[0]); }
await ctx.close();
