import type {
  Application,
  ApplicationDocument,
  ApplicationFilters,
  ApplicationPayload,
  DocumentType,
  Job,
  JobPosting,
  Resume,
} from "../models/index.js";

/** A user-uploaded document as listed on the documents page. */
export interface UserDocument extends ApplicationDocument {
  id: string;
  uploadedAt?: Date;
  sha256?: string;
  /** Marked as the default document of its type (used by the "Default Application Package"). */
  isDefault?: boolean;
}

/**
 * All WaterlooWorks access goes through this interface (spec section 6).
 * Business logic must never touch Playwright directly.
 */
export interface WaterlooWorksProvider {
  isAuthenticated(): Promise<boolean>;
  listApplications(filters?: ApplicationFilters): Promise<Application[]>;
  getApplication(applicationId: string): Promise<Application>;
  listResumes(): Promise<Resume[]>;
  uploadResume(filePath: string, displayName?: string): Promise<Resume>;
  /** User documents of one type (resume, cover_letter, other). System documents are not listable. */
  listDocuments(type: DocumentType): Promise<UserDocument[]>;
  /** Upload a PDF as the given user document type (resume, cover_letter, other). */
  uploadDocument(filePath: string, type: DocumentType, displayName?: string): Promise<UserDocument>;
  /** Archive (reversible in the UI) documents of one type. Defaults must be un-defaulted first. Returns archived IDs, in order; stops at the first failure. */
  archiveDocuments(type: DocumentType, ids: string[]): Promise<string[]>;
  /** Flag / unflag a document as the default of its type. */
  setDefaultDocument(type: DocumentType, id: string, isDefault: boolean): Promise<void>;
  cancelApplication(applicationId: string): Promise<void>;
  submitApplication(jobId: string, payload: ApplicationPayload): Promise<Application>;
  getJob(jobId: string): Promise<Job>;
  /** Walk the job search results and read each posting panel. */
  scanJobs(opts?: ScanJobsOptions): Promise<JobPosting[]>;
  /** Release browser/network resources. */
  close(): Promise<void>;
}

export interface ScanJobsOptions {
  /** Restrict results to the student's own program via the "My Program" quick filter. */
  myProgramOnly?: boolean;
  maxJobs?: number;
  /** Return true to leave a job unread (already cached). Its row is still counted. */
  skip?: (jobId: string) => boolean;
  /** Called as each posting is read, so callers can persist incrementally. */
  onPosting?: (posting: JobPosting) => void;
  /** Called when a posting cannot be read; the scan continues. */
  onError?: (jobId: string, error: unknown) => void;
  onProgress?: (seen: number, total?: number) => void;
}

/** Shared, provider-agnostic filter logic so every provider filters identically. */
export function applyFilters(apps: Application[], f?: ApplicationFilters): Application[] {
  if (!f) return apps;
  return apps.filter((a) => {
    if (f.status && a.status !== f.status) return false;
    if (f.resumeId && a.resume?.id !== f.resumeId) return false;
    if (f.editableOnly && !(a.canCancel && a.canReapply)) return false;
    if (f.deadlineAfter) {
      const d = a.job?.deadline;
      if (!d || d.getTime() <= f.deadlineAfter.getTime()) return false;
    }
    return true;
  });
}
