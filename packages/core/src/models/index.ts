import { z } from "zod";

// ---------- Domain models (section 4) ----------

export const JobStatusSchema = z.enum(["open", "closed", "unknown"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSchema = z.object({
  id: z.string(),
  title: z.string(),
  employer: z.string(),
  location: z.string().optional(),
  deadline: z.coerce.date().optional(),
  status: JobStatusSchema,
  url: z.string().optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const ResumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  filename: z.string(),
  uploadedAt: z.coerce.date().optional(),
  sha256: z.string().optional(),
});
export type Resume = z.infer<typeof ResumeSchema>;

export const DocumentTypeSchema = z.enum([
  "resume",
  "cover_letter",
  "transcript",
  "work_history",
  "other",
]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const ApplicationDocumentSchema = z.object({
  id: z.string().optional(),
  type: DocumentTypeSchema,
  name: z.string(),
});
export type ApplicationDocument = z.infer<typeof ApplicationDocumentSchema>;

export const ApplicationQuestionAnswerSchema = z.object({
  question: z.string(),
  answer: z.string(),
});
export type ApplicationQuestionAnswer = z.infer<typeof ApplicationQuestionAnswerSchema>;

export const ApplicationStatusSchema = z.enum(["submitted", "cancelled", "expired", "unknown"]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const ApplicationSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  job: JobSchema.optional(),
  status: ApplicationStatusSchema,
  submittedAt: z.coerce.date().optional(),
  resume: ResumeSchema.optional(),
  documents: z.array(ApplicationDocumentSchema),
  questions: z.array(ApplicationQuestionAnswerSchema),
  canCancel: z.boolean(),
  canReapply: z.boolean(),
});
export type Application = z.infer<typeof ApplicationSchema>;

// ---------- Filters (section 8) ----------

export const ApplicationFiltersSchema = z.object({
  status: z.enum(["submitted", "cancelled", "expired"]).optional(),
  resumeId: z.string().optional(),
  editableOnly: z.boolean().optional(),
  deadlineAfter: z.coerce.date().optional(),
});
export type ApplicationFilters = z.infer<typeof ApplicationFiltersSchema>;

// ---------- Application payload for (re)submission ----------

export const ApplicationPayloadSchema = z.object({
  resumeId: z.string(),
  documents: z.array(ApplicationDocumentSchema),
  questions: z.array(ApplicationQuestionAnswerSchema),
});
export type ApplicationPayload = z.infer<typeof ApplicationPayloadSchema>;

// ---------- Snapshot (section 11) ----------

export const ApplicationSnapshotSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  jobId: z.string(),
  job: JobSchema.optional(),
  status: ApplicationStatusSchema,
  resume: ResumeSchema.optional(),
  documents: z.array(ApplicationDocumentSchema),
  questions: z.array(ApplicationQuestionAnswerSchema),
  capturedAt: z.coerce.date(),
});
export type ApplicationSnapshot = z.infer<typeof ApplicationSnapshotSchema>;

// ---------- Replacement (sections 12-17) ----------

export const ReplacementStateSchema = z.enum([
  "planning",
  "snapshotted",
  "cancelling",
  "cancelled",
  "reapplying",
  "submitted",
  "verified",
  "failed",
]);
export type ReplacementState = z.infer<typeof ReplacementStateSchema>;

export const IneligibleReasonSchema = z.enum([
  "deadline_passed",
  "cannot_cancel",
  "cannot_reapply",
  "application_missing",
  "resume_already_replaced",
  "not_submitted",
  "ambiguous_resume",
  "unknown_state",
]);
export type IneligibleReason = z.infer<typeof IneligibleReasonSchema>;

export const ReplacementCandidateSchema = z.object({
  applicationId: z.string(),
  jobId: z.string(),
  employer: z.string().optional(),
  title: z.string().optional(),
  deadline: z.coerce.date().optional(),
  currentResumeId: z.string().optional(),
  currentResumeName: z.string().optional(),
  eligible: z.boolean(),
  reason: IneligibleReasonSchema.optional(),
});
export type ReplacementCandidate = z.infer<typeof ReplacementCandidateSchema>;

export const BatchReplacementPlanSchema = z.object({
  id: z.string(),
  oldResumeId: z.string(),
  oldResumeName: z.string().optional(),
  /** All résumé IDs treated as "old" (several identical uploads can be indistinguishable). */
  oldResumeIds: z.array(z.string()).optional(),
  newResumeId: z.string(),
  newResumeName: z.string().optional(),
  eligible: z.array(ReplacementCandidateSchema),
  ineligible: z.array(ReplacementCandidateSchema),
  createdAt: z.coerce.date(),
  executedAt: z.coerce.date().optional(),
});
export type BatchReplacementPlan = z.infer<typeof BatchReplacementPlanSchema>;

export const VerificationIssueSchema = z.object({
  field: z.string(),
  expected: z.string(),
  actual: z.string(),
});
export type VerificationIssue = z.infer<typeof VerificationIssueSchema>;

export const VerificationResultSchema = z.object({
  status: z.enum(["VERIFIED", "FAILED_VERIFICATION"]),
  issues: z.array(VerificationIssueSchema),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const ReplacementResultSchema = z.object({
  operationId: z.string(),
  applicationId: z.string(),
  newApplicationId: z.string().optional(),
  jobId: z.string(),
  oldResumeId: z.string().optional(),
  newResumeId: z.string(),
  state: ReplacementStateSchema,
  dryRun: z.boolean(),
  snapshotId: z.string().optional(),
  verification: VerificationResultSchema.optional(),
  requiresRecovery: z.boolean(),
  error: z.string().optional(),
});
export type ReplacementResult = z.infer<typeof ReplacementResultSchema>;

export const BatchExecutionResultSchema = z.object({
  planId: z.string(),
  total: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  skipped: z.number(),
  results: z.array(ReplacementResultSchema),
  stoppedEarly: z.boolean(),
  requiresRecovery: z.array(z.string()),
});
export type BatchExecutionResult = z.infer<typeof BatchExecutionResultSchema>;

// ---------- Operations (section 29) ----------

export const OperationTypeSchema = z.enum(["replace_resume", "recover"]);
export type OperationType = z.infer<typeof OperationTypeSchema>;

export const OperationSchema = z.object({
  id: z.string(),
  planId: z.string().optional(),
  applicationId: z.string(),
  newApplicationId: z.string().optional(),
  jobId: z.string().optional(),
  snapshotId: z.string().optional(),
  operationType: OperationTypeSchema,
  state: ReplacementStateSchema,
  oldResumeId: z.string().optional(),
  newResumeId: z.string().optional(),
  startedAt: z.coerce.date(),
  completedAt: z.coerce.date().optional(),
  error: z.string().optional(),
});
export type Operation = z.infer<typeof OperationSchema>;

/** Operation states from which the live application may be in a broken state. */
export const INCOMPLETE_STATES: ReadonlySet<ReplacementState> = new Set([
  "cancelling",
  "cancelled",
  "reapplying",
  "submitted",
]);

// ---------- Job postings (scan / export) ----------

/** One posting as scraped from the job search viewer + its posting panel. */
export const JobPostingSchema = z.object({
  jobId: z.string(),
  title: z.string(),
  employer: z.string(),
  division: z.string().optional(),
  city: z.string().optional(),
  location: z.string().optional(),
  term: z.string().optional(),
  openings: z.string().optional(),
  level: z.string().optional(),
  workTermDuration: z.string().optional(),
  deadline: z.coerce.date().optional(),
  applied: z.boolean().default(false),
  /** Free-form "Compensation and Benefits:" text, verbatim. */
  compensation: z.string().optional(),
  jobSummary: z.string().optional(),
  jobResponsibilities: z.string().optional(),
  requiredSkills: z.string().optional(),
  specialRequirements: z.string().optional(),
  transportationHousing: z.string().optional(),
  targetedDisciplines: z.string().optional(),
  additionalInfo: z.string().optional(),
  /** "WaterlooWorks", or an employer portal / email when the posting is applied to elsewhere. */
  applicationMethod: z.string().optional(),
  requiredDocuments: z.string().optional(),
  /**
   * Every field the posting panel rendered, verbatim and unmapped. Kept so a later question can be
   * answered from the cache instead of re-scraping 700+ postings.
   */
  sections: z.record(z.string()).optional(),
  scrapedAt: z.coerce.date(),
});
export type JobPosting = z.infer<typeof JobPostingSchema>;
