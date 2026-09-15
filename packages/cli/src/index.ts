#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import {
  createCore,
  PlaywrightWaterlooWorksProvider,
  WWError,
  type ApplicationFilters,
  type DocumentOverride,
  type DocumentType,
  analyse,
  bySalaryDesc,
  mentionsAI,
  type WaterlooWorksCore,
} from "@ww/core";
import { applicationDetail, applicationTable, fmtDate, jobTable, kv, planSummary, resultLine, resumeTable } from "./format.js";

const program = new Command();
program
  .name("ww")
  .description("WaterlooWorks automation CLI")
  .option("--json", "machine-readable output")
  .option("--headless", "run the browser headless (default: visible)")
  .option("--fake", "use the in-memory fake provider (demo/testing)")
  .version("0.1.0");

let coreRef: WaterlooWorksCore | undefined;
function core(): WaterlooWorksCore {
  if (coreRef) return coreRef;
  const o = program.opts();
  coreRef = createCore({ config: { ...(o.headless ? { headless: true } : {}), ...(o.fake ? { fake: true } : {}) } });
  return coreRef;
}
const out = (data: unknown, text: () => string) => {
  console.log(program.opts().json ? JSON.stringify(data, null, 2) : text());
};
async function run(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof WWError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    console.error(`error: ${msg}`);
    process.exitCode = 1;
  } finally {
    await coreRef?.close().catch(() => {});
  }
}

// ---- auth ----
program
  .command("login")
  .description("Open a browser to log in to WaterlooWorks; the session is stored locally in browser-profile/")
  .option("--timeout <minutes>", "how long to wait for login", "10")
  .action((opts) =>
    run(async () => {
      const c = core();
      if (!(c.provider instanceof PlaywrightWaterlooWorksProvider)) throw new WWError("login requires the Playwright provider", "BAD_PROVIDER");
      if (await c.provider.isAuthenticated()) {
        console.log("Already authenticated.");
        return;
      }
      const ok = await c.provider.login(Number(opts.timeout) * 60_000, (m) => console.log(m));
      console.log(ok ? "Login successful. Session saved." : "Login did not complete.");
      if (!ok) process.exitCode = 1;
    }),
  );

const auth = program.command("auth").description("authentication status");
auth.command("status").action(() =>
  run(async () => {
    const ok = await core().isAuthenticated();
    out({ authenticated: ok }, () => (ok ? "Authenticated" : "Not authenticated. Run `ww login`."));
    if (!ok) process.exitCode = 2;
  }),
);
program
  .command("logout")
  .description("Log out and clear the stored browser session")
  .action(() =>
    run(async () => {
      const c = core();
      if (c.provider instanceof PlaywrightWaterlooWorksProvider) await c.provider.logout();
      await c.close();
      fs.rmSync(c.config.browserProfileDir, { recursive: true, force: true });
      console.log("Logged out and browser profile removed.");
    }),
  );

// ---- resumes ----
const resume = program.command("resume").description("manage résumés");
resume.command("list").action(() =>
  run(async () => {
    const rs = await core().listResumes();
    out(rs, () => resumeTable(rs));
  }),
);
resume
  .command("upload <file>")
  .option("--name <name>", "display name in WaterlooWorks")
  .description("Upload a résumé (external mutation)")
  .action((file, opts) =>
    run(async () => {
      const r = await core().uploadResume(path.resolve(file), opts.name);
      out(r, () => kv([["Uploaded", r.name], ["ID", r.id], ["SHA-256", r.sha256]]));
    }),
  );

// ---- documents (cover letters, "Other - Per Job Posting") ----
const USER_DOC_TYPES = ["resume", "cover_letter", "other"] as const;
const parseDocType = (t: string): DocumentType => {
  if (!(USER_DOC_TYPES as readonly string[]).includes(t)) throw new WWError(`--type must be one of ${USER_DOC_TYPES.join(", ")}`, "INVALID_DOC_TYPE");
  return t as DocumentType;
};
const document = program.command("document").description("user documents other than résumés");
document
  .command("list")
  .requiredOption("--type <type>", `document type: ${USER_DOC_TYPES.join(" | ")}`)
  .action((opts) =>
    run(async () => {
      const docs = await core().listDocuments(parseDocType(opts.type));
      out(docs, () => docs.map((d) => `${d.id.padEnd(10)} ${d.name.padEnd(30)} ${fmtDate(d.uploadedAt).padEnd(26)} ${d.isDefault ? "[default]" : ""}`).join("\n") || "(none)");
    }),
  );
document
  .command("cleanup")
  .description("Archive every document no submitted application uses and make one résumé the single default (preview by default)")
  .option("--default <idOrName>", "résumé to become the only default résumé")
  .option("--keep <idsOrNames>", "comma-separated documents to keep even if unused")
  .option("--execute", "actually archive / change defaults (default is preview)")
  .option("--yes", "skip the confirmation prompt")
  .action((opts) =>
    run(async () => {
      const c = core();
      c.cleanup.onProgress = (m) => process.stderr.write(`  ${m}\n`);
      process.stderr.write("Reading documents and submitted applications…\n");
      const plan = await c.planDocumentCleanup({ defaultResume: opts.default, keep: opts.keep ? String(opts.keep).split(",").map((k: string) => k.trim()).filter(Boolean) : undefined });
      const fmt = (x: { id: string; type: string; name: string; reason: string; isDefault?: boolean }) =>
        `  ${x.id.padEnd(10)} ${x.type.padEnd(13)} ${x.name.slice(0, 32).padEnd(33)} ${x.isDefault ? "[default] " : ""}${x.reason}`;
      const summary = [
        plan.newDefaultResume ? `New default résumé: ${plan.newDefaultResume.name} (${plan.newDefaultResume.id})` : "Default résumé: unchanged",
        ...plan.unsetDefaults.map((d) => `Remove default flag: ${d.name} (${d.id})`),
        "",
        `KEEP (${plan.keep.length}):`,
        ...plan.keep.map(fmt),
        "",
        `ARCHIVE (${plan.archive.length}):`,
        ...plan.archive.map(fmt),
      ].join("\n");
      if (!opts.execute) {
        out(plan, () => summary + "\n\nNothing has been modified. Re-run with --execute to apply (archiving is reversible in the WaterlooWorks UI).");
        return;
      }
      console.log(summary);
      if (!opts.yes) {
        const ok = await confirm(`Archive ${plan.archive.length} documents and change ${plan.unsetDefaults.length + (plan.newDefaultResume ? 1 : 0)} default flags on WaterlooWorks? [y/N] `);
        if (!ok) return console.log("Aborted. Nothing modified.");
      }
      const res = await c.executeDocumentCleanup(plan);
      out(res, () =>
        [
          res.setDefault ? `Default résumé is now ${res.setDefault}.` : "",
          `${res.archived.length}/${plan.archive.length} documents archived.`,
          res.failed ? `FAILED at ${res.failed.id}: ${res.failed.error}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      if (res.failed) process.exitCode = 1;
    }),
  );
document
  .command("archive <idOrName...>")
  .requiredOption("--type <type>", `document type: ${USER_DOC_TYPES.join(" | ")}`)
  .option("--yes", "skip confirmation")
  .description("Archive specific documents (reversible in the WaterlooWorks UI)")
  .action((keys: string[], opts) =>
    run(async () => {
      const c = core();
      const type = parseDocType(opts.type);
      const ids: string[] = [];
      for (const k of keys) ids.push((await c.resolveDocument(type, k)).id);
      if (!opts.yes && !(await confirm(`Archive ${ids.length} ${type} document(s) (${ids.join(", ")})? [y/N] `))) return console.log("Aborted.");
      const done = await c.archiveDocuments(type, ids);
      out(done, () => `${done.length}/${ids.length} archived.`);
    }),
  );
document
  .command("set-default <idOrName>")
  .requiredOption("--type <type>", `document type: ${USER_DOC_TYPES.join(" | ")}`)
  .option("--unset", "remove the default flag instead of setting it")
  .description("Flag a document as the default of its type")
  .action((key: string, opts) =>
    run(async () => {
      const c = core();
      const type = parseDocType(opts.type);
      const d = await c.resolveDocument(type, key);
      await c.setDefaultDocument(type, d.id, !opts.unset);
      out({ id: d.id, isDefault: !opts.unset }, () => `${d.name} (${d.id}) is ${opts.unset ? "no longer" : "now"} the default ${type}.`);
    }),
  );
document
  .command("upload <file>")
  .requiredOption("--type <type>", `document type: ${USER_DOC_TYPES.join(" | ")}`)
  .option("--name <name>", "display name in WaterlooWorks (default: file name without extension)")
  .description("Upload a PDF as a document of the given type (external mutation)")
  .action((file, opts) =>
    run(async () => {
      const d = await core().uploadDocument(path.resolve(file), parseDocType(opts.type), opts.name);
      out(d, () => kv([["Uploaded", d.name], ["Type", d.type], ["ID", d.id], ["SHA-256", d.sha256]]));
    }),
  );

// ---- applications ----
const applications = program.command("applications").description("list and modify applications");
applications
  .command("list")
  .option("--status <status>", "submitted|cancelled|expired")
  .option("--resume <idOrName>", "only applications using this résumé")
  .option("--editable", "only applications that can be cancelled and reapplied")
  .action((opts) =>
    run(async () => {
      const c = core();
      const f: ApplicationFilters = {};
      if (opts.status) f.status = opts.status;
      if (opts.resume) f.resumeId = (await c.resolveResume(opts.resume)).id;
      if (opts.editable) f.editableOnly = true;
      const apps = await c.listApplications(f);
      out(apps, () => applicationTable(apps));
    }),
  );

applications
  .command("replace-resume")
  .requiredOption("--from <idOrName>", "résumé currently on the applications (comma-separate several identical uploads)")
  .requiredOption("--to <idOrName>", "replacement résumé")
  .option("--dry-run", "create and print a plan; modify nothing (default)")
  .option("--execute", "execute the plan (cancels and resubmits applications)")
  .option("--plan <planId>", "execute an existing plan instead of creating a new one")
  .option("--yes", "skip the confirmation prompt")
  .action((opts) =>
    run(async () => {
      const c = core();
      let plan = opts.plan ? c.getPlan(opts.plan) : undefined;
      if (opts.plan && !plan) throw new WWError(`Plan not found: ${opts.plan}`, "NOT_FOUND");
      if (!plan) {
        c.batch.onProgress = (e) => process.stderr.write(`  ${e.message}\n`);
        process.stderr.write("Inspecting submitted applications (this reads each application package)…\n");
        plan = await c.previewResumeReplacement({ oldResumeId: opts.from, newResumeId: opts.to });
      }
      if (!opts.execute) {
        out(plan, () => planSummary(plan!) + "\nNo applications have been modified. Re-run with --execute --plan " + plan!.id + " to apply.");
        return;
      }
      console.log(planSummary(plan));
      if (!opts.yes) {
        const ok = await confirm(
          `Modify WaterlooWorks: ${plan.eligible.length} cancellations + ${plan.eligible.length} submissions (${plan.oldResumeName} → ${plan.newResumeName}). Proceed? [y/N] `,
        );
        if (!ok) {
          console.log("Aborted. Nothing modified.");
          return;
        }
      }
      const res = await c.executeResumeReplacement(plan.id, ({ index, total, result }) =>
        console.log(`${index}/${total} ${resultLine(result)}`),
      );
      out(res, () =>
        [
          "",
          `${res.succeeded} applications successfully updated.`,
          res.failed ? `${res.failed} failed.` : "",
          res.skipped ? `${res.skipped} remaining applications were not modified.` : "",
          res.requiresRecovery.length ? `RECOVERY REQUIRED for jobs: ${res.requiresRecovery.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      if (res.failed) process.exitCode = 1;
    }),
  );

const application = program.command("application").description("inspect a single application");
application.command("show <id>").action((id) =>
  run(async () => {
    const a = await core().getApplication(id);
    out(a, () => applicationDetail(a));
  }),
);
application
  .command("snapshot <id>")
  .description("Persist a local snapshot of an application")
  .action((id) =>
    run(async () => {
      const s = await core().snapshotApplication(id);
      out(s, () => kv([["Snapshot", s.id], ["Application", s.applicationId], ["Job", s.jobId], ["Captured", fmtDate(s.capturedAt)]]));
    }),
  );
application
  .command("replace-resume <id>")
  .requiredOption("--to <idOrName>", "replacement résumé")
  .option("--from <idOrName>", "résumé expected on the application (comma-separate several identical uploads); required when the package matches more than one résumé")
  .option("--other <idOrName>", 'also replace the "Other - Per Job Posting" document with this one')
  .option("--cover-letter <idOrName>", "also replace the cover letter with this one")
  .option("--execute", "actually cancel and resubmit (default is dry run)")
  .option("--yes", "skip confirmation")
  .action((id, opts) =>
    run(async () => {
      const c = core();
      const expectedOldResumeIds = opts.from ? await resolveResumeIds(c, opts.from) : undefined;
      const documentOverrides = await resolveOverrides(c, opts);
      if (opts.execute && !opts.yes) {
        const swaps = documentOverrides.map((o) => `, ${o.type} → ${o.name}`).join("");
        const ok = await confirm(`Cancel and resubmit application ${id} with résumé ${opts.to}${swaps}? [y/N] `);
        if (!ok) return console.log("Aborted.");
      }
      const r = await c.replaceApplicationResume(id, opts.to, { dryRun: !opts.execute, expectedOldResumeIds, documentOverrides });
      out(r, () => resultLine(r) + (r.dryRun ? "\n(dry run — nothing modified)" : ""));
      if (r.state === "failed") process.exitCode = 1;
    }),
  );

// ---- jobs ----
program.command("job <id>").description("show job metadata").action((id) =>
  run(async () => {
    const j = await core().getJob(id);
    out(j, () => kv([["Employer", j.employer], ["Position", j.title], ["Job ID", j.id], ["Location", j.location], ["Deadline", fmtDate(j.deadline)], ["Status", j.status], ["URL", j.url]]));
  }),
);


const jobs = program.command("jobs").description("scan job postings and export them to a spreadsheet");
jobs
  .command("scan")
  .description("read the job search results and every posting panel into the local database (read-only)")
  .option("--all", "scan every posting, not just the ones in your program")
  .option("--limit <n>", "stop after n postings", (v: string) => parseInt(v, 10))
  .option("--refresh", "re-read postings already cached instead of skipping them")
  .action((opts: { all?: boolean; limit?: number; refresh?: boolean }) =>
    run(async () => {
      const myProgramOnly = !opts.all;
      let last = 0;
      const res = await core().scanJobs({
        myProgramOnly,
        maxJobs: opts.limit,
        refresh: opts.refresh,
        onProgress: (scraped, seen, total) => {
          if (program.opts().json || seen === last) return;
          last = seen;
          process.stderr.write(`\r  ${seen}${total ? `/${total}` : ""} rows, ${scraped} postings read`);
        },
      });
      if (!program.opts().json) process.stderr.write("\n");
      out(res, () =>
        [
          `Scope: ${res.scope}`,
          `Postings read this run: ${res.scraped}`,
          `Already cached (skipped): ${res.cached}`,
          res.failed.length ? `Unreadable: ${res.failed.join(", ")}` : "",
          `Total in database: ${res.postings.length}`,
          "",
          "Next: ww jobs export -o jobs.xlsx",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }),
  );

jobs
  .command("list")
  .description("show cached postings, highest pay first")
  .option("--all", "include postings outside your program")
  .option("--ai", "only postings whose description mentions AI")
  .option("--external", "only postings needing an application outside WaterlooWorks")
  .action((opts: { all?: boolean; ai?: boolean; external?: boolean }) =>
    run(async () => {
      let rows = analyse(core().listJobPostings(opts.all ? undefined : true)).sort(bySalaryDesc);
      if (opts.ai) rows = rows.filter(mentionsAI);
      if (opts.external) rows = rows.filter((r) => r.external.isExternal);
      out(rows, () => jobTable(rows));
    }),
  );

jobs
  .command("export")
  .description('write an .xlsx with "All Jobs", "AI Tooling" and "External Applications" sheets')
  .requiredOption("-o, --out <file>", "output .xlsx path")
  .option("--all", "include postings outside your program")
  .action((opts: { out: string; all?: boolean }) =>
    run(async () => {
      const c = core();
      const postings = c.listJobPostings(opts.all ? undefined : true);
      if (!postings.length) throw new Error("No postings cached. Run `ww jobs scan` first.");
      const res = await c.exportJobs(path.resolve(opts.out), opts.all ? undefined : true);
      out(res, () =>
        [
          `Wrote ${res.path}`,
          `  All Jobs:   ${res.total} postings (${res.withSalary} with a parseable rate)`,
          `  AI Tooling: ${res.aiTooling} postings (${res.aiSpecific} naming specific tooling)`,
          `  External:   ${res.external} postings (${res.externalOnly} applied to entirely outside WaterlooWorks)`,
        ].join("\n"),
      );
    }),
  );

// ---- plans / operations / recovery ----
const plans = program.command("plans").description("replacement plans");
plans.command("list").action(() =>
  run(async () => {
    const ps = core().listPlans();
    out(ps, () => ps.map((p) => `${p.id}  ${fmtDate(p.createdAt)}  ${p.oldResumeName} → ${p.newResumeName}  eligible=${p.eligible.length}  ${p.executedAt ? "EXECUTED " + fmtDate(p.executedAt) : "pending"}`).join("\n") || "(none)");
  }),
);
plans.command("show <id>").action((id) =>
  run(async () => {
    const p = core().getPlan(id);
    if (!p) throw new WWError(`Plan not found: ${id}`, "NOT_FOUND");
    out(p, () => planSummary(p));
  }),
);

const operations = program.command("operations").description("operation history and recovery state");
operations.command("list").action(() =>
  run(async () => {
    const ops = core().listOperations();
    out(ops, () => ops.map((o) => `${o.id}  ${fmtDate(o.startedAt)}  ${o.operationType}  job=${o.jobId}  ${o.state}${o.error ? "  " + o.error : ""}`).join("\n") || "(none)");
  }),
);
operations.command("incomplete").action(() =>
  run(async () => {
    const list = core().listIncompleteOperations();
    out(list, () =>
      list.length
        ? list
            .map(({ operation: o, snapshot: s }) =>
              kv([
                ["Incomplete operation", o.id],
                ["Job", o.jobId],
                ["Employer", s?.job?.employer],
                ["Position", s?.job?.title],
                ["State", o.state],
                ["Snapshot", s ? "available" : "MISSING"],
                ["Error", o.error],
              ]) + "Recovery required: ww recover " + o.jobId + "\n",
            )
            .join("\n")
        : "No incomplete operations.",
    );
    if (list.length) process.exitCode = 3;
  }),
);

program
  .command("recover <jobOrOperationId>")
  .description("Reconstruct an application from its snapshot after an interrupted replacement")
  .option("--dry-run", "inspect live state and report what recovery would do")
  .option("--to <idOrName>", "resubmit with this résumé instead of the one from the failed operation")
  .option("--other <idOrName>", 'resubmit with this "Other - Per Job Posting" document instead of the snapshot\'s')
  .option("--cover-letter <idOrName>", "resubmit with this cover letter instead of the snapshot's")
  .option("--yes", "skip confirmation")
  .action((id, opts) =>
    run(async () => {
      const c = core();
      const documentOverrides = await resolveOverrides(c, opts);
      if (!opts.dryRun && !opts.yes) {
        const ok = await confirm(`Attempt recovery for ${id}? This may submit an application. [y/N] `);
        if (!ok) return console.log("Aborted.");
      }
      const r = await c.recover(id, { dryRun: !!opts.dryRun, resumeId: opts.to, documentOverrides });
      out(r, () => resultLine(r));
      if (r.state === "failed") process.exitCode = 1;
    }),
  );

// ---- debug ----
const debug = program.command("debug").description("selector calibration helpers");
debug
  .command("page <sitePath>")
  .description("dump the HTML of a WaterlooWorks path (e.g. /myAccount/co-op/applications.htm)")
  .option("-o, --out <file>", "write HTML to a file")
  .action((sitePath, opts) =>
    run(async () => {
      const c = core();
      if (!(c.provider instanceof PlaywrightWaterlooWorksProvider)) throw new WWError("debug requires the Playwright provider", "BAD_PROVIDER");
      const { url, html } = await c.provider.dumpPage(sitePath);
      if (opts.out) {
        fs.writeFileSync(opts.out, html);
        console.log(`${url}\n→ ${opts.out} (${html.length} bytes)`);
      } else console.log(html);
    }),
  );

/** Turn --other / --cover-letter flags into document overrides. */
async function resolveOverrides(c: ReturnType<typeof core>, opts: { other?: string; coverLetter?: string }): Promise<DocumentOverride[]> {
  const out: DocumentOverride[] = [];
  if (opts.other) out.push(await c.resolveDocument("other", opts.other));
  if (opts.coverLetter) out.push(await c.resolveDocument("cover_letter", opts.coverLetter));
  return out;
}

/** Resolve a comma-separated list of résumé IDs or names to IDs. */
async function resolveResumeIds(c: ReturnType<typeof core>, list: string): Promise<string[]> {
  const ids: string[] = [];
  for (const key of list.split(",").map((k) => k.trim()).filter(Boolean)) ids.push((await c.resolveResume(key)).id);
  return ids;
}

async function confirm(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = await import("node:readline/promises");
  const i = rl.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await i.question(q)).trim().toLowerCase();
  i.close();
  return a === "y" || a === "yes";
}

program.parseAsync(process.argv);
