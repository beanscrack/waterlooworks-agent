import { NotFoundError, UnknownStateError, WWError } from "../errors.js";
import { newId } from "../ids.js";
import { logEvent, type Logger } from "../logger.js";
import type { ApplicationSnapshot, Operation, ReplacementResult } from "../models/index.js";
import type { Repositories } from "../database/repositories.js";
import type { WaterlooWorksProvider } from "../providers/WaterlooWorksProvider.js";
import { applyDocumentOverrides, ReplacementService, type DocumentOverride } from "./ReplacementService.js";
import { verifyReplacement } from "./verification.js";

export interface IncompleteOperation {
  operation: Operation;
  snapshot?: ApplicationSnapshot;
}

/**
 * Recovery (spec section 18). Reconstructs an application from its snapshot when a
 * replacement stopped after cancellation. Inspects live state first (spec section 31).
 */
export class RecoveryService {
  constructor(
    private provider: WaterlooWorksProvider,
    private repos: Repositories,
    private single: ReplacementService,
    private log: Logger,
  ) {}

  listIncomplete(): IncompleteOperation[] {
    return this.repos.operations.listIncomplete().map((operation) => ({
      operation,
      snapshot: operation.snapshotId ? this.repos.snapshots.get(operation.snapshotId) : this.repos.snapshots.latestForApplication(operation.applicationId),
    }));
  }

  /**
   * Recover by job ID or operation ID. Uses the *new* résumé from the failed op when it
   * exists on WaterlooWorks, otherwise falls back to the snapshot's original résumé.
   */
  async recover(
    jobOrOperationId: string,
    opts: { dryRun?: boolean; resumeId?: string; documentOverrides?: DocumentOverride[] } = {},
  ): Promise<ReplacementResult> {
    const op =
      this.repos.operations.get(jobOrOperationId) ??
      this.repos.operations.listForJob(jobOrOperationId).filter((o) => ["cancelled", "cancelling", "reapplying", "submitted"].includes(o.state)).at(-1);
    if (!op) throw new NotFoundError("Incomplete operation for job/operation", jobOrOperationId);
    const stored = (op.snapshotId && this.repos.snapshots.get(op.snapshotId)) || this.repos.snapshots.latestForJob(op.jobId ?? "");
    if (!stored) throw new WWError(`No snapshot available for operation ${op.id}; manual recovery required.`, "NO_SNAPSHOT");
    // Expected package = stored snapshot with requested document swaps (same semantics as replacement).
    const snapshot = applyDocumentOverrides(stored, opts.documentOverrides);
    const jobId = op.jobId ?? snapshot.jobId;

    logEvent(this.log, "RECOVERY_STARTED", { operationId: op.id, jobId, state: op.state });

    // Inspect live state before doing anything.
    const live = (await this.provider.listApplications()).filter((a) => a.jobId === jobId);
    const submitted = live.find((a) => a.status === "submitted");
    const resumes = await this.provider.listResumes();
    const override = opts.resumeId ? await this.single.resolveResume(opts.resumeId) : undefined;
    const targetResume =
      override ||
      (op.newResumeId && resumes.find((r) => r.id === op.newResumeId || r.name === op.newResumeId)) ||
      (snapshot.resume && resumes.find((r) => r.id === snapshot.resume!.id || r.name === snapshot.resume!.name));
    if (!targetResume) throw new WWError(`Neither the new nor the original résumé exists on WaterlooWorks for job ${jobId}.`, "NO_RESUME");

    const recOp: Operation = {
      id: newId("op"),
      planId: op.planId,
      applicationId: op.applicationId,
      jobId,
      snapshotId: snapshot.id,
      operationType: "recover",
      state: "planning",
      oldResumeId: op.oldResumeId,
      newResumeId: targetResume.id,
      startedAt: new Date(),
    };
    const result: ReplacementResult = {
      operationId: recOp.id,
      applicationId: op.applicationId,
      jobId,
      oldResumeId: op.oldResumeId,
      newResumeId: targetResume.id,
      state: "planning",
      dryRun: !!opts.dryRun,
      snapshotId: snapshot.id,
      requiresRecovery: false,
    };

    // Case A: a submitted application already exists → just verify and close the old op.
    if (submitted) {
      const fresh = await this.provider.getApplication(submitted.id);
      const v = verifyReplacement(fresh, snapshot, targetResume);
      result.newApplicationId = fresh.id;
      result.verification = v;
      if (opts.dryRun) {
        result.state = v.status === "VERIFIED" ? "verified" : "failed";
        return result;
      }
      if (v.status === "VERIFIED") {
        this.repos.operations.setState(op, "verified", { newApplicationId: fresh.id, newResumeId: targetResume.id, error: undefined });
        result.state = "verified";
        logEvent(this.log, "RECOVERY_COMPLETED", { operationId: op.id, jobId, mode: "verified_existing" });
        return result;
      }
      throw new UnknownStateError(
        `Job ${jobId} has a submitted application that does not match the snapshot (${v.issues.map((i) => i.field).join(", ")}). Resolve manually.`,
      );
    }

    // Case B: nothing submitted → resubmit from snapshot.
    const job = await this.provider.getJob(jobId);
    if (job.deadline && job.deadline.getTime() <= Date.now())
      throw new WWError(`Deadline for job ${jobId} has passed; cannot resubmit. Snapshot ${snapshot.id} retained.`, "DEADLINE_PASSED");
    const payload = this.single.buildPayload(snapshot, targetResume);
    if (opts.dryRun) {
      result.state = "reapplying";
      return result;
    }
    this.repos.operations.insert(recOp);
    try {
      this.repos.operations.setState(recOp, "reapplying");
      const created = await this.provider.submitApplication(jobId, payload);
      this.repos.operations.setState(recOp, "submitted", { newApplicationId: created.id });
      result.newApplicationId = created.id;
      const fresh = await this.provider.getApplication(created.id);
      const v = verifyReplacement(fresh, snapshot, targetResume);
      result.verification = v;
      if (v.status !== "VERIFIED") {
        this.repos.operations.setState(recOp, "failed", { error: "FAILED_VERIFICATION" });
        result.state = "failed";
        result.requiresRecovery = true;
        result.error = "FAILED_VERIFICATION";
        return result;
      }
      this.repos.operations.setState(recOp, "verified");
      this.repos.operations.setState(op, "verified", { newApplicationId: created.id, newResumeId: targetResume.id, error: undefined });
      result.state = "verified";
      logEvent(this.log, "RECOVERY_COMPLETED", { operationId: op.id, jobId, mode: "resubmitted" });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.repos.operations.setState(recOp, "failed", { error: msg });
      result.state = "failed";
      result.error = msg;
      result.requiresRecovery = true;
      return result;
    }
  }
}
