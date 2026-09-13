import { describe, expect, it } from "vitest";
import { IneligibleError } from "../src/index.js";
import { makeWorld } from "./helpers.js";

describe("single replacement", () => {
  it("dry run snapshots but mutates nothing", async () => {
    const { core, provider } = makeWorld();
    const r = await core.replaceApplicationResume("app_1", "res_new", { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.state).toBe("snapshotted");
    expect(r.snapshotId).toBeDefined();
    expect(core.repos.snapshots.get(r.snapshotId!)?.documents).toHaveLength(3);
    expect(provider.calls.some((c) => c.op === "cancelApplication" || c.op === "submitApplication")).toBe(false);
    expect(core.repos.operations.listAll()).toHaveLength(0);
  });

  it("snapshot → cancel → reapply → verify preserves the package and swaps the résumé", async () => {
    const { core, provider } = makeWorld();
    const r = await core.replaceApplicationResume("app_1", "resume_fixed.pdf");
    expect(r.state).toBe("verified");
    expect(r.verification?.status).toBe("VERIFIED");
    expect(r.requiresRecovery).toBe(false);
    const old = await provider.getApplication("app_1");
    expect(old.status).toBe("cancelled");
    const fresh = await provider.getApplication(r.newApplicationId!);
    expect(fresh.resume?.id).toBe("res_new");
    expect(fresh.documents.map((d) => d.type).sort()).toEqual(["cover_letter", "resume", "transcript"]);
    expect(fresh.questions).toEqual([{ question: "Are you eligible to work in Canada?", answer: "Yes" }]);
    // order of external calls
    const ops = provider.calls.map((c) => c.op).filter((o) => o === "cancelApplication" || o === "submitApplication");
    expect(ops).toEqual(["cancelApplication", "submitApplication"]);
    const op = core.repos.operations.get(r.operationId)!;
    expect(op.state).toBe("verified");
    expect(op.completedAt).toBeDefined();
  });

  it("refuses ineligible applications without touching them", async () => {
    const { core, provider } = makeWorld();
    await expect(core.replaceApplicationResume("app_3", "res_new")).rejects.toMatchObject({ reason: "deadline_passed" });
    await expect(core.replaceApplicationResume("app_4", "res_new")).rejects.toMatchObject({ reason: "cannot_cancel" });
    await expect(core.replaceApplicationResume("app_5", "res_new")).rejects.toMatchObject({ reason: "not_submitted" });
    await expect(core.replaceApplicationResume("nope", "res_new")).rejects.toBeInstanceOf(IneligibleError);
    expect(provider.calls.filter((c) => c.op === "cancelApplication")).toHaveLength(0);
  });

  it("flags recovery when submit fails after cancel", async () => {
    const { core } = makeWorld({ failOn: { submit: new Set(["38192"]) } });
    const r = await core.replaceApplicationResume("app_1", "res_new");
    expect(r.state).toBe("cancelled");
    expect(r.requiresRecovery).toBe(true);
    expect(r.error).toContain("Injected submit failure");
    expect(core.listIncompleteOperations()).toHaveLength(1);
    expect(core.listIncompleteOperations()[0].snapshot?.id).toBe(r.snapshotId);
  });

  it("does not flag recovery when cancel itself fails", async () => {
    const { core, provider } = makeWorld({ failOn: { cancel: new Set(["app_1"]) } });
    const r = await core.replaceApplicationResume("app_1", "res_new");
    expect(r.state).toBe("failed");
    expect(r.requiresRecovery).toBe(false);
    expect((await provider.getApplication("app_1")).status).toBe("submitted");
  });

  it("fails verification when the resubmitted package lost a document", async () => {
    const { core } = makeWorld({ dropDocumentTypeOnSubmit: "cover_letter" });
    const r = await core.replaceApplicationResume("app_1", "res_new");
    expect(r.state).toBe("failed");
    expect(r.verification?.status).toBe("FAILED_VERIFICATION");
    expect(r.requiresRecovery).toBe(true);
  });

  it("builds the resubmit payload with a single id for ambiguous documents", async () => {
    const { core, newRes } = makeWorld();
    const payload = core.replacement.buildPayload(
      { id: "s", applicationId: "a", jobId: "1", status: "submitted", documents: [{ type: "other", id: "9|8", name: "x | x" }], questions: [], capturedAt: new Date() },
      newRes,
    );
    expect(payload.documents.find((d) => d.type === "other")).toEqual({ type: "other", id: "9", name: "x" });
    expect(payload.documents[0]).toEqual({ type: "resume", id: newRes.id, name: newRes.name });
  });

  it("replaces an ambiguously identified résumé only when every candidate is named as old", async () => {
    const { core, provider, oldRes } = makeWorld();
    const twin = provider.seedResume({ id: "res_twin", name: "resume_old_copy.pdf" });
    provider.seedApplication({
      id: "app_amb",
      jobId: "38201",
      resume: { id: `${oldRes.id}|${twin.id}`, name: `${oldRes.name} | ${twin.name}`, filename: oldRes.filename },
      documents: [{ type: "resume", id: `${oldRes.id}|${twin.id}`, name: `${oldRes.name} | ${twin.name}` }],
    });
    await expect(core.replaceApplicationResume("app_amb", "res_new", { dryRun: true })).rejects.toMatchObject({ reason: "ambiguous_resume" });
    await expect(core.replaceApplicationResume("app_amb", "res_new", { dryRun: true, expectedOldResumeIds: [oldRes.id] })).rejects.toMatchObject({
      reason: "ambiguous_resume",
    });
    const r = await core.replaceApplicationResume("app_amb", "res_new", { expectedOldResumeIds: [oldRes.id, twin.id] });
    expect(r.state).toBe("verified");
    expect((await provider.getApplication(r.newApplicationId!)).resume?.id).toBe("res_new");
  });

  it("swaps the 'other' document when asked and verifies against the swapped package", async () => {
    const { core, provider, oldRes } = makeWorld();
    provider.seedDocument({ id: "o_old", type: "other", name: "4" });
    const nreplit = provider.seedDocument({ id: "o_new", type: "other", name: "nreplit" });
    provider.seedApplication({
      id: "app_o",
      jobId: "38201",
      resume: oldRes,
      documents: [
        { type: "resume", id: oldRes.id, name: oldRes.name },
        { type: "transcript", name: "Grade Report" },
        { type: "other", id: "o_old", name: "4" },
      ],
    });
    const override = await core.resolveDocument("other", "nreplit");
    expect(override).toEqual({ type: "other", id: nreplit.id, name: "nreplit" });
    await expect(core.resolveDocument("other", "missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const r = await core.replaceApplicationResume("app_o", "res_new", { documentOverrides: [override] });
    expect(r.state).toBe("verified");
    const fresh = await provider.getApplication(r.newApplicationId!);
    expect(fresh.documents.filter((d) => d.type === "other")).toEqual([{ type: "other", id: "o_new", name: "nreplit" }]);
    expect(fresh.documents.some((d) => d.type === "transcript")).toBe(true);
    // The stored snapshot still records what was really there before.
    expect(core.repos.snapshots.get(r.snapshotId!)?.documents.find((d) => d.type === "other")?.id).toBe("o_old");
    // Résumé and system documents cannot be overridden this way.
    await expect(core.replaceApplicationResume("app_2", "res_new", { documentOverrides: [{ type: "resume", id: "x", name: "x" }] })).rejects.toMatchObject({ code: "INVALID_OVERRIDE" });
    await expect(core.replaceApplicationResume("app_2", "res_new", { documentOverrides: [{ type: "transcript", id: "x", name: "x" }] })).rejects.toMatchObject({ code: "INVALID_OVERRIDE" });
  });

  it("is idempotent: a second replacement on the same job is rejected as already replaced", async () => {
    const { core } = makeWorld();
    const r = await core.replaceApplicationResume("app_1", "res_new");
    await expect(core.replaceApplicationResume(r.newApplicationId!, "res_new")).rejects.toMatchObject({ reason: "resume_already_replaced" });
  });
});
