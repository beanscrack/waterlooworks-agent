import { describe, expect, it } from "vitest";
import { makeWorld } from "./helpers.js";

describe("recovery", () => {
  it("resubmits from snapshot after a failed submit", async () => {
    const world = makeWorld({ failOn: { submit: new Set(["38192"]) } });
    const r = await world.core.replaceApplicationResume("app_1", "res_new");
    expect(r.requiresRecovery).toBe(true);
    world.provider["opts"].failOn = undefined; // outage over
    const dry = await world.core.recover("38192", { dryRun: true });
    expect(dry.state).toBe("reapplying");
    const rec = await world.core.recover("38192");
    expect(rec.state).toBe("verified");
    expect(rec.newResumeId).toBe("res_new");
    const fresh = await world.provider.getApplication(rec.newApplicationId!);
    expect(fresh.documents.map((d) => d.type).sort()).toEqual(["cover_letter", "resume", "transcript"]);
    expect(world.core.listIncompleteOperations()).toHaveLength(0);
  });

  it("verifies an already-present submission instead of duplicating it", async () => {
    const world = makeWorld({ failOn: { submit: new Set(["38192"]) } });
    await world.core.replaceApplicationResume("app_1", "res_new");
    world.provider["opts"].failOn = undefined;
    // Simulate: the submit actually went through on WaterlooWorks but the process died before recording it.
    const snap = world.core.listIncompleteOperations()[0].snapshot!;
    await world.provider.submitApplication("38192", world.core.replacement.buildPayload(snap, world.newRes));
    const before = world.provider.calls.filter((c) => c.op === "submitApplication").length;
    const rec = await world.core.recover("38192");
    expect(rec.state).toBe("verified");
    expect(world.provider.calls.filter((c) => c.op === "submitApplication").length).toBe(before);
  });

  it("resubmits with an overriding résumé when asked", async () => {
    const world = makeWorld({ failOn: { submit: new Set(["38192"]) } });
    await world.core.replaceApplicationResume("app_1", "res_new");
    world.provider["opts"].failOn = undefined;
    const third = world.provider.seedResume({ id: "res_third", name: "replit.pdf" });
    const failedOpId = world.core.listIncompleteOperations()[0].operation.id;
    const rec = await world.core.recover("38192", { resumeId: "replit.pdf" });
    expect(rec.state).toBe("verified");
    expect(rec.newResumeId).toBe(third.id);
    // The original operation records what actually ended up on WaterlooWorks.
    expect(world.core.repos.operations.get(failedOpId)?.newResumeId).toBe(third.id);
    const fresh = await world.provider.getApplication(rec.newApplicationId!);
    expect(fresh.resume?.id).toBe(third.id);
    expect(fresh.documents.map((d) => d.type).sort()).toEqual(["cover_letter", "resume", "transcript"]);
    expect(world.core.listIncompleteOperations()).toHaveLength(0);
    await expect(world.core.recover("38192", { resumeId: "nope.pdf" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("recovers with a swapped 'other' document when asked", async () => {
    const world = makeWorld({ failOn: { submit: new Set(["38192"]) } });
    world.provider.seedDocument({ id: "o_new", type: "other", name: "nreplit" });
    await world.core.replaceApplicationResume("app_1", "res_new");
    world.provider["opts"].failOn = undefined;
    const rec = await world.core.recover("38192", { resumeId: "res_new", documentOverrides: [{ type: "other", id: "o_new", name: "nreplit" }] });
    expect(rec.state).toBe("verified");
    const fresh = await world.provider.getApplication(rec.newApplicationId!);
    expect(fresh.documents.map((d) => d.type).sort()).toEqual(["cover_letter", "other", "resume", "transcript"]);
    expect(fresh.documents.find((d) => d.type === "other")?.id).toBe("o_new");
  });

  it("errors when there is nothing to recover", async () => {
    const { core } = makeWorld();
    await expect(core.recover("38192")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
