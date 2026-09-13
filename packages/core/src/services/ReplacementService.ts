import { IneligibleError, NotFoundError, WWError } from "../errors.js";
import { DOC_LABELS } from "../browser/selectors.js";
import { newId } from "../ids.js";
import { logEvent, type Logger } from "../logger.js";
import type {
  Application,
  ApplicationPayload,
  ApplicationSnapshot,
  DocumentType,
  Operation,
  ReplacementResult,
  Resume,
} from "../models/index.js";
import type { Repositories } from "../database/repositories.js";
import type { WaterlooWorksProvider } from "../providers/WaterlooWorksProvider.js";
import { checkEligibility } from "./eligibility.js";
import { SnapshotService } from "./SnapshotService.js";
import { verifyReplacement } from "./verification.js";

export interface ReplaceOptions {
  dryRun?: boolean;
  planId?: string;
  /** Expected current résumé(s); if the live application no longer uses one of them, abort. */
  expectedOldResumeId?: string;
  expectedOldResumeIds?: string[];
  /**
   * Replace every snapshot document of the given type with this one (e.g. swap the
   * "Other - Per Job Posting" document). Verification then expects the override, not the original.
   */
  documentOverrides?: DocumentOverride[];
}

export type DocumentOverride = { type: DocumentType; id: string; name: string };

/** The snapshot as it should look after the replacement: same package, overridden documents swapped. */
export function applyDocumentOverrides(snapshot: ApplicationSnapshot, overrides: DocumentOverride[] = []): ApplicationSnapshot {
  if (!overrides.length) return snapshot;
  for (const o of overrides) {
    if (o.type === "resume") throw new WWError("Use the new résumé argument to change the résumé, not a document override.", "INVALID_OVERRIDE");
    if (DOC_LABELS.find((l) => l.type === o.type)?.system) throw new WWError(`${o.type} is system-generated and cannot be overridden.`, "INVALID_OVERRIDE");
  }
  const types = new Set(overrides.map((o) => o.type));
  return {
    ...snapshot,
    documents: [...snapshot.documents.filter((d) => !types.has(d.type)), ...overrides.map((o) => ({ type: o.type, id: o.id, name: o.name }))],
  };
}

/**
 * Single-application résumé replacement state machine (spec sections 12-14, 31, 32).
 * Every transition is persisted before the next external call so a crash leaves a
 * recoverable `operations` row.
 */
export class ReplacementService {
  private snapshots: SnapshotService;

  constructor(private provider: WaterlooWorksProvider, private repos: Repositories, private log: Logger) {
    this.snapshots = new SnapshotService(provider, repos.snapshots, log);
  }

  async resolveResume(idOrName: string): Promise<Resume> {
    const all = await this.provider.listResumes();
    const r = all.find((x) => x.id === idOrName) ?? all.find((x) => x.name === idOrName) ?? all.find((x) => x.filename === idOrName);
    if (!r) throw new NotFoundError("Resume", idOrName);
    this.repos.resumes.upsert(r);
    return r;
  }

  /**
   * Rebuild the package with the new résumé. Documents identified ambiguously ("a|b": several
   * identical uploads) are interchangeable, so the first candidate is used.
   */
  buildPayload(snapshot: ApplicationSnapshot, newResume: Resume): ApplicationPayload {
    return {
      resumeId: newResume.id,
      documents: [
        { type: "resume", id: newResume.id, name: newResume.name },
        ...snapshot.documents
          .filter((d) => d.type !== "resume")
          .map((d) => ({ ...d, id: d.id?.split("|")[0], name: d.name.split(" | ")[0] })),
      ],
      questions: snapshot.questions.map((q) => ({ ...q })),
    };
  }

  async replaceApplicationResume(applicationId: string, newResumeId: string, options: ReplaceOptions = {}): Promise<ReplacementResult> {
    const dryRun = options.dryRun ?? false;

    // 1-3. Load and validate the application from a fresh read (never trust stale eligibility).
    let app: Application | undefined;
    try {
      app = await this.provider.getApplication(applicationId);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
    // 4-5. Job + deadline (getApplication populates job; refresh if deadline is unknown).
    if (app && !app.job?.deadline) {
      const job = await this.provider.getJob(app.jobId).catch(() => undefined);
      if (job) app.job = job;
    }
    // 7. New résumé must exist.
    const newResume = await this.resolveResume(newResumeId);

    // 6 + idempotency: eligibility.
    const alreadyReplaced = app ? this.repos.operations.hasVerifiedReplacement(app.jobId, newResume.id) : false;
    const elig = checkEligibility({
      app,
      oldResumeId: options.expectedOldResumeId,
      oldResumeIds: options.expectedOldResumeIds,
      newResumeId: newResume.id,
      alreadyReplaced,
    });
    if (!elig.eligible) throw new IneligibleError(`Application ${applicationId} is not eligible: ${elig.reason}`, elig.reason);
    const application = app!;

    const op: Operation = {
      id: newId("op"),
      planId: options.planId,
      applicationId: application.id,
      jobId: application.jobId,
      operationType: "replace_resume",
      state: "planning",
      oldResumeId: application.resume?.id,
      newResumeId: newResume.id,
      startedAt: new Date(),
    };
    const result: ReplacementResult = {
      operationId: op.id,
      applicationId: application.id,
      jobId: application.jobId,
      oldResumeId: application.resume?.id,
      newResumeId: newResume.id,
      state: "planning",
      dryRun,
      requiresRecovery: false,
    };

    // 8-9. Snapshot (persisted before anything destructive). Dry runs snapshot too: it is local and harmless.
    const snapshot = this.snapshots.persist(application);
    result.snapshotId = snapshot.id;
    // What the resubmitted package must look like: the snapshot with any requested document swaps.
    const expected = applyDocumentOverrides(snapshot, options.documentOverrides);
    const payload = this.buildPayload(expected, newResume);

    // 10-11. Dry run stops here.
    if (dryRun) {
      result.state = "snapshotted";
      return result;
    }

    this.repos.operations.insert(op);
    const setState = (s: Operation["state"], extra: Partial<Operation> = {}) => {
      this.repos.operations.setState(op, s, extra);
      result.state = s;
    };
    setState("snapshotted", { snapshotId: snapshot.id });

    try {
      // 12-13. Cancel and verify cancellation.
      setState("cancelling");
      await this.provider.cancelApplication(application.id);
      const afterCancel = await this.provider.getApplication(application.id).catch(() => undefined);
      if (afterCancel && afterCancel.status === "submitted") {
        throw new Error("Cancellation did not take effect: application still submitted.");
      }
      setState("cancelled");
      logEvent(this.log, "APPLICATION_CANCELLED", { applicationId: application.id, jobId: application.jobId });

      // 14-17. Reapply with restored package and new résumé.
      setState("reapplying");
      const submitted = await this.provider.submitApplication(application.jobId, payload);
      setState("submitted", { newApplicationId: submitted.id });
      result.newApplicationId = submitted.id;
      logEvent(this.log, "APPLICATION_SUBMITTED", { jobId: application.jobId, newApplicationId: submitted.id });

      // 18-19. Reload and verify.
      const fresh = await this.provider.getApplication(submitted.id);
      const verification = verifyReplacement(fresh, expected, { id: newResume.id, name: newResume.name });
      result.verification = verification;
      if (verification.status !== "VERIFIED") {
        logEvent(this.log, "VERIFICATION_FAILED", { jobId: application.jobId, issues: verification.issues });
        setState("failed", { error: `FAILED_VERIFICATION: ${verification.issues.map((i) => i.field).join(", ")}` });
        result.error = op.error;
        result.requiresRecovery = true; // the live application may not match the original package
        return result;
      }
      setState("verified");
      logEvent(this.log, "APPLICATION_VERIFIED", { jobId: application.jobId, newApplicationId: submitted.id });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const phase = op.state;
      // Decide whether the live application may be in a broken state. After "cancelling" we do not
      // trust the exception alone: re-read WaterlooWorks (spec 31/32: inspect current state).
      let requiresRecovery = phase === "cancelled" || phase === "reapplying" || phase === "submitted";
      if (phase === "cancelling") {
        const live = await this.provider.getApplication(application.id).catch(() => undefined);
        requiresRecovery = !live || live.status !== "submitted";
      }
      result.error = msg;
      result.requiresRecovery = requiresRecovery;
      logEvent(this.log, "OPERATION_FAILED", { operationId: op.id, jobId: application.jobId, phase, error: msg, requiresRecovery });
      if (requiresRecovery) {
        // Leave the op in an INCOMPLETE state so `ww operations incomplete` / recover can find it.
        const resumeFrom: Operation["state"] = result.newApplicationId ? "submitted" : "cancelled";
        this.repos.operations.setState(op, resumeFrom, { error: msg });
        result.state = resumeFrom;
      } else {
        setState("failed", { error: msg });
      }
      return result;
    }
  }
}
