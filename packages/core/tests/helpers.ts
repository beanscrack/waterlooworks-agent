import { FakeWaterlooWorksProvider, createCore, createLogger, type FakeOptions } from "../src/index.js";

export function makeWorld(opts: FakeOptions = {}) {
  const provider = new FakeWaterlooWorksProvider(opts);
  const log = createLogger({ level: "silent" });
  const core = createCore({ provider, log, memoryDb: true, config: { rootDir: "/tmp/ww-test", dbPath: "/tmp/ww-test/unused.db" } });
  const future = new Date(Date.now() + 7 * 86400_000);
  const past = new Date(Date.now() - 86400_000);
  const oldRes = provider.seedResume({ id: "res_old", name: "resume_old.pdf" });
  const newRes = provider.seedResume({ id: "res_new", name: "resume_fixed.pdf" });
  provider.seedJob({ id: "38192", title: "SWE Intern", employer: "Datadog", deadline: future });
  provider.seedJob({ id: "38201", title: "SWE Intern", employer: "Bloomberg", deadline: future });
  provider.seedJob({ id: "38300", title: "Old Job", employer: "Expired Co", deadline: past });
  provider.seedJob({ id: "38400", title: "Locked", employer: "NoCancel Inc", deadline: future });
  provider.seedApplication({
    id: "app_1",
    jobId: "38192",
    resume: oldRes,
    documents: [
      { type: "resume", name: oldRes.name, id: oldRes.id },
      { type: "cover_letter", name: "datadog_cover.pdf", id: "cl_1" },
      { type: "transcript", name: "Waterloo Transcript", id: "tr_1" },
    ],
    questions: [{ question: "Are you eligible to work in Canada?", answer: "Yes" }],
  });
  provider.seedApplication({ id: "app_2", jobId: "38201", resume: oldRes });
  provider.seedApplication({ id: "app_3", jobId: "38300", resume: oldRes });
  provider.seedApplication({ id: "app_4", jobId: "38400", resume: oldRes, canCancel: false });
  provider.seedApplication({ id: "app_5", jobId: "38201", resume: newRes, status: "cancelled", canCancel: false });
  return { provider, core, oldRes, newRes };
}
