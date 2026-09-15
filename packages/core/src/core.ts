import path from "node:path";
import { loadConfig, type WWConfig } from "./config.js";
import { openDatabase, type DB } from "./database/db.js";
import { createRepositories, type Repositories } from "./database/repositories.js";
import { createLogger, logEvent, type Logger } from "./logger.js";
import type { ApplicationFilters, ApplicationSnapshot, DocumentType, Resume } from "./models/index.js";
import { NotFoundError } from "./errors.js";
import { FakeWaterlooWorksProvider } from "./providers/FakeWaterlooWorksProvider.js";
import { PlaywrightWaterlooWorksProvider } from "./providers/PlaywrightWaterlooWorksProvider.js";
import type { WaterlooWorksProvider } from "./providers/WaterlooWorksProvider.js";
import { BatchReplacementService, type ProgressFn } from "./services/BatchReplacementService.js";
import { RecoveryService } from "./services/RecoveryService.js";
import { DocumentCleanupService, type CleanupPlan } from "./services/DocumentCleanupService.js";
import { ReplacementService, type DocumentOverride, type ReplaceOptions } from "./services/ReplacementService.js";
import { SnapshotService } from "./services/SnapshotService.js";
import { JobScanService, scopeOf, type ScanOptions } from "./services/JobScanService.js";
import { exportWorkbook } from "./services/JobExportService.js";

/** Facade used by both the CLI and the MCP server (spec section 2). */
export class WaterlooWorksCore {
  readonly repos: Repositories;
  readonly snapshots: SnapshotService;
  readonly replacement: ReplacementService;
  readonly batch: BatchReplacementService;
  readonly recovery: RecoveryService;
  readonly cleanup: DocumentCleanupService;
  readonly jobScan: JobScanService;

  constructor(
    readonly config: WWConfig,
    readonly provider: WaterlooWorksProvider,
    readonly db: DB,
    readonly log: Logger,
  ) {
    this.repos = createRepositories(db);
    this.snapshots = new SnapshotService(provider, this.repos.snapshots, log);
    this.replacement = new ReplacementService(provider, this.repos, log);
    this.batch = new BatchReplacementService(provider, this.repos, this.replacement, log);
    this.recovery = new RecoveryService(provider, this.repos, this.replacement, log);
    this.cleanup = new DocumentCleanupService(provider, log);
    this.jobScan = new JobScanService(provider, this.repos.jobPostings, log);
  }

  // ---- Level 0: read-only ----
  isAuthenticated() {
    return this.provider.isAuthenticated();
  }
  async listResumes(): Promise<Resume[]> {
    const rs = await this.provider.listResumes();
    for (const r of rs) this.repos.resumes.upsert(r);
    return rs;
  }
  listApplications(filters?: ApplicationFilters) {
    return this.provider.listApplications(filters);
  }
  getApplication(id: string) {
    return this.provider.getApplication(id);
  }
  getJob(id: string) {
    return this.provider.getJob(id);
  }
  resolveResume(idOrName: string) {
    return this.replacement.resolveResume(idOrName);
  }
  listDocuments(type: DocumentType) {
    return this.provider.listDocuments(type);
  }
  /** Resolve a user document of one type by ID or (unique) name into a document override. */
  async resolveDocument(type: DocumentType, idOrName: string): Promise<DocumentOverride> {
    const docs = await this.provider.listDocuments(type);
    const byId = docs.find((d) => d.id === idOrName);
    const byName = docs.filter((d) => d.name === idOrName);
    const d = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (!d) {
      if (byName.length > 1) throw new NotFoundError(`Unique ${type} document`, `${idOrName} (matches ${byName.length}; use the ID)`);
      throw new NotFoundError(`${type} document`, idOrName);
    }
    return { type, id: d.id, name: d.name };
  }

  // ---- Level 1: local ----
  snapshotApplication(id: string): Promise<ApplicationSnapshot> {
    return this.snapshots.snapshotApplication(id);
  }
  previewResumeReplacement(input: { oldResumeId: string; newResumeId: string }) {
    return this.batch.previewResumeReplacement(input);
  }
  getPlan(planId: string) {
    return this.repos.plans.get(planId);
  }
  listPlans() {
    return this.repos.plans.list();
  }
  listIncompleteOperations() {
    return this.recovery.listIncomplete();
  }
  /** Cached postings; `myProgramOnly` selects the scope a scan stored them under. */
  listJobPostings(myProgramOnly?: boolean) {
    return this.jobScan.list(myProgramOnly === undefined ? undefined : scopeOf(myProgramOnly));
  }
  /** Write the two-sheet spreadsheet from whatever is cached. */
  async exportJobs(filePath: string, myProgramOnly?: boolean) {
    const result = await exportWorkbook(this.listJobPostings(myProgramOnly), filePath);
    logEvent(this.log, "JOBS_EXPORTED", { path: result.path, total: result.total, aiTooling: result.aiTooling });
    return result;
  }
  listOperations(limit?: number) {
    return this.repos.operations.listAll(limit);
  }

  /** Reads the job search + every posting panel into SQLite. Read-only against WaterlooWorks. */
  scanJobs(opts?: ScanOptions) {
    return this.jobScan.scan(opts);
  }

  // ---- Level 2: external mutation ----
  async uploadResume(filePath: string, displayName?: string): Promise<Resume> {
    const r = await this.provider.uploadResume(filePath, displayName);
    this.repos.resumes.upsert(r);
    logEvent(this.log, "RESUME_UPLOADED", { resumeId: r.id, name: r.name, sha256: r.sha256 });
    return r;
  }
  planDocumentCleanup(input?: { defaultResume?: string; keep?: string[] }) {
    return this.cleanup.plan(input);
  }
  executeDocumentCleanup(plan: CleanupPlan) {
    return this.cleanup.execute(plan);
  }
  async archiveDocuments(type: DocumentType, ids: string[]) {
    const done = await this.provider.archiveDocuments(type, ids);
    for (const id of done) logEvent(this.log, "DOCUMENT_ARCHIVED", { id, type });
    return done;
  }
  async setDefaultDocument(type: DocumentType, id: string, isDefault: boolean) {
    await this.provider.setDefaultDocument(type, id, isDefault);
    logEvent(this.log, "DOCUMENT_DEFAULT_CHANGED", { id, isDefault });
  }
  async uploadDocument(filePath: string, type: DocumentType, displayName?: string) {
    const d = await this.provider.uploadDocument(filePath, type, displayName);
    logEvent(this.log, "DOCUMENT_UPLOADED", { documentId: d.id, type, name: d.name, sha256: d.sha256 });
    return d;
  }
  replaceApplicationResume(applicationId: string, newResumeId: string, options?: ReplaceOptions) {
    return this.replacement.replaceApplicationResume(applicationId, newResumeId, options);
  }
  executeResumeReplacement(planId: string, onProgress?: ProgressFn) {
    return this.batch.executeResumeReplacement(planId, onProgress);
  }
  recover(jobOrOperationId: string, opts?: { dryRun?: boolean; resumeId?: string; documentOverrides?: DocumentOverride[] }) {
    return this.recovery.recover(jobOrOperationId, opts);
  }

  async close() {
    await this.provider.close();
    this.db.close();
  }
}

export interface CreateCoreOptions {
  config?: Partial<WWConfig>;
  provider?: WaterlooWorksProvider;
  log?: Logger;
  /** In-memory DB (tests). */
  memoryDb?: boolean;
}

export function createCore(opts: CreateCoreOptions = {}): WaterlooWorksCore {
  const config = loadConfig(opts.config);
  const log = opts.log ?? createLogger({ level: config.logLevel });
  const db = openDatabase(opts.memoryDb ? ":memory:" : config.dbPath);
  const repos = createRepositories(db);
  const provider =
    opts.provider ??
    (config.fake
      ? new FakeWaterlooWorksProvider()
      : new PlaywrightWaterlooWorksProvider({
          profileDir: config.browserProfileDir,
          baseUrl: config.baseUrl,
          headless: config.headless,
          log,
          cacheDir: path.join(path.dirname(config.dbPath), "docs"),
          analyses: repos.packageAnalyses,
        }));
  return new WaterlooWorksCore(config, provider, db, log);
}
