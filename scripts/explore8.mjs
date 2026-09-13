import fs from "node:fs";
import { chromium } from "playwright";
const profile = "browser-profile", base = "https://waterlooworks.uwaterloo.ca";
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1500, height: 1000 } });
await ctx.addCookies(JSON.parse(fs.readFileSync(`${profile}/storage-state.json`, "utf8")).cookies);
const page = await ctx.newPage();
const log = (...a) => console.log(...a);
await page.goto(`${base}/myAccount/co-op/full/jobs.htm`, { waitUntil: "networkidle" }); await page.waitForTimeout(800);
// search by job id directly to validate that path
const kw = page.locator('input[placeholder*="keyword" i]').first();
await kw.fill("488415"); await kw.press("Enter"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(2000);
const rows = page.locator("table.data-viewer-table tbody tr");
log("rows for id search:", await rows.count(), (await rows.first().innerText()).replace(/\s+/g, " ").slice(0, 120));
// open posting panel via title
await rows.first().locator("a").filter({ hasText: /Early Careers/ }).first().click(); await page.waitForTimeout(2500);
const panel = await page.evaluate(() => { const c = [...document.querySelectorAll("div, section")].filter(e => e.getBoundingClientRect().width > 300 && e.innerText.includes("Application Deadline") && e.innerText.length < 8000).sort((a, b) => a.innerText.length - b.innerText.length)[0]; return c ? { cls: c.className, html: c.outerHTML.slice(0, 200), text: c.innerText } : null; });
fs.writeFileSync("dumps/posting-panel.txt", panel?.text ?? "none");
log("panel cls:", panel?.cls, "\npanel text head:", panel?.text.replace(/\n{2,}/g, "\n").slice(0, 1600));
log("panel headings:", await page.evaluate(() => [...document.querySelectorAll("h1,h2,h3,h4,h5,[class*=heading],[class*=title]")].filter(e => e.getBoundingClientRect().width > 0).map(e => e.tagName + "." + e.className.slice(0, 50) + "=" + e.innerText.trim().replace(/\s+/g, " ").slice(0, 80)).slice(0, 25)));
log("panel buttons:", await page.evaluate(() => [...document.querySelectorAll("button, a.btn")].filter(e => e.getBoundingClientRect().width > 0).map(e => (e.getAttribute("aria-label") || e.innerText).trim().replace(/\s+/g, " ").slice(0, 40)).filter(t => !/Sort by|Toggle|keyboard|swap|^$/.test(t))));
// apply popup → custom package
const [popup] = await Promise.all([ctx.waitForEvent("page", { timeout: 15000 }), rows.first().locator('button[aria-label="Apply"]').click()]);
await popup.waitForLoadState("networkidle").catch(() => {}); await popup.waitForTimeout(2500);
await popup.locator('input[value="customPkg"]').check(); await popup.waitForTimeout(1200);
fs.writeFileSync("dumps/apply-custom.html", await popup.content());
log("custom view text:", (await popup.locator("body").innerText()).replace(/\n{2,}/g, "\n").slice(0, 1800));
log("visible selects w/ labels:", await popup.evaluate(() => [...document.querySelectorAll("select")].filter(s => s.getBoundingClientRect().width > 0).map(s => { const lab = s.closest("div,tr,li,fieldset")?.innerText.trim().split("\n")[0]; return `${s.name}|${s.labels?.[0]?.innerText?.trim() || ""}|${lab?.slice(0, 60)}|selected=${s.value}`; })));
log("custom inputs:", await popup.evaluate(() => [...document.querySelectorAll("input:not([type=hidden]),textarea")].filter(e => e.getBoundingClientRect().width > 0).map(e => `${e.type}|${e.name || e.id}|${(e.labels?.[0]?.innerText || e.getAttribute("aria-label") || "").trim().slice(0, 60)}|${e.value?.slice(0, 30)}`)));
log("custom buttons:", await popup.evaluate(() => [...document.querySelectorAll("button, input[type=submit], a.btn")].filter(e => e.getBoundingClientRect().width > 0).map(e => `${e.tagName}|${e.type}|${(e.getAttribute("aria-label") || e.innerText || e.value).trim().slice(0, 40)}|${e.className.slice(0, 50)}|onclick=${(e.getAttribute("onclick") || "").slice(0, 80)}`)));
log("form tags:", await popup.evaluate(() => [...document.querySelectorAll("form")].map(f => `${f.id || f.name}|action=${f.action.slice(0, 80)}|method=${f.method}`)));
await popup.close();
await ctx.close();
