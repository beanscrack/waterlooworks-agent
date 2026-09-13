import { NotFoundError, WWError } from "../errors.js";
import { newId } from "../ids.js";
import { logEvent, type Logger } from "../logger.js";
import type { BatchExecutionResult, BatchReplacementPlan, ReplacementCandidate, ReplacementResult } from "../models/index.js";
import type { Repositories } from "../database/repositories.js";
import type { WaterlooWorksProvider } from "../providers/WaterlooWorksProvider.js";
import { checkEligibility } from "./eligibility.js";
import { ReplacementService } from "./ReplacementService.js";

export type ProgressFn = (e: { index: number; total: number; result: ReplacementResult }) => void;
export type PreviewProgressFn = (e: { phase: "preview"; jobId: string; message: string }) => void;

export class BatchReplacementService {
  constructor(
    private provider: WaterlooWorksProvider,
    private repos: Repositories,
    private single: ReplacementService,
    private log: Logger,
  ) {}

  /** Optional hook for CLIs to show progress during slow previews. */
  onProgress?: PreviewProgressFn;

  /** Read-only (spec section 15.1). Touches only local SQLite. */
  async previewResumeReplacement(input: { oldResumeId: string; newResumeId: string }): Promise<BatchReplacementPlan> {
    const oldResumes = [];
    for (const key of input.oldResumeId.split(",").map((k) => k.trim()).filter(Boolean)) oldResumes.push(await this.single.resolveResume(key));
    if (!oldResumes.length) throw new WWError("No old résumé given.", "INVALID_PLAN");
    const oldResume = oldResumes[0];
    const oldIds = oldResumes.map((r) => r.id);
    const oldNames = oldResumes.map((r) => r.name);
    const newResume = await this.single.resolveResume(input.newResumeId);
    if (oldIds.includes(newResume.id)) throw new WWError("Old and new résumé are the same document.", "INVALID_PLAN");

    // Summary rows may not carry résumé identity (WaterlooWorks only exposes it inside the package
    // PDF), so resolve each submitted application in detail and keep those touching the old résumé.
    const submitted = await this.provider.listApplications({ status: "submitted" });
    const eligible: ReplacementCandidate[] = [];
    const ineligible: ReplacementCandidate[] = [];
    for (const summary of submitted) {
      let app: Awaited<ReturnType<WaterlooWorksProvider["getApplication"]>> | undefined;
      let inspectError: string | undefined;
      try {
        app = await this.provider.getApplication(summary.id);
      } catch (e) {
        inspectError = e instanceof Error ? e.message : String(e);
        this.log.warn({ jobId: summary.jobId, err: inspectError }, "could not inspect application; listing it as unknown_state");
      }
      const current = app?.resume ?? summary.resume;
      const ids = (current?.id ?? "").split("|");
      const names = (current?.name ?? "").split(" | ");
      const usesOld = ids.some((id) => oldIds.includes(id)) || names.some((n) => oldNames.includes(n));
      // An application we could not inspect must never disappear from the plan: it stays visible as ineligible.
      if (!usesOld && !inspectError) continue;
      this.onProgress?.({ phase: "preview", jobId: summary.jobId, message: `inspected ${summary.jobId}` });
      const alreadyReplaced = this.repos.operations.hasVerifiedReplacement(summary.jobId, newResume.id);
      const e = inspectError
        ? ({ eligible: false, reason: "unknown_state" } as const)
        : checkEligibility({ app, oldResumeIds: oldIds, newResumeId: newResume.id, alreadyReplaced });
      const c: ReplacementCandidate = {
        applicationId: summary.id,
        jobId: summary.jobId,
        employer: app?.job?.employer ?? summary.job?.employer,
        title: app?.job?.title ?? summary.job?.title,
        deadline: app?.job?.deadline ?? summary.job?.deadline,
        currentResumeId: current?.id,
        currentResumeName: current?.name,
        eligible: e.eligible,
        reason: e.eligible ? undefined : e.reason,
      };
      (e.eligible ? eligible : ineligible).push(c);
    }

    const plan: BatchReplacementPlan = {
      id: newId("plan"),
      oldResumeId: oldResume.id,
      oldResumeName: oldNames.join(" | "),
      oldResumeIds: oldIds,
      newResumeId: newResume.id,
      newResumeName: newResume.name,
      eligible,
      ineligible,
      createdAt: new Date(),
    };
    this.repos.plans.insert(plan);
    logEvent(this.log, "PLAN_CREATED", {
      planId: plan.id,
      oldResumeId: oldResume.id,
      newResumeId: newResume.id,
      eligible: eligible.length,
      ineligible: ineligible.length,
    });
    return plan;
  }

  /** Sequential execution, stop on first error (spec sections 16-17). */
  async executeResumeReplacement(planId: string, onProgress?: ProgressFn): Promise<BatchExecutionResult> {
    const plan = this.repos.plans.get(planId);
    if (!plan) throw new NotFoundError("Plan", planId);
    if (plan.executedAt) throw new WWError(`Plan ${planId} was already executed at ${plan.executedAt.toISOString()}.`, "PLAN_ALREADY_EXECUTED");
    if (this.repos.operations.listIncomplete().length > 0)
      throw new WWError("Incomplete operations exist. Run `ww operations incomplete` and recover before executing a plan.", "RECOVERY_REQUIRED");

    this.repos.plans.markExecuted(planId, new Date()); // immutable: a plan runs at most once

    const results: ReplacementResult[] = [];
    const requiresRecovery: string[] = [];
    let succeeded = 0;
    let failed = 0;
    let stoppedEarly = false;
    const total = plan.eligible.length;

    for (let i = 0; i < total; i++) {
      const c = plan.eligible[i];
      let r: ReplacementResult;
      try {
        r = await this.single.replaceApplicationResume(c.applicationId, plan.newResumeId, {
          planId,
          expectedOldResumeIds: plan.oldResumeIds ?? [plan.oldResumeId],
        });
      } catch (e) {
        r = {
          operationId: "",
          applicationId: c.applicationId,
          jobId: c.jobId,
          oldResumeId: c.currentResumeId,
          newResumeId: plan.newResumeId,
          state: "failed",
          dryRun: false,
          requiresRecovery: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      results.push(r);
      onProgress?.({ index: i + 1, total, result: r });
      if (r.state === "verified") succeeded++;
      else {
        failed++;
        if (r.requiresRecovery) requiresRecovery.push(r.jobId);
        stoppedEarly = i < total - 1;
        break;
      }
    }

    return {
      planId,
      total,
      succeeded,
      failed,
      skipped: total - succeeded - failed,
      results,
      stoppedEarly,
      requiresRecovery,
    };
  }
}
