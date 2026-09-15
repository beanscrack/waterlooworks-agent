import ExcelJS from "exceljs";
import type { JobPosting } from "../models/index.js";
import { findAITooling, type AIToolingHit } from "./aiTooling.js";
import { classifyApplication, type ExternalApplication } from "./externalApplication.js";
import { formatSalary, parseSalary, type ParsedSalary } from "./salary.js";

export interface JobRow {
  posting: JobPosting;
  salary: ParsedSalary;
  ai: AIToolingHit;
  external: ExternalApplication;
}

/** Every field the AI scan reads. Compensation is included: perks often name the tooling. */
export const describedText = (p: JobPosting): string =>
  [p.title, p.jobSummary, p.jobResponsibilities, p.requiredSkills, p.specialRequirements, p.additionalInfo]
    .filter(Boolean)
    .join("\n");

export function analyse(postings: JobPosting[]): JobRow[] {
  return postings.map((posting) => ({
    posting,
    salary: parseSalary(posting.compensation),
    ai: findAITooling(describedText(posting)),
    external: classifyApplication(posting),
  }));
}

/** Highest hourly rate first; unparsed pay sinks to the bottom but keeps its verbatim text. */
/**
 * "specific tooling" means the posting named a concrete tool, platform or technique (Copilot,
 * LLM, RAG, an agent framework); "generic AI" means only bare AI/ML/deep-learning wording matched.
 */
/** "apply elsewhere" = not a WaterlooWorks application at all; "also apply elsewhere" = two-step. */
export const externalLabel = (r: JobRow): string =>
  r.external.kind === "method" ? "apply elsewhere" : r.external.kind === "dual" ? "also apply elsewhere" : "";

export const EXTERNAL_COLUMNS_NOTE = "One row per posting you cannot finish inside WaterlooWorks.";

export const aiSpecificity = (r: JobRow): string =>
  r.ai.matches.length === 0 ? "" : r.ai.mentionsTooling ? "specific tooling" : "generic AI";

/** Any AI mention at all qualifies for the AI sheet; the Specific? column separates the two kinds. */
export const mentionsAI = (r: JobRow): boolean => r.ai.matches.length > 0;

export const bySalaryDesc = (a: JobRow, b: JobRow) => (b.salary.hourly ?? -1) - (a.salary.hourly ?? -1);

const date = (d: Date | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "");

interface Column {
  header: string;
  width: number;
  value: (r: JobRow) => string | number | undefined;
  wrap?: boolean;
}

const BASE_COLUMNS: Column[] = [
  { header: "Job ID", width: 10, value: (r) => r.posting.jobId },
  { header: "Title", width: 40, value: (r) => r.posting.title },
  { header: "Employer", width: 28, value: (r) => r.posting.employer },
  { header: "Location", width: 26, value: (r) => r.posting.location ?? r.posting.city },
  { header: "Openings", width: 10, value: (r) => r.posting.openings },
  { header: "Salary ($/hr)", width: 13, value: (r) => r.salary.hourly },
  { header: "Pay (as listed)", width: 22, value: (r) => formatSalary(r.salary) },
  { header: "Currency", width: 10, value: (r) => r.salary.currency },
  { header: "Pay basis", width: 11, value: (r) => r.salary.unit },
  { header: "Applied", width: 9, value: (r) => (r.posting.applied ? "yes" : "") },
  { header: "Deadline", width: 18, value: (r) => date(r.posting.deadline) },
  { header: "Term", width: 14, value: (r) => r.posting.term },
  { header: "Duration", width: 16, value: (r) => r.posting.workTermDuration },
  { header: "Level", width: 14, value: (r) => r.posting.level },
  { header: "AI", width: 16, value: (r) => aiSpecificity(r) },
  { header: "Apply outside WW", width: 17, value: (r) => externalLabel(r) },
  { header: "Compensation text", width: 60, value: (r) => r.posting.compensation, wrap: true },
  { header: "Job summary", width: 80, value: (r) => r.posting.jobSummary, wrap: true },
];

const AI_COLUMNS: Column[] = [
  ...BASE_COLUMNS.slice(0, 16),
  { header: "AI terms matched", width: 42, value: (r) => r.ai.labels.join(", "), wrap: true },
  { header: "Specific?", width: 16, value: (r) => aiSpecificity(r) },
  { header: "Categories", width: 30, value: (r) => r.ai.categories.join(", ") },
  { header: "Where it says so", width: 90, value: (r) => r.ai.matches.map((m) => `${m.label}: ${m.snippet}`).join("\n\n"), wrap: true },
];

const EXTERNAL_COLUMNS: Column[] = [
  ...BASE_COLUMNS.slice(0, 14),
  { header: "Apply outside WW", width: 17, value: (r) => externalLabel(r) },
  { header: "Application method", width: 20, value: (r) => r.external.method },
  { header: "Where to apply", width: 60, value: (r) => r.external.urls.join("\n"), wrap: true },
  { header: "What the posting says", width: 90, value: (r) => r.external.evidence, wrap: true },
];

function addSheet(wb: ExcelJS.Workbook, name: string, columns: Column[], rows: JobRow[]): void {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.header, width: c.width }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    const row = ws.addRow(columns.map((c) => c.value(r) ?? ""));
    row.alignment = { vertical: "top", wrapText: true };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  const salaryCol = columns.findIndex((c) => c.header === "Salary ($/hr)");
  if (salaryCol >= 0) ws.getColumn(salaryCol + 1).numFmt = "#,##0.00";
}

export interface ExportResult {
  path: string;
  total: number;
  withSalary: number;
  aiTooling: number;
  /** Of `aiTooling`, how many named concrete tooling rather than generic AI wording. */
  aiSpecific: number;
  /** Postings needing an application outside WaterlooWorks. */
  external: number;
  /** Of `external`, how many are applied to entirely outside WaterlooWorks. */
  externalOnly: number;
}

/**
 * Writes one workbook: "All Jobs" (highest pay first), "AI Tooling", and "External Applications" —
 * the postings that cannot be completed inside WaterlooWorks. Every posting whose
 * description mentions AI at all on "AI Tooling", with the matched terms, whether they were
 * concrete tooling or generic AI wording, and the sentences they matched in.
 */
export async function exportWorkbook(postings: JobPosting[], filePath: string): Promise<ExportResult> {
  const rows = analyse(postings).sort(bySalaryDesc);
  const aiRows = rows.filter(mentionsAI);
  const externalRows = rows.filter((r) => r.external.isExternal);

  const wb = new ExcelJS.Workbook();
  wb.creator = "waterlooworks-agent";
  wb.created = new Date();
  addSheet(wb, "All Jobs", BASE_COLUMNS, rows);
  addSheet(wb, "AI Tooling", AI_COLUMNS, aiRows);
  addSheet(wb, "External Applications", EXTERNAL_COLUMNS, externalRows);
  await wb.xlsx.writeFile(filePath);

  return {
    path: filePath,
    total: rows.length,
    withSalary: rows.filter((r) => r.salary.hourly !== undefined).length,
    aiTooling: aiRows.length,
    aiSpecific: aiRows.filter((r) => r.ai.mentionsTooling).length,
    external: externalRows.length,
    externalOnly: externalRows.filter((r) => r.external.kind === "method").length,
  };
}
