import { describe, expect, it } from "vitest";
import { makeWorld } from "./helpers.js";

describe("document cleanup", () => {
  it("archives only unused documents, keeps in-use ones, and moves the default flag", async () => {
    const { core, provider, oldRes, newRes } = makeWorld();
    // app_1 (submitted) uses res_old + cover letter cl_1; app_5 is cancelled and uses res_new.
    provider.seedDocument({ id: "cl_1", type: "cover_letter", name: "datadog_cover.pdf" });
    provider.seedDocument({ id: "cl_junk", type: "cover_letter", name: "d" });
    provider.seedDocument({ id: "o_junk", type: "other", name: "blank" });
    provider.seedDocument({ id: "o_keep", type: "other", name: "nvidia" });
    const junkRes = provider.seedResume({ id: "res_junk", name: "Resume" });
    const oldDefault = provider.seedResume({ id: "res_olddefault", name: "02-12-resume" });
    provider.defaults.add(oldDefault.id);
    provider.defaults.add(oldRes.id);

    const plan = await core.planDocumentCleanup({ defaultResume: "resume_fixed.pdf", keep: ["nvidia"] });
    const byId = new Map(plan.candidates.map((c) => [c.id, c]));
    expect(plan.newDefaultResume?.id).toBe(newRes.id);
    expect(plan.unsetDefaults.map((d) => d.id).sort()).toEqual([oldDefault.id, oldRes.id].sort());
    expect(byId.get(oldRes.id)?.action).toBe("keep"); // used by submitted apps
    expect(byId.get(oldRes.id)?.usedBy).toContain("38192");
    expect(byId.get("cl_1")?.action).toBe("keep");
    expect(byId.get("o_keep")?.reason).toBe("kept on request");
    expect(byId.get(newRes.id)?.reason).toBe("new default résumé");
    expect(plan.archive.map((c) => c.id).sort()).toEqual(["cl_junk", "o_junk", junkRes.id, oldDefault.id].sort());

    const res = await core.executeDocumentCleanup(plan);
    expect(res.failed).toBeUndefined();
    expect(res.setDefault).toBe(newRes.id);
    expect(res.archived.sort()).toEqual(plan.archive.map((c) => c.id).sort());
    expect(provider.defaults.has(newRes.id)).toBe(true);
    expect(provider.defaults.has(oldRes.id)).toBe(false);
    // Order matters: defaults are removed before anything is archived.
    const ops = provider.calls.filter((c) => c.op === "setDefaultDocument" || c.op === "archiveDocument").map((c) => c.op);
    expect(ops.indexOf("archiveDocument")).toBeGreaterThan(ops.lastIndexOf("setDefaultDocument"));
    // Archived documents disappear from listings; kept ones remain.
    expect((await provider.listDocuments("cover_letter")).map((d) => d.id)).toEqual(["cl_1"]);
    expect((await provider.listDocuments("resume")).map((d) => d.id).sort()).toEqual([oldRes.id, newRes.id].sort());
  });

  it("without --default keeps current defaults instead of archiving them", async () => {
    const { core, provider } = makeWorld();
    const d = provider.seedResume({ id: "res_def", name: "Current" });
    provider.defaults.add(d.id);
    const plan = await core.planDocumentCleanup();
    expect(plan.candidates.find((c) => c.id === d.id)?.action).toBe("keep");
    expect(plan.unsetDefaults).toEqual([]);
  });
});
