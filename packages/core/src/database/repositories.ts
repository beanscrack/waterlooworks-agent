import type { DB } from "./db.js";
import {
  ApplicationSnapshotSchema,
  BatchReplacementPlanSchema,
  JobPostingSchema,
  type ApplicationSnapshot,
  type BatchReplacementPlan,
  type JobPosting,
  type Operation,
  type Resume,
  type ReplacementState,
  INCOMPLETE_STATES,
} from "../models/index.js";

const iso = (d: Date | undefined) => (d ? d.toISOString() : null);
const date = (s: unknown) => (typeof s === "string" ? new Date(s) : undefined);
const str = (s: unknown) => (typeof s === "string" ? s : undefined);

export class ResumeRepository {
  constructor(private db: DB) {}
  upsert(r: Resume): void {
    this.db
      .prepare(
        `INSERT INTO resumes (id, name, filename, sha256, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, filename=excluded.filename,
           sha256=COALESCE(excluded.sha256, resumes.sha256)`,
      )
      .run(r.id, r.name, r.filename, r.sha256 ?? null, (r.uploadedAt ?? new Date()).toISOString());
  }
  get(id: string): Resume | undefined {
    const row = this.db.prepare(`SELECT * FROM resumes WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToResume(row) : undefined;
  }
  list(): Resume[] {
    return (this.db.prepare(`SELECT * FROM resumes ORDER BY created_at`).all() as Record<string, unknown>[]).map(rowToResume);
  }
}
function rowToResume(row: Record<string, unknown>): Resume {
  return {
    id: row.id as string,
    name: row.name as string,
    filename: row.filename as string,
    sha256: str(row.sha256),
    uploadedAt: date(row.created_at),
  };
}

export class SnapshotRepository {
  constructor(private db: DB) {}
  insert(s: ApplicationSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO application_snapshots (id, application_id, job_id, snapshot_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.applicationId, s.jobId, JSON.stringify(s), s.capturedAt.toISOString());
  }
  get(id: string): ApplicationSnapshot | undefined {
    const row = this.db.prepare(`SELECT snapshot_json FROM application_snapshots WHERE id = ?`).get(id) as
      | { snapshot_json: string }
      | undefined;
    return row ? ApplicationSnapshotSchema.parse(JSON.parse(row.snapshot_json)) : undefined;
  }
  latestForApplication(applicationId: string): ApplicationSnapshot | undefined {
    const row = this.db
      .prepare(`SELECT snapshot_json FROM application_snapshots WHERE application_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(applicationId) as { snapshot_json: string } | undefined;
    return row ? ApplicationSnapshotSchema.parse(JSON.parse(row.snapshot_json)) : undefined;
  }
  latestForJob(jobId: string): ApplicationSnapshot | undefined {
    const row = this.db
      .prepare(`SELECT snapshot_json FROM application_snapshots WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(jobId) as { snapshot_json: string } | undefined;
    return row ? ApplicationSnapshotSchema.parse(JSON.parse(row.snapshot_json)) : undefined;
  }
}

export class PlanRepository {
  constructor(private db: DB) {}
  insert(p: BatchReplacementPlan): void {
    this.db
      .prepare(
        `INSERT INTO replacement_plans (id, old_resume_id, new_resume_id, plan_json, created_at, executed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.oldResumeId, p.newResumeId, JSON.stringify(p), p.createdAt.toISOString(), iso(p.executedAt));
  }
  get(id: string): BatchReplacementPlan | undefined {
    const row = this.db.prepare(`SELECT plan_json, executed_at FROM replacement_plans WHERE id = ?`).get(id) as
      | { plan_json: string; executed_at: string | null }
      | undefined;
    if (!row) return undefined;
    const plan = BatchReplacementPlanSchema.parse(JSON.parse(row.plan_json));
    plan.executedAt = date(row.executed_at);
    return plan;
  }
  markExecuted(id: string, at: Date): void {
    this.db.prepare(`UPDATE replacement_plans SET executed_at = ? WHERE id = ?`).run(at.toISOString(), id);
  }
  list(): BatchReplacementPlan[] {
    const rows = this.db.prepare(`SELECT plan_json, executed_at FROM replacement_plans ORDER BY created_at DESC`).all() as {
      plan_json: string;
      executed_at: string | null;
    }[];
    return rows.map((r) => {
      const p = BatchReplacementPlanSchema.parse(JSON.parse(r.plan_json));
      p.executedAt = date(r.executed_at);
      return p;
    });
  }
}

export class OperationRepository {
  constructor(private db: DB) {}
  insert(op: Operation): void {
    this.db
      .prepare(
        `INSERT INTO operations (id, plan_id, application_id, new_application_id, job_id, snapshot_id, operation_type,
           state, old_resume_id, new_resume_id, started_at, completed_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        op.id,
        op.planId ?? null,
        op.applicationId,
        op.newApplicationId ?? null,
        op.jobId ?? null,
        op.snapshotId ?? null,
        op.operationType,
        op.state,
        op.oldResumeId ?? null,
        op.newResumeId ?? null,
        op.startedAt.toISOString(),
        iso(op.completedAt),
        op.error ?? null,
      );
  }
  update(op: Operation): void {
    this.db
      .prepare(
        `UPDATE operations SET state=?, new_application_id=?, snapshot_id=?, job_id=?, new_resume_id=?, completed_at=?, error=? WHERE id=?`,
      )
      .run(op.state, op.newApplicationId ?? null, op.snapshotId ?? null, op.jobId ?? null, op.newResumeId ?? null, iso(op.completedAt), op.error ?? null, op.id);
  }
  setState(op: Operation, state: ReplacementState, extra: Partial<Operation> = {}): Operation {
    Object.assign(op, extra, { state });
    if (state === "verified" || state === "failed") op.completedAt = new Date();
    this.update(op);
    return op;
  }
  get(id: string): Operation | undefined {
    const row = this.db.prepare(`SELECT * FROM operations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToOp(row) : undefined;
  }
  listIncomplete(): Operation[] {
    const placeholders = [...INCOMPLETE_STATES].map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM operations WHERE state IN (${placeholders}) ORDER BY started_at`)
      .all(...INCOMPLETE_STATES) as Record<string, unknown>[];
    return rows.map(rowToOp);
  }
  listForApplication(applicationId: string): Operation[] {
    return (
      this.db.prepare(`SELECT * FROM operations WHERE application_id = ? ORDER BY started_at`).all(applicationId) as Record<
        string,
        unknown
      >[]
    ).map(rowToOp);
  }
  listForJob(jobId: string): Operation[] {
    return (
      this.db.prepare(`SELECT * FROM operations WHERE job_id = ? ORDER BY started_at`).all(jobId) as Record<string, unknown>[]
    ).map(rowToOp);
  }
  /** Has a verified replace_resume op already produced newResumeId for this job? */
  hasVerifiedReplacement(jobId: string, newResumeId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM operations WHERE job_id = ? AND new_resume_id = ? AND state = 'verified' LIMIT 1`,
      )
      .get(jobId, newResumeId);
    return !!row;
  }
  listAll(limit = 200): Operation[] {
    return (
      this.db.prepare(`SELECT * FROM operations ORDER BY started_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[]
    ).map(rowToOp);
  }
}

function rowToOp(row: Record<string, unknown>): Operation {
  return {
    id: row.id as string,
    planId: str(row.plan_id),
    applicationId: row.application_id as string,
    newApplicationId: str(row.new_application_id),
    jobId: str(row.job_id),
    snapshotId: str(row.snapshot_id),
    operationType: row.operation_type as Operation["operationType"],
    state: row.state as ReplacementState,
    oldResumeId: str(row.old_resume_id),
    newResumeId: str(row.new_resume_id),
    startedAt: new Date(row.started_at as string),
    completedAt: date(row.completed_at),
    error: str(row.error),
  };
}

/** Cached result of identifying the documents inside an immutable application-package PDF. */
export interface PackageAnalysis {
  packageDocId: string;
  jobId: string;
  pageCount: number;
  /** Matched user documents, by our type. `candidates` lists all equally-matching doc IDs (ambiguity). */
  matches: { type: string; docId: string; name: string; candidates: { docId: string; name: string }[] }[];
  analysedAt: string;
}

export class PackageAnalysisRepository {
  constructor(private db: DB) {}
  get(packageDocId: string): PackageAnalysis | undefined {
    const row = this.db.prepare(`SELECT analysis_json FROM package_analyses WHERE package_doc_id = ?`).get(packageDocId) as
      | { analysis_json: string }
      | undefined;
    return row ? (JSON.parse(row.analysis_json) as PackageAnalysis) : undefined;
  }
  put(a: PackageAnalysis): void {
    this.db
      .prepare(
        `INSERT INTO package_analyses (package_doc_id, job_id, analysis_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(package_doc_id) DO UPDATE SET analysis_json = excluded.analysis_json`,
      )
      .run(a.packageDocId, a.jobId, JSON.stringify(a), a.analysedAt);
  }
}

export class JobPostingRepository {
  constructor(private db: DB) {}
  /** `scope` distinguishes a "my program" scan from an all-jobs scan. */
  put(p: JobPosting, scope: string): void {
    this.db
      .prepare(
        `INSERT INTO job_postings (job_id, scope, posting_json, scraped_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET scope = excluded.scope,
           posting_json = excluded.posting_json, scraped_at = excluded.scraped_at`,
      )
      .run(p.jobId, scope, JSON.stringify(p), p.scrapedAt.toISOString());
  }
  get(jobId: string): JobPosting | undefined {
    const row = this.db.prepare(`SELECT posting_json FROM job_postings WHERE job_id = ?`).get(jobId) as
      | { posting_json: string }
      | undefined;
    return row ? JobPostingSchema.parse(JSON.parse(row.posting_json)) : undefined;
  }
  list(scope?: string): JobPosting[] {
    const rows = (
      scope
        ? this.db.prepare(`SELECT posting_json FROM job_postings WHERE scope = ? ORDER BY job_id`).all(scope)
        : this.db.prepare(`SELECT posting_json FROM job_postings ORDER BY job_id`).all()
    ) as { posting_json: string }[];
    return rows.map((r) => JobPostingSchema.parse(JSON.parse(r.posting_json)));
  }
  /** Job IDs already scraped, for resuming an interrupted scan. */
  ids(scope?: string): Set<string> {
    return new Set(this.list(scope).map((p) => p.jobId));
  }
  clear(scope: string): void {
    this.db.prepare(`DELETE FROM job_postings WHERE scope = ?`).run(scope);
  }
}

export interface Repositories {
  resumes: ResumeRepository;
  jobPostings: JobPostingRepository;
  packageAnalyses: PackageAnalysisRepository;
  snapshots: SnapshotRepository;
  plans: PlanRepository;
  operations: OperationRepository;
}

export function createRepositories(db: DB): Repositories {
  return {
    resumes: new ResumeRepository(db),
    jobPostings: new JobPostingRepository(db),
    packageAnalyses: new PackageAnalysisRepository(db),
    snapshots: new SnapshotRepository(db),
    plans: new PlanRepository(db),
    operations: new OperationRepository(db),
  };
}
