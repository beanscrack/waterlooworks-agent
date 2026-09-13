import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCore, createLogger, FakeWaterlooWorksProvider } from "../src/index.js";

describe("sqlite persistence", () => {
  it("survives reopening the database", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-"));
    const dbPath = path.join(dir, "ww.db");
    const mk = () =>
      createCore({ provider: new FakeWaterlooWorksProvider(), log: createLogger({ level: "silent" }), config: { rootDir: dir, dbPath } });
    const c1 = mk();
    c1.repos.snapshots.insert({
      id: "snap_x",
      applicationId: "a",
      jobId: "j",
      status: "submitted",
      documents: [],
      questions: [],
      capturedAt: new Date(),
    });
    c1.repos.plans.insert({ id: "plan_x", oldResumeId: "o", newResumeId: "n", eligible: [], ineligible: [], createdAt: new Date() });
    await c1.close();
    const c2 = mk();
    expect(c2.repos.snapshots.get("snap_x")?.jobId).toBe("j");
    expect(c2.repos.plans.get("plan_x")?.newResumeId).toBe("n");
    await c2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
