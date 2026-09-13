import type { Application, IneligibleReason } from "../models/index.js";

export interface EligibilityInput {
  app: Application | undefined;
  oldResumeId?: string;
  /** Alternative to oldResumeId: any of these count as the old résumé. */
  oldResumeIds?: string[];
  newResumeId: string;
  now?: Date;
  alreadyReplaced?: boolean;
}

/** Pure eligibility decision shared by preview and execution (spec sections 12, 15, 32). */
export function checkEligibility(i: EligibilityInput): { eligible: true } | { eligible: false; reason: IneligibleReason } {
  const now = i.now ?? new Date();
  const app = i.app;
  if (!app) return { eligible: false, reason: "application_missing" };
  if (app.status === "unknown") return { eligible: false, reason: "unknown_state" };
  if (app.status !== "submitted") return { eligible: false, reason: "not_submitted" };
  const oldSet = new Set([...(i.oldResumeIds ?? []), ...(i.oldResumeId ? [i.oldResumeId] : [])]);
  const attached = app.resume ? app.resume.id.split("|") : [];
  // Providers signal "could not tell which résumé is attached" with a composite "a|b" id.
  if (attached.length > 1 && !(oldSet.size && attached.every((id) => oldSet.has(id)))) return { eligible: false, reason: "ambiguous_resume" };
  if (attached.includes(i.newResumeId) || app.resume?.name === i.newResumeId) return { eligible: false, reason: "resume_already_replaced" };
  if (oldSet.size) {
    if (!app.resume) return { eligible: false, reason: "unknown_state" };
    const usesOld = attached.some((id) => oldSet.has(id)) || oldSet.has(app.resume.name);
    if (!usesOld) return { eligible: false, reason: "resume_already_replaced" };
  }
  const deadline = app.job?.deadline;
  if (deadline && deadline.getTime() <= now.getTime()) return { eligible: false, reason: "deadline_passed" };
  if (!deadline && app.job?.status === "closed") return { eligible: false, reason: "deadline_passed" };
  if (!app.canCancel) return { eligible: false, reason: "cannot_cancel" };
  if (!app.canReapply) return { eligible: false, reason: "cannot_reapply" };
  return { eligible: true };
}
