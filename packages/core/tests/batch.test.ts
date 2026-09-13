import { describe, expect, it } from "vitest";
import { makeWorld } from "./helpers.js";

describe("batch preview/execute", () => {
  it("preview is read-only and classifies candidates", async () => {
    const { core, provider } = makeWorld();
    const plan = await core.previewResumeReplacement({ oldResumeId: "resume_old.pdf", newResumeId: "res_new" });
    expect(plan.eligible.map((c) => c.jobId).sort()).toEqual(["38192", "38201"]);
    expect(plan.ineligible.map((c) => c.reason).sort()).toEqual(["cannot_cancel", "deadline_passed"]);
    expect(provider.calls.some((c) => c.op === "cancelApplication" || c.op === "submitApplication")).toBe(false);
    expect(core.getPlan(plan.id)?.eligible).toHaveLength(2);
  });

  it("rejects same-resume plans", async () => {
    const { core } = makeWorld();
    await expect(core.previewResumeReplacement({ oldResumeId: "res_old", newResumeId: "res_old" })).rejects.toMatchObject({ code: "INVALID_PLAN" });
  });

  it("executes sequentially and reports progress", async () => {
    const { core, provider } = makeWorld();
    const plan = await core.previewResumeReplacement({ oldResumeId: "res_old", newResumeId: "res_new" });
    const seen: number[] = [];
    const res = await core.executeResumeReplacement(plan.id, (p) => seen.push(p.index));
    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(0);
    expect(seen).toEqual([1, 2]);
    const seq = provider.calls.map((c) => c.op).filter((o) => o === "cancelApplication" || o === "submitApplication");
    expect(seq).toEqual(["cancelApplication", "submitApplication", "cancelApplication", "submitApplication"]);
    expect(core.getPlan(plan.id)?.executedAt).toBeDefined();
  });

  it("stops on first error and leaves the rest untouched", async () => {
    const { core, provider } = makeWorld({ failOn: { submit: new Set(["38192"]) } });
    const plan = await core.previewResumeReplacement({ oldResumeId: "res_old", newResumeId: "res_new" });
    // ensure the failing one runs first
    plan.eligible.sort((a, b) => (a.jobId === "38192" ? -1 : b.jobId === "38192" ? 1 : 0));
    core.repos.plans.markExecuted(plan.id, new Date(0)); // reset by re-inserting a fresh plan copy
    const p2 = { ...plan, id: plan.id + "_b", executedAt: undefined };
    core.repos.plans.insert(p2);
    const res = await core.executeResumeReplacement(p2.id);
    expect(res.succeeded).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.stoppedEarly).toBe(true);
    expect(res.requiresRecovery).toEqual(["38192"]);
    expect((await provider.getApplication("app_2")).status).toBe("submitted");
  });

  it("refuses to run a plan twice or while recovery is pending", async () => {
    const { core } = makeWorld({ failOn: { submit: new Set(["38201"]) } });
    const plan = await core.previewResumeReplacement({ oldResumeId: "res_old", newResumeId: "res_new" });
    await core.executeResumeReplacement(plan.id);
    await expect(core.executeResumeReplacement(plan.id)).rejects.toMatchObject({ code: "PLAN_ALREADY_EXECUTED" });
    const plan2 = await core.previewResumeReplacement({ oldResumeId: "res_old", newResumeId: "res_new" });
    await expect(core.executeResumeReplacement(plan2.id)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  });
});
