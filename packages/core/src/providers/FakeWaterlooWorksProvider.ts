import path from "node:path";
import fs from "node:fs";
import { NotFoundError, IneligibleError, NotAuthenticatedError } from "../errors.js";
import { newId } from "../ids.js";
import { sha256File } from "../services/hash.js";
import type { Application, ApplicationPayload, ApplicationFilters, DocumentType, Job, Resume } from "../models/index.js";
import { applyFilters, type UserDocument, type WaterlooWorksProvider } from "./WaterlooWorksProvider.js";

export interface FakeOptions {
  authenticated?: boolean;
  /** Inject a failure at a given step, for testing the state machine. */
  failOn?: { cancel?: Set<string>; submit?: Set<string> };
  /** If set, the submitted application will silently drop this document type (verification test). */
  dropDocumentTypeOnSubmit?: string;
  now?: () => Date;
}

/**
 * In-memory provider for tests and offline demos. Behaves like WaterlooWorks:
 * cancelling an application marks it cancelled; submitting creates a new one.
 */
export class FakeWaterlooWorksProvider implements WaterlooWorksProvider {
  jobs = new Map<string, Job>();
  resumes = new Map<string, Resume>();
  applications = new Map<string, Application>();
  /** Non-résumé user documents (cover letters, "other"). */
  documents = new Map<string, UserDocument>();
  archived = new Set<string>();
  defaults = new Set<string>();
  readonly calls: { op: string; args: unknown[] }[] = [];

  constructor(private opts: FakeOptions = {}) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }
  private assertAuth() {
    if (this.opts.authenticated === false) throw new NotAuthenticatedError();
  }

  async isAuthenticated() {
    return this.opts.authenticated !== false;
  }

  async listApplications(filters?: ApplicationFilters) {
    this.assertAuth();
    this.calls.push({ op: "listApplications", args: [filters] });
    return applyFilters([...this.applications.values()].map((a) => this.refresh(a)), filters);
  }

  async getApplication(id: string) {
    this.assertAuth();
    this.calls.push({ op: "getApplication", args: [id] });
    const a = this.applications.get(id);
    if (!a) throw new NotFoundError("Application", id);
    return this.refresh(a);
  }

  async listResumes() {
    this.assertAuth();
    return [...this.resumes.values()];
  }

  async uploadResume(filePath: string, displayName?: string) {
    this.assertAuth();
    this.calls.push({ op: "uploadResume", args: [filePath, displayName] });
    if (!fs.existsSync(filePath)) throw new NotFoundError("File", filePath);
    const r: Resume = {
      id: newId("res"),
      name: displayName ?? path.basename(filePath),
      filename: path.basename(filePath),
      uploadedAt: this.now(),
      sha256: await sha256File(filePath),
    };
    this.resumes.set(r.id, r);
    return r;
  }

  async listDocuments(type: DocumentType): Promise<UserDocument[]> {
    this.assertAuth();
    const all: UserDocument[] =
      type === "resume"
        ? [...this.resumes.values()].map((r) => ({ id: r.id, type, name: r.name, uploadedAt: r.uploadedAt, sha256: r.sha256 }))
        : [...this.documents.values()].filter((d) => d.type === type);
    return all.filter((d) => !this.archived.has(d.id)).map((d) => ({ ...d, isDefault: this.defaults.has(d.id) }));
  }

  async archiveDocuments(type: DocumentType, ids: string[]): Promise<string[]> {
    this.assertAuth();
    const done: string[] = [];
    const listed = await this.listDocuments(type);
    for (const id of ids) {
      const d = listed.find((x) => x.id === id);
      if (!d) throw new NotFoundError(`${type} document`, id);
      if (this.defaults.has(id)) throw new IneligibleError(`Document ${id} is a default; remove the default flag first.`, "unknown_state");
      this.calls.push({ op: "archiveDocument", args: [type, id] });
      this.archived.add(id);
      done.push(id);
    }
    return done;
  }

  async setDefaultDocument(type: DocumentType, id: string, isDefault: boolean): Promise<void> {
    this.assertAuth();
    if (!(await this.listDocuments(type)).some((d) => d.id === id)) throw new NotFoundError(`${type} document`, id);
    this.calls.push({ op: "setDefaultDocument", args: [type, id, isDefault] });
    if (isDefault) this.defaults.add(id);
    else this.defaults.delete(id);
  }

  async uploadDocument(filePath: string, type: DocumentType, displayName?: string): Promise<UserDocument> {
    this.assertAuth();
    if (type === "resume") {
      const r = await this.uploadResume(filePath, displayName);
      return { id: r.id, type, name: r.name, uploadedAt: r.uploadedAt, sha256: r.sha256 };
    }
    this.calls.push({ op: "uploadDocument", args: [filePath, type, displayName] });
    if (!fs.existsSync(filePath)) throw new NotFoundError("File", filePath);
    const d: UserDocument = { id: newId("doc"), type, name: displayName ?? path.basename(filePath), uploadedAt: this.now(), sha256: await sha256File(filePath) };
    this.documents.set(d.id, d);
    return d;
  }

  async cancelApplication(id: string) {
    this.assertAuth();
    this.calls.push({ op: "cancelApplication", args: [id] });
    const a = this.applications.get(id);
    if (!a) throw new NotFoundError("Application", id);
    if (this.opts.failOn?.cancel?.has(id)) throw new Error(`Injected cancel failure for ${id}`);
    if (!this.refresh(a).canCancel) throw new IneligibleError(`Application ${id} cannot be cancelled`, "cannot_cancel");
    a.status = "cancelled";
    a.canCancel = false;
  }

  async submitApplication(jobId: string, payload: ApplicationPayload) {
    this.assertAuth();
    this.calls.push({ op: "submitApplication", args: [jobId, payload] });
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundError("Job", jobId);
    if (this.opts.failOn?.submit?.has(jobId)) throw new Error(`Injected submit failure for job ${jobId}`);
    if (job.deadline && job.deadline.getTime() < this.now().getTime())
      throw new IneligibleError(`Deadline passed for job ${jobId}`, "deadline_passed");
    const resume = this.resumes.get(payload.resumeId);
    if (!resume) throw new NotFoundError("Resume", payload.resumeId);
    const docs = payload.documents.filter((d) => d.type !== this.opts.dropDocumentTypeOnSubmit);
    const app: Application = {
      id: newId("app"),
      jobId,
      job,
      status: "submitted",
      submittedAt: this.now(),
      resume,
      documents: [{ type: "resume", name: resume.name, id: resume.id }, ...docs.filter((d) => d.type !== "resume")],
      questions: [...payload.questions],
      canCancel: true,
      canReapply: true,
    };
    this.applications.set(app.id, app);
    return app;
  }

  async getJob(jobId: string) {
    this.assertAuth();
    const j = this.jobs.get(jobId);
    if (!j) throw new NotFoundError("Job", jobId);
    return j;
  }

  async close() {}

  /** Recompute deadline-dependent fields, mirroring what a live read would show. */
  private refresh(a: Application): Application {
    const job = this.jobs.get(a.jobId);
    const expired = !!job?.deadline && job.deadline.getTime() < this.now().getTime();
    const copy: Application = { ...a, job, documents: [...a.documents], questions: [...a.questions] };
    if (a.status === "submitted") {
      copy.canCancel = a.canCancel && !expired;
      copy.canReapply = !expired;
    }
    return copy;
  }

  // ---- seeding helpers ----
  seedJob(j: Partial<Job> & { id: string }): Job {
    const job: Job = { title: `Job ${j.id}`, employer: "Employer", status: "open", ...j };
    this.jobs.set(job.id, job);
    return job;
  }
  seedResume(r: Partial<Resume> & { id: string }): Resume {
    const res: Resume = { name: r.id, filename: `${r.id}.pdf`, ...r };
    this.resumes.set(res.id, res);
    return res;
  }
  seedDocument(d: { id: string; type: DocumentType; name?: string }): UserDocument {
    const doc: UserDocument = { name: d.id, ...d };
    this.documents.set(doc.id, doc);
    return doc;
  }
  seedApplication(a: Partial<Application> & { id: string; jobId: string; resume: Resume }): Application {
    const app: Application = {
      status: "submitted",
      submittedAt: this.now(),
      documents: [{ type: "resume", name: a.resume.name, id: a.resume.id }],
      questions: [],
      canCancel: true,
      canReapply: true,
      ...a,
    };
    this.applications.set(app.id, app);
    return app;
  }
}
