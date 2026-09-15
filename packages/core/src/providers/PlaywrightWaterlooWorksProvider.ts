import fs from "node:fs";
import path from "node:path";
import { NotAuthenticatedError, NotFoundError, SelectorError, UnknownStateError, WWError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Application, ApplicationDocument, ApplicationFilters, ApplicationPayload, DocumentType, Job, JobPosting, Resume } from "../models/index.js";
import type { PackageAnalysis, PackageAnalysisRepository } from "../database/repositories.js";
import { findSequence, renderPdf, type GrayPage } from "../services/pdf.js";
import { sha256File } from "../services/hash.js";
import { BrowserSession } from "../browser/BrowserSession.js";
import { LoginPage } from "../browser/LoginPage.js";
import { ApplicationsPage, type AppRow } from "../browser/ApplicationsPage.js";
import { DocumentsPage, type DocRow } from "../browser/DocumentsPage.js";
import { JobsPage, type JobSearchRow } from "../browser/JobsPage.js";
import { ApplyPage } from "../browser/ApplyPage.js";
import { DOC_LABELS, DOC_TYPE_IDS } from "../browser/selectors.js";
import type { PostingInfo } from "../browser/PostingPanel.js";
import { applyFilters, type ScanJobsOptions, type UserDocument, type WaterlooWorksProvider } from "./WaterlooWorksProvider.js";

export interface PlaywrightProviderOptions {
  profileDir: string;
  baseUrl: string;
  headless: boolean;
  log: Logger;
  /** Where downloaded document PDFs are cached (they are immutable on WaterlooWorks). */
  cacheDir: string;
  analyses?: PackageAnalysisRepository;
}

const CATEGORY_BY_TYPE: Partial<Record<DocumentType, string>> = {
  resume: "Résumé",
  cover_letter: "Cover Letter",
  other: "Other - Per Job Posting",
};

/**
 * Live provider. WaterlooWorks keys applications by job ID (one active application per
 * posting), so `applicationId === jobId` throughout this provider.
 */
export class PlaywrightWaterlooWorksProvider implements WaterlooWorksProvider {
  readonly session: BrowserSession;
  private authChecked = false;
  private docCache?: Map<string, DocRow[]>; // category label → rows (per process)
  private renderCache = new Map<string, GrayPage[]>();
  private rowsCache?: { at: number; rows: AppRow[] };
  private static ROWS_TTL_MS = 45_000;

  constructor(private opts: PlaywrightProviderOptions) {
    this.session = new BrowserSession(opts);
    fs.mkdirSync(opts.cacheDir, { recursive: true });
  }

  private async page() {
    return this.session.page();
  }
  private async requireAuth(): Promise<void> {
    if (this.authChecked) return;
    if (!(await this.isAuthenticated())) throw new NotAuthenticatedError();
    this.authChecked = true;
  }

  // ---------------- auth ----------------
  async isAuthenticated(): Promise<boolean> {
    const page = await this.page();
    const ok = await new LoginPage(page, this.session.baseUrl).isAuthenticated();
    if (ok) await this.session.saveState().catch(() => {});
    return ok;
  }
  async login(timeoutMs = 10 * 60_000, onProgress?: (m: string) => void): Promise<boolean> {
    const page = await this.page();
    const ok = await new LoginPage(page, this.session.baseUrl).interactiveLogin(timeoutMs, onProgress);
    if (ok) await this.session.saveState();
    this.authChecked = ok;
    return ok;
  }
  async logout(): Promise<void> {
    const page = await this.page();
    await new LoginPage(page, this.session.baseUrl).logout();
    this.session.clearState();
    this.authChecked = false;
  }

  // ---------------- documents ----------------
  private async docs(category: string): Promise<DocRow[]> {
    this.docCache ??= new Map();
    const hit = this.docCache.get(category);
    if (hit) return hit;
    const page = await this.page();
    const rows = await new DocumentsPage(page, this.session.baseUrl).listCategory(category, true);
    this.docCache.set(category, rows);
    return rows;
  }
  private invalidateDocs() {
    this.docCache = undefined;
    this.rowsCache = undefined;
  }

  /** Applications viewer rows, cached briefly; always bypassed by callers about to mutate. */
  private async allRows(fresh = false): Promise<AppRow[]> {
    if (!fresh && this.rowsCache && Date.now() - this.rowsCache.at < PlaywrightWaterlooWorksProvider.ROWS_TTL_MS) return this.rowsCache.rows;
    const page = await this.page();
    const rows = await new ApplicationsPage(page, this.session.baseUrl).listAll();
    this.rowsCache = { at: Date.now(), rows };
    return rows;
  }

  async listResumes(): Promise<Resume[]> {
    await this.requireAuth();
    const rows = (await this.docs("Résumé")).filter((r) => /r[eé]sum[eé]/i.test(r.type) && !r.isPackage);
    return rows.map((r) => ({ id: r.docId, name: r.name, filename: r.name, uploadedAt: r.createdAt }));
  }

  async uploadResume(filePath: string, displayName?: string): Promise<Resume> {
    const d = await this.uploadDocument(filePath, "resume", displayName);
    return { id: d.id, name: d.name, filename: d.name, uploadedAt: d.uploadedAt, sha256: d.sha256 };
  }

  private userDocLabel(type: DocumentType): string {
    const meta = DOC_LABELS.find((l) => l.type === type);
    if (!meta || meta.system) throw new WWError(`${type} is a system-generated document type; it cannot be listed or uploaded.`, "INVALID_DOC_TYPE");
    return meta.label;
  }

  async listDocuments(type: DocumentType): Promise<UserDocument[]> {
    await this.requireAuth();
    const label = this.userDocLabel(type);
    const rows = (await this.docs(label)).filter((r) => !r.isPackage && !r.archived);
    return rows.map((r) => ({ id: r.docId, type, name: r.name, uploadedAt: r.createdAt, isDefault: r.isDefault }));
  }

  async archiveDocuments(type: DocumentType, ids: string[]): Promise<string[]> {
    await this.requireAuth();
    const label = this.userDocLabel(type);
    const done: string[] = [];
    if (!ids.length) return done;
    const page = await this.page();
    const dp = new DocumentsPage(page, this.session.baseUrl);
    const rows = await dp.listCategory(label, true);
    try {
      for (const id of ids) {
        const row = rows.find((r) => r.docId === id);
        if (!row) throw new NotFoundError(`${label} document`, id);
        if (row.isDefault) throw new WWError(`Document ${id} (${row.name}) is a default ${label}; remove the default flag first.`, "IS_DEFAULT");
        await dp.archiveRow(id);
        done.push(id);
        this.opts.log.info({ type, id, name: row.name }, "document archived");
      }
    } finally {
      this.invalidateDocs();
    }
    return done;
  }

  async setDefaultDocument(type: DocumentType, id: string, isDefault: boolean): Promise<void> {
    await this.requireAuth();
    const label = this.userDocLabel(type);
    const page = await this.page();
    const dp = new DocumentsPage(page, this.session.baseUrl);
    const rows = await dp.listCategory(label, true);
    if (!rows.some((r) => r.docId === id)) throw new NotFoundError(`${label} document`, id);
    try {
      if (isDefault) await dp.setDefaultRow(id);
      else await dp.unsetDefaultRow(id);
    } finally {
      this.invalidateDocs();
    }
  }

  async uploadDocument(filePath: string, type: DocumentType, displayName?: string): Promise<UserDocument> {
    await this.requireAuth();
    const label = this.userDocLabel(type);
    if (!fs.existsSync(filePath)) throw new NotFoundError("File", filePath);
    if (!/\.pdf$/i.test(filePath)) throw new WWError(`Only PDF documents are supported: ${filePath}`, "INVALID_FILE");
    const name = displayName ?? path.basename(filePath, path.extname(filePath));
    const before = await this.listDocuments(type);
    if (before.some((r) => r.name === name)) throw new WWError(`A ${label} document named "${name}" already exists; pick another --name.`, "DUPLICATE_NAME");
    const page = await this.page();
    await new DocumentsPage(page, this.session.baseUrl).uploadDocument(filePath, name, DOC_TYPE_IDS[type]);
    this.invalidateDocs();
    const after = await this.listDocuments(type);
    const created = after.filter((r) => r.name === name && !before.some((b) => b.id === r.id));
    if (created.length !== 1) throw new UnknownStateError(`Upload finished but ${created.length} new ${label} documents named "${name}" are listed; verify manually.`);
    return { ...created[0], sha256: await sha256File(filePath) };
  }

  private cachePath(docId: string) {
    return path.join(this.opts.cacheDir, `${docId}.pdf`);
  }

  /** Ensure the given documents of one category are downloaded; opens the grid at most once. */
  private async downloadDocs(category: string, docIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const missing: string[] = [];
    for (const id of docIds) {
      const p = this.cachePath(id);
      if (fs.existsSync(p) && fs.statSync(p).size > 0) out.set(id, p);
      else missing.push(id);
    }
    if (!missing.length) return out;
    const page = await this.page();
    const dp = new DocumentsPage(page, this.session.baseUrl);
    const rows = await dp.listCategory(category, true);
    const wanted = rows.filter((r) => missing.includes(r.docId));
    const notFound = missing.filter((id) => !wanted.some((r) => r.docId === id));
    if (notFound.length) throw new NotFoundError(`Documents in "${category}"`, notFound.join(","));
    const saved = await dp.downloadMany(wanted, (id) => this.cachePath(id));
    for (const [id, p] of saved) out.set(id, p);
    this.opts.log.debug({ category, count: saved.size }, "downloaded documents");
    return out;
  }

  private async render(file: string): Promise<GrayPage[]> {
    const hit = this.renderCache.get(file);
    if (hit) return hit;
    const pages = await renderPdf(file);
    this.renderCache.set(file, pages);
    return pages;
  }

  /**
   * Identify which user documents make up a package PDF by rendering the package and every
   * candidate document and locating each candidate's pages inside it.
   */
  private async analysePackage(pkg: DocRow, jobId: string, types: DocumentType[]): Promise<PackageAnalysis> {
    const cached = this.opts.analyses?.get(pkg.docId);
    if (cached) return cached;
    const pkgPath = (await this.downloadDocs("Application Packages", [pkg.docId])).get(pkg.docId)!;
    const pkgPages = await this.render(pkgPath);
    const matches: PackageAnalysis["matches"] = [];
    for (const type of types) {
      const category = CATEGORY_BY_TYPE[type];
      if (!category) continue;
      const candidates = (await this.docs(category)).filter((c) => !c.isPackage);
      const paths = await this.downloadDocs(category, candidates.map((c) => c.docId));
      const found: { docId: string; name: string }[] = [];
      for (const c of candidates) {
        try {
          const cPages = await this.render(paths.get(c.docId)!);
          if (findSequence(cPages, pkgPages) >= 0) found.push({ docId: c.docId, name: c.name });
        } catch (e) {
          this.opts.log.warn({ docId: c.docId, err: (e as Error).message }, "could not compare candidate document");
        }
      }
      if (found.length) matches.push({ type, docId: found[0].docId, name: found[0].name, candidates: found });
    }
    const analysis: PackageAnalysis = { packageDocId: pkg.docId, jobId, pageCount: pkgPages.length, matches, analysedAt: new Date().toISOString() };
    this.opts.analyses?.put(analysis);
    return analysis;
  }

  private async latestPackageForJob(jobId: string, notBefore?: Date): Promise<DocRow | undefined> {
    const pkgs = (await this.docs("Application Packages")).filter((p) => p.name.startsWith(`${jobId}-`));
    const eligible = notBefore ? pkgs.filter((p) => !p.createdAt || p.createdAt.getTime() >= notBefore.getTime() - 15 * 60_000) : pkgs;
    return (eligible.length ? eligible : pkgs).sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
  }

  // ---------------- applications ----------------
  private rowToApplication(row: AppRow, posting?: PostingInfo): Application {
    const deadline = posting?.deadline ?? row.deadline;
    const open = /open/i.test(row.jobStatusText ?? "") || (!!deadline && deadline.getTime() > Date.now());
    return {
      id: row.jobId,
      jobId: row.jobId,
      job: {
        id: row.jobId,
        title: posting?.title || row.title,
        employer: posting?.employer || row.employer || "",
        location: [row.city, row.location].filter(Boolean).join(", ") || undefined,
        deadline,
        status: row.jobStatusText ? (open ? "open" : "closed") : deadline ? (open ? "open" : "closed") : "unknown",
      },
      status: row.status,
      submittedAt: row.submittedAt,
      documents: [],
      questions: [],
      canCancel: row.status === "submitted" && row.hasCancelButton,
      canReapply: row.status === "submitted" && row.hasCancelButton && open,
    };
  }

  async listApplications(filters?: ApplicationFilters): Promise<Application[]> {
    await this.requireAuth();
    const rows = await this.allRows();
    let apps = rows.map((r) => this.rowToApplication(r));
    if (filters?.resumeId) {
      // Résumé identity requires package analysis; do it per candidate (cached after first run).
      const detailed: Application[] = [];
      for (const a of apps) if (a.status === "submitted") detailed.push(await this.getApplication(a.id));
      apps = detailed;
    }
    return applyFilters(apps, filters);
  }

  async getApplication(applicationId: string): Promise<Application> {
    await this.requireAuth();
    const page = await this.page();
    const ap = new ApplicationsPage(page, this.session.baseUrl);
    const rows = await this.allRows();
    const row = rows.find((r) => r.jobId === applicationId);
    if (!row) throw new NotFoundError("Application", applicationId);

    // Posting overlay: authoritative deadline + required document types.
    let posting: PostingInfo | undefined;
    if (row.statusLabel) {
      await ap.open();
      await ap.openStatus(row.statusLabel);
      posting = await ap.openPosting(row.jobId).catch((e) => {
        this.opts.log.warn({ jobId: row.jobId, err: (e as Error).message }, "posting panel unreadable");
        return undefined;
      });
    }
    const app = this.rowToApplication(row, posting);

    // Documents: system docs from the requirements list; user docs identified from the package PDF.
    const docs: ApplicationDocument[] = [];
    const requiredTypes = posting?.requiredDocTypes ?? [];
    for (const t of requiredTypes) {
      const meta = DOC_LABELS.find((l) => l.type === t)!;
      if (meta.system) docs.push({ type: t, name: meta.label });
    }
    const pkg = await this.latestPackageForJob(row.jobId, row.submittedAt);
    if (pkg && row.status === "submitted") {
      const userTypes: DocumentType[] = ["resume", "cover_letter", "other"];
      const analysis = await this.analysePackage(pkg, row.jobId, userTypes);
      for (const m of analysis.matches) {
        const ambiguous = m.candidates.length > 1;
        const doc: ApplicationDocument = ambiguous
          ? { type: m.type as DocumentType, id: m.candidates.map((c) => c.docId).join("|"), name: m.candidates.map((c) => c.name).join(" | ") }
          : { type: m.type as DocumentType, id: m.docId, name: m.name };
        docs.push(doc);
        if (m.type === "resume") app.resume = { id: doc.id!, name: doc.name, filename: doc.name };
      }
      if (!analysis.matches.some((m) => m.type === "resume")) {
        this.opts.log.warn({ jobId: row.jobId, packageDocId: pkg.docId }, "no résumé on the account matched the submitted package");
      }
    }
    app.documents = docs;
    return app;
  }

  async cancelApplication(applicationId: string): Promise<void> {
    await this.requireAuth();
    const page = await this.page();
    const ap = new ApplicationsPage(page, this.session.baseUrl);
    await ap.open();
    const statuses = await ap.statuses();
    for (const s of statuses) {
      await ap.open();
      await ap.openStatus(s.label);
      const rows = await ap.readRows();
      const row = rows.find((r) => r.jobId === applicationId);
      if (!row) continue;
      if (row.status !== "submitted") throw new UnknownStateError(`Application ${applicationId} is "${row.appStatusText}", not submitted.`);
      await ap.cancel(applicationId);
      this.invalidateDocs();
      // Verify from a fresh read.
      const after = (await this.allRows(true)).find((r) => r.jobId === applicationId);
      if (after && after.status === "submitted") throw new UnknownStateError(`Application ${applicationId} still shows "${after.appStatusText}" after cancel.`);
      return;
    }
    throw new NotFoundError("Application", applicationId);
  }

  async submitApplication(jobId: string, payload: ApplicationPayload): Promise<Application> {
    await this.requireAuth();
    const page = await this.page();
    const jobs = new JobsPage(page, this.session.baseUrl);
    await jobs.open();
    const row = await jobs.searchById(jobId);
    if (!row) throw new NotFoundError("Job in search results", jobId);
    if (!row.hasApplyButton) throw new SelectorError(`Job ${jobId} has no Apply button (already applied or closed).`);
    const ctx = await this.session.getContext();
    const popup = await jobs.openApplyPopup(ctx, jobId);
    const form = new ApplyPage(popup);
    try {
      const required = await form.requiredDocLabels();
      const requiredTypes = required.map((l) => DOC_LABELS.find((d) => d.label.toLowerCase() === l.toLowerCase())?.type).filter((t): t is DocumentType => !!t);
      // Add system docs the posting requires even if the snapshot did not list them.
      const docs = [...payload.documents];
      for (const t of requiredTypes) if (!docs.some((d) => d.type === t)) docs.push({ type: t, name: DOC_LABELS.find((l) => l.type === t)!.label });
      const resume = docs.find((d) => d.type === "resume");
      if (!resume) throw new SelectorError("Payload has no résumé document.");
      if (!resume.id) resume.id = payload.resumeId;
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      await form.fill({ ...payload, documents: docs }, `${jobId}-ww-${stamp}`);
      await form.submit();
    } finally {
      if (!popup.isClosed()) await popup.close().catch(() => {});
    }
    this.invalidateDocs();
    await page.waitForTimeout(1500);
    const created = (await this.allRows(true)).find((r) => r.jobId === jobId && r.status === "submitted");
    if (!created) throw new UnknownStateError(`Submitted job ${jobId} but it is not listed as submitted; verify manually.`);
    return this.getApplication(jobId);
  }

  async getJob(jobId: string): Promise<Job> {
    await this.requireAuth();
    const page = await this.page();
    const jobs = new JobsPage(page, this.session.baseUrl);
    await jobs.open();
    const row = await jobs.searchById(jobId);
    if (row) {
      const posting = await jobs.openPosting(jobId).catch(() => undefined);
      const deadline = posting?.deadline ?? row.deadline;
      return {
        id: jobId,
        title: posting?.title || row.title,
        employer: posting?.employer || row.employer || "",
        location: row.city,
        deadline,
        status: deadline ? (deadline.getTime() > Date.now() ? "open" : "closed") : "unknown",
      };
    }
    // Not searchable (closed/removed): fall back to the applications viewer.
    const app = (await this.allRows()).find((r) => r.jobId === jobId);
    if (!app) throw new NotFoundError("Job", jobId);
    return this.rowToApplication(app).job!;
  }


  async scanJobs(opts: ScanJobsOptions = {}): Promise<JobPosting[]> {
    await this.requireAuth();
    const page = await this.page();
    const jobs = new JobsPage(page, this.session.baseUrl);
    await jobs.open();
    if (opts.myProgramOnly) await jobs.setMyProgramFilter(true);

    const postings: JobPosting[] = [];
    await jobs.listAll({
      maxRows: opts.maxJobs,
      onPage: opts.onProgress,
      onRow: async (row) => {
        if (opts.skip?.(row.jobId)) return;
        try {
          const info = await jobs.openPosting(row.jobId);
          const posting = postingFromPanel(row, info);
          postings.push(posting);
          opts.onPosting?.(posting);
        } catch (err) {
          this.opts.log.warn({ jobId: row.jobId, err: String(err) }, "posting read failed");
          opts.onError?.(row.jobId, err);
        }
      },
    });
    return postings;
  }

  /** Debug helper for selector calibration. */
  async dumpPage(sitePath: string): Promise<{ url: string; html: string }> {
    const page = await this.page();
    await page.goto(this.session.url(sitePath), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    return { url: page.url(), html: await page.content() };
  }

  /** Hash helper exposed for the CLI (`ww resume hash`). */
  async hashLocalFile(p: string) {
    return sha256File(p);
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

/** Merge a search-results row with its posting panel into a JobPosting. */
function postingFromPanel(row: JobSearchRow, info: PostingInfo): JobPosting {
  const s = info.sections;
  const city = s["Job - City"] || row.city;
  const country = s["Job - Country"];
  const province = s["Job - Province/State"];
  return {
    jobId: row.jobId,
    title: info.title || row.title,
    employer: info.employer || row.employer || "",
    division: info.division ?? s["Division"],
    city,
    location: [city, province, country].filter(Boolean).join(", ") || undefined,
    term: s["Work Term"],
    openings: s["Number of Job Openings"],
    level: s["Level"],
    workTermDuration: s["Work Term Duration"],
    deadline: info.deadline ?? row.deadline,
    applied: row.appliedHint || !row.hasApplyButton,
    compensation: s["Compensation and Benefits"],
    jobSummary: s["Job Summary"],
    jobResponsibilities: s["Job Responsibilities"],
    requiredSkills: s["Required Skills"],
    specialRequirements: s["Special Job Requirements"],
    transportationHousing: s["Transportation and Housing"],
    targetedDisciplines: s["Targeted Degrees and Disciplines"],
    additionalInfo: info.additionalInfo,
    applicationMethod: s["Application Method"],
    requiredDocuments: s["Application Documents Required"],
    sections: s,
    scrapedAt: new Date(),
  };
}
