import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { aiSpecificity, analyse, classifyApplication, findAITooling, formatSalary, mentionsAI, parseSalary } from "../src/index.js";
import { makeWorld } from "./helpers.js";

describe("salary parsing", () => {
  const hourly = (text: string) => parseSalary(text).hourly;

  it("reads a plain hourly rate out of a benefits list", () => {
    const s = parseSalary("Full-Time Employee Benefits Include:\n- Competitive Salary: $60/hour\n- 401(k) Program with a 4% match");
    expect(s).toMatchObject({ min: 60, max: 60, unit: "hour" });
    expect(s.hourly).toBe(60);
    expect(formatSalary(s)).toBe("$60/hour");
  });

  it("reads a monthly range and normalises it to an hourly midpoint", () => {
    const s = parseSalary("Salary: $8,000 - $9,500 CAD per month");
    expect(s).toMatchObject({ min: 8000, max: 9500, unit: "month", currency: "CAD" });
    expect(s.hourly).toBeCloseTo(50.48, 1);
    expect(formatSalary(s)).toBe("$8,000–$9,500/month CAD");
  });

  it("normalises every pay basis onto the same hourly scale", () => {
    expect(hourly("Pay rate: $45 per hour")).toBe(45);
    expect(hourly("Compensation: $1,800 per week")).toBe(45);
    expect(hourly("Salary: $7,800 monthly")).toBeCloseTo(45, 0);
    expect(hourly("Annual salary of $93,600 USD")).toBeCloseTo(45, 0);
  });

  it("ignores numbers that are not pay", () => {
    expect(parseSalary("401(k) Program with a 4% match. Work term begins January 2027.").hourly).toBeUndefined();
    expect(parseSalary("Monthly wellness stipend of $100.").hourly).toBeUndefined();
    expect(parseSalary(undefined).hourly).toBeUndefined();
  });

  it("attaches the nearest unit word, not the first one tested", () => {
    // Live posting 488373: monthly pay whose sentence also mentions a weekly hour count.
    const s = parseSalary("$2500 - $2850/month, for 35 hours of work per week.");
    expect(s.unit).toBe("month");
    expect(s.hourly).toBeCloseTo(15.43, 1);
  });

  it("reads the live shapes seen on WaterlooWorks", () => {
    expect(parseSalary("This position has an expected hourly range of $19 - $23 per hour.")).toMatchObject({ min: 19, max: 23, unit: "hour" });
    expect(parseSalary("Hourly compensation of $27-$35 CAD, depending on experience.")).toMatchObject({ min: 27, max: 35, unit: "hour", currency: "CAD" });
    expect(parseSalary("The salary starts at $39,282 annually and may vary.")).toMatchObject({ min: 39282, unit: "year" });
    expect(parseSalary("discuss during interview").hourly).toBeUndefined();
  });

  it("reads a lump sum quoted against a term length as term pay, not a monthly rate", () => {
    // Live 486991 / 483361: the "4-month" states the term length; reading it as a rate inflates 4x.
    expect(parseSalary("offers a $15,000 - $20,000 stipend amount for the complete 4-month duration of the program.")).toMatchObject({
      unit: "term",
      termMonths: 4,
    });
    expect(parseSalary("compensation of $15,000 for each 4-month term.").hourly).toBeCloseTo(21.63, 1);
    expect(formatSalary(parseSalary("compensation of $15,000 for each 4-month term."))).toBe("$15,000/4-month term");
  });

  it("keeps an annualized figure annual even when a term length follows it", () => {
    // Live 483662: masking only "four-month" left "term" as the nearest unit word.
    const s = parseSalary("Competitive compensation (annualized salary of $57,000 - $60,000, pro-rated for the four-month term)");
    expect(s.unit).toBe("year");
    expect(s.hourly).toBeCloseTo(28.13, 1);
  });

  it("ignores dollar figures in perk lines that name no pay", () => {
    // Live 481555: a lunch perk outranked the real salary line on figure size alone.
    const s = parseSalary("Salary: $2,461/week USD (yes, we pay weekly) - annual equivalent is $128,000 USD\nMeals: Free daily in-office lunch (~$1,000/3months)");
    expect(s.evidence).toContain("Salary");
    expect(s.hourly).toBeCloseTo(61.54, 1);
  });

  it("rejects rates that fall outside any believable co-op wage", () => {
    expect(parseSalary("Signing bonus of $5 per day for coffee.").hourly).toBeUndefined();
    expect(parseSalary("Our team of 50,000 employees is paid well.").hourly).toBeUndefined();
  });

  it("prefers the base rate over smaller perks in the same text", () => {
    const s = parseSalary("Salary: $55/hour.\nMonthly transit allowance: $20/hour equivalent.");
    expect(s.min).toBe(55);
  });

  it("keeps the sentence a figure came from", () => {
    expect(parseSalary("Perks are great.\nCompetitive Salary: $60/hour").evidence).toContain("$60/hour");
  });
});

describe("AI tooling detection", () => {
  it("flags specific tooling and records where it said so", () => {
    const hit = findAITooling("You will work on cutting-edge AI tools and infrastructure. Experience with GitHub Copilot is a plus.");
    expect(hit.mentionsTooling).toBe(true);
    expect(hit.labels).toContain("GitHub Copilot");
    expect(hit.matches.find((m) => m.label === "GitHub Copilot")?.snippet).toContain("Copilot");
  });

  it("does not treat a bare AI/ML mention as tooling", () => {
    const hit = findAITooling("Our team builds machine learning models for logistics.");
    expect(hit.labels).toContain("Machine learning");
    expect(hit.mentionsTooling).toBe(false);
  });

  it("finds LLM and agent-framework terms", () => {
    const hit = findAITooling("Build retrieval-augmented pipelines over a vector database, backed by LLMs from Anthropic.");
    expect(hit.categories).toEqual(expect.arrayContaining(["llm-platform", "agent-framework"]));
    expect(hit.labels).toEqual(expect.arrayContaining(["RAG", "Vector database", "LLM", "Anthropic"]));
  });

  it("reports nothing for a posting with no AI content", () => {
    expect(findAITooling("Maintain COBOL batch jobs for payroll.").mentionsTooling).toBe(false);
    expect(findAITooling(undefined).matches).toEqual([]);
  });
});

describe("AI sheet membership", () => {
  it("includes generic AI postings but marks them as such", () => {
    const generic = analyse([
      { jobId: "1", title: "ML Engineer", employer: "E", applied: false, scrapedAt: new Date(), jobSummary: "We build machine learning models." },
    ])[0];
    expect(mentionsAI(generic)).toBe(true);
    expect(aiSpecificity(generic)).toBe("generic AI");

    const specific = analyse([
      { jobId: "2", title: "SWE", employer: "E", applied: false, scrapedAt: new Date(), jobSummary: "You will build RAG pipelines with LLMs." },
    ])[0];
    expect(aiSpecificity(specific)).toBe("specific tooling");

    const none = analyse([
      { jobId: "3", title: "COBOL dev", employer: "E", applied: false, scrapedAt: new Date(), jobSummary: "Payroll batch jobs." },
    ])[0];
    expect(mentionsAI(none)).toBe(false);
    expect(aiSpecificity(none)).toBe("");
  });
});

describe("external applications", () => {
  const posting = (over: Partial<Parameters<typeof classifyApplication>[0]>) =>
    classifyApplication({ jobId: "1", title: "T", employer: "E", applied: false, scrapedAt: new Date(), ...over } as never);

  it("flags a posting whose application method is not WaterlooWorks", () => {
    const c = posting({ applicationMethod: "Employer's Website" });
    expect(c).toMatchObject({ kind: "method", isExternal: true, method: "Employer's Website" });
  });

  it("treats a WaterlooWorks method as internal", () => {
    expect(posting({ applicationMethod: "WaterlooWorks" }).isExternal).toBe(false);
  });

  it("flags two-step postings that also require the employer's own form", () => {
    // Live 488181 / 487528 / 486991.
    expect(posting({ additionalInfo: "Interested applicants must apply through WaterlooWorks and directly to the employer to be considered." }).kind).toBe("dual");
    expect(posting({ additionalInfo: "Please apply to WaterlooWorks AND directly through PCL's Career Site HERE" }).kind).toBe("dual");
    expect(posting({ additionalInfo: "To be considered you must apply directly on WaterlooWorks and to the company's website using the link:" }).kind).toBe("dual");
  });

  it("flags a careers page named by the company rather than a possessive", () => {
    // Live 487569 / 487138: "the D2L Careers page" has no "our"/"employer's" to key on.
    expect(posting({ additionalInfo: "Please apply on WaterlooWorks AND to the job posting on the D2L Careers page." }).kind).toBe("dual");
    expect(posting({ additionalInfo: "Candidates must apply directly through the BMO Careers page for consideration:" }).kind).toBe("dual");
  });

  it("keeps the apply link even when it sits on the next line", () => {
    const c = posting({ additionalInfo: "Candidates must apply through the BMO Careers page for consideration:\nhttps://bmo.wd3.myworkdayjobs.com/Campus/job/123" });
    expect(c.urls).toEqual(["https://bmo.wd3.myworkdayjobs.com/Campus/job/123"]);
  });

  it("does not mistake interview logistics or informational links for an application", () => {
    expect(posting({ additionalInfo: "Our interview process includes a 45-minute technical interview with an engineer." }).isExternal).toBe(false);
    expect(posting({ additionalInfo: "Employer will be contacting you directly to make interview arrangements." }).isExternal).toBe(false);
    expect(posting({ additionalInfo: "For more information about the project, please visit: https://www.example.org/about" }).isExternal).toBe(false);
    expect(posting({ additionalInfo: "Applications without portfolios will not be considered." }).isExternal).toBe(false);
  });
});

describe("job scan", () => {
  const seed = (provider: ReturnType<typeof makeWorld>["provider"]) => {
    provider.seedPosting({
      jobId: "500001",
      title: "Software Engineering Intern",
      employer: "Replit",
      compensation: "Competitive Salary: $60/hour",
      jobSummary: "Work on our AI-powered development environment using LLMs.",
    });
    provider.seedPosting({
      jobId: "500002",
      title: "Backend Developer",
      employer: "Payroll Co",
      compensation: "Salary: $30/hour",
      jobSummary: "Maintain COBOL batch jobs.",
    });
    provider.seedPosting({ jobId: "500003", title: "Other Program Job", employer: "Elsewhere" }, false);
  };

  it("stores postings for my program and skips other programs", async () => {
    const { core, provider } = makeWorld();
    seed(provider);
    const res = await core.scanJobs({ myProgramOnly: true });
    expect(res.scraped).toBe(2);
    expect(core.listJobPostings(true).map((p) => p.jobId).sort()).toEqual(["500001", "500002"]);
  });

  it("resumes an interrupted scan instead of re-reading cached postings", async () => {
    const { core, provider } = makeWorld();
    seed(provider);
    await core.scanJobs({ myProgramOnly: true, maxJobs: 1 });
    const second = await core.scanJobs({ myProgramOnly: true });
    expect(second.scraped).toBe(1);
    expect(second.cached).toBe(1);
    expect(core.listJobPostings(true)).toHaveLength(2);
  });

  it("re-reads everything with refresh", async () => {
    const { core, provider } = makeWorld();
    seed(provider);
    await core.scanJobs({ myProgramOnly: true });
    expect((await core.scanJobs({ myProgramOnly: true, refresh: true })).scraped).toBe(2);
  });

  it("writes a workbook with an all-jobs sheet sorted by pay and an AI sheet", async () => {
    const { core, provider } = makeWorld();
    seed(provider);
    await core.scanJobs({ myProgramOnly: true });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ww-xlsx-")), "jobs.xlsx");
    const res = await core.exportJobs(file, true);
    expect(res).toMatchObject({ total: 2, withSalary: 2, aiTooling: 1, aiSpecific: 1 });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["All Jobs", "AI Tooling", "External Applications"]);

    const all = wb.getWorksheet("All Jobs")!;
    const header = all.getRow(1).values as unknown[];
    expect(header).toContain("Salary ($/hr)");
    // Highest hourly rate first.
    expect(all.getRow(2).getCell(1).value).toBe("500001");
    expect(all.getRow(2).getCell(6).value).toBe(60);
    expect(all.getRow(3).getCell(6).value).toBe(30);

    const ai = wb.getWorksheet("AI Tooling")!;
    expect(ai.rowCount).toBe(2); // header + the one AI posting
    expect(ai.getRow(1).values).toContain("Specific?");
    expect(ai.getRow(2).getCell(1).value).toBe("500001");
    expect(String(ai.getRow(2).values).toLowerCase()).toContain("llm");
  });
});
