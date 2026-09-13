import fs from "node:fs";
import { chromium } from "playwright";
const profile = "browser-profile", base = "https://waterlooworks.uwaterloo.ca";
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1500, height: 1000 } });
await ctx.addCookies(JSON.parse(fs.readFileSync(`${profile}/storage-state.json`, "utf8")).cookies);
const page = await ctx.newPage();
const log = (...a) => console.log(...a);
const save = (n, s) => fs.writeFileSync(`dumps/${n}`, s);
const vis = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter(e => e.getBoundingClientRect().width > 0).map(e => `${e.tagName.toLowerCase()}${e.type ? ":" + e.type : ""}|${e.getAttribute("aria-label") || e.name || e.id || e.placeholder || ""}|${(e.innerText || e.value || "").trim().replace(/\s+/g, " ").slice(0, 50)}`), sel);

// (a) viewer Settings dropdown
await page.goto(`${base}/myAccount/co-op/full/applications.htm`, { waitUntil: "networkidle" });
await page.locator('tr:has-text("Applied") a:has-text("View")').first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
const before = await page.evaluate(() => document.body.innerText.length);
await page.locator('button[aria-label="Settings"]').first().click(); await page.waitForTimeout(1200);
save("viewer-settings.html", await page.content());
const newText = await page.evaluate(() => { const els = [...document.querySelectorAll('[class*=dropdown], [class*=menu], [class*=popover], .modal.is--visible, [role=menu], [role=dialog]')].filter(e => e.getBoundingClientRect().width > 0); return els.map(e => e.className.slice(0, 60) + " :: " + e.innerText.replace(/\s+/g, " ").slice(0, 1500)); });
log("settings dropdown candidates:", JSON.stringify(newText.slice(0, 6), null, 1));
await page.keyboard.press("Escape");

// (b) jobs page
await page.goto(`${base}/myAccount/co-op/full/jobs.htm`, { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
const controls = (await vis("input, select, button, a.btn, [role=tab], main a")).filter(t => !/keyboard_arrow|Toggle Dropdown|^a\|\|(HOME|CO-OP|DOCUMENTS|POSTINGS|INTERVIEWS|RANKINGS|APPOINTMENTS|EVENTS|SKILLS)/.test(t));
save("jobs-controls.txt", controls.join("\n")); log("jobs controls:", controls.slice(0, 50));
log("jobs main text:", (await page.locator("main, #mainContentDiv").first().innerText().catch(() => "")).replace(/\n{2,}/g, "\n").slice(0, 1200));
await ctx.close();
