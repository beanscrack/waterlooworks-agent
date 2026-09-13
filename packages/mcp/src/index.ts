#!/usr/bin/env node
/**
 * ww-mcp: MCP server exposing high-level WaterlooWorks operations (spec sections 21-28).
 *
 * stdout is the MCP transport, so all logging goes to stderr (createLogger defaults to stderr).
 *
 * Permission model:
 *   Level 0/1 tools run freely.
 *   Level 2 tools (upload, execute plan, single replacement) are gated by WW_MCP_ALLOW_MUTATION=1
 *   and additionally by an explicit `confirm: true` argument, so an agent must state intent twice.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createCore, WWError, type WaterlooWorksCore } from "@ww/core";

const MUTATION_ALLOWED = process.env.WW_MCP_ALLOW_MUTATION === "1";
const DIRECT_REPLACE_ALLOWED = process.env.WW_MCP_ALLOW_DIRECT_REPLACE === "1";

let coreRef: WaterlooWorksCore | undefined;
const core = () => (coreRef ??= createCore({ config: { headless: process.env.WW_HEADLESS !== "0" } }));

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, replacer, 2) }],
});
const replacer = (_k: string, v: unknown) => (v instanceof Date ? v.toISOString() : v);
const fail = (e: unknown) => {
  const msg = e instanceof WWError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `ERROR ${msg}` }], isError: true };
};
const wrap = <T>(fn: () => Promise<T>) => fn().then(json).catch(fail);

function requireMutation(what: string) {
  if (!MUTATION_ALLOWED)
    throw new WWError(
      `${what} is an external mutation (permission level 2). The server was started without WW_MCP_ALLOW_MUTATION=1; ask the user to enable it.`,
      "MUTATION_DISABLED",
    );
}

const server = new McpServer({ name: "waterlooworks", version: "0.1.0" });

// ---------- Level 0: read-only ----------
server.tool("ww_auth_status", "Report whether the local WaterlooWorks browser session is authenticated. Read-only.", {}, () =>
  wrap(async () => ({ authenticated: await core().isAuthenticated() })),
);

server.tool("ww_list_resumes", "Return all résumés stored in WaterlooWorks. Read-only.", {}, () => wrap(() => core().listResumes()));

server.tool(
  "ww_list_applications",
  "Return WaterlooWorks applications matching optional filters. Read-only. `editable_only` is slow because each application detail page is read.",
  {
    status: z.enum(["submitted", "cancelled", "expired"]).optional(),
    resume_id: z.string().optional().describe("Résumé ID or display name"),
    editable_only: z.boolean().optional(),
  },
  (a) =>
    wrap(async () => {
      const c = core();
      const resumeId = a.resume_id ? (await c.resolveResume(a.resume_id)).id : undefined;
      return c.listApplications({ status: a.status, resumeId, editableOnly: a.editable_only });
    }),
);

server.tool(
  "ww_get_application",
  "Inspect one application: job, status, résumé, other documents, question answers, and whether it can be cancelled/reapplied. Read-only.",
  { application_id: z.string() },
  (a) => wrap(() => core().getApplication(a.application_id)),
);

server.tool("ww_get_job", "Retrieve job posting metadata (title, employer, deadline, status). Read-only.", { job_id: z.string() }, (a) =>
  wrap(() => core().getJob(a.job_id)),
);

server.tool(
  "ww_list_incomplete_operations",
  "List replacement operations that stopped between cancellation and verification and need recovery. Read-only.",
  {},
  () => wrap(async () => core().listIncompleteOperations()),
);

// ---------- Level 1: local ----------
server.tool(
  "ww_list_documents",
  'List user documents of one type on WaterlooWorks: "resume", "cover_letter" or "other" (Other - Per Job Posting). Read-only.',
  { type: z.enum(["resume", "cover_letter", "other"]) },
  (a) => wrap(() => core().listDocuments(a.type)),
);

server.tool(
  "ww_snapshot_application",
  "Store a local snapshot of an application's package in SQLite. Does not modify WaterlooWorks.",
  { application_id: z.string() },
  (a) => wrap(() => core().snapshotApplication(a.application_id)),
);

server.tool(
  "ww_preview_resume_replacement",
  [
    "Creates a read-only plan showing which existing WaterlooWorks applications currently use a specified résumé",
    "and appear eligible for cancellation and resubmission with the new résumé.",
    "Returns a plan_id to pass to ww_execute_resume_replacement after the user approves.",
    "This operation does not modify WaterlooWorks.",
  ].join(" "),
  {
    old_resume_id: z.string().describe("Résumé ID or name currently on the applications"),
    new_resume_id: z.string().describe("Résumé ID or name to switch to"),
  },
  (a) =>
    wrap(async () => {
      const p = await core().previewResumeReplacement({ oldResumeId: a.old_resume_id, newResumeId: a.new_resume_id });
      return {
        plan_id: p.id,
        old_resume: { id: p.oldResumeId, name: p.oldResumeName },
        new_resume: { id: p.newResumeId, name: p.newResumeName },
        eligible: p.eligible.length,
        ineligible: p.ineligible.length,
        eligible_applications: p.eligible,
        ineligible_applications: p.ineligible,
        expected_external_operations: { cancellations: p.eligible.length, submissions: p.eligible.length },
        note: "No applications have been modified. Present this plan to the user and obtain explicit approval before executing.",
      };
    }),
);

server.tool("ww_get_plan", "Return a previously created replacement plan by ID. Read-only.", { plan_id: z.string() }, (a) =>
  wrap(async () => {
    const p = core().getPlan(a.plan_id);
    if (!p) throw new WWError(`Plan not found: ${a.plan_id}`, "NOT_FOUND");
    return p;
  }),
);

// ---------- Level 2: external mutation ----------
server.tool(
  "ww_upload_resume",
  "Upload a new résumé file to WaterlooWorks. EXTERNAL MUTATION: requires user approval and `confirm: true`.",
  { path: z.string(), name: z.string(), confirm: z.literal(true).describe("Must be true; signals the user approved this upload") },
  (a) =>
    wrap(async () => {
      requireMutation("ww_upload_resume");
      return core().uploadResume(a.path, a.name);
    }),
);

server.tool(
  "ww_upload_document",
  'Upload a PDF as a "cover_letter" or "other" (Other - Per Job Posting) document. EXTERNAL MUTATION: requires user approval and `confirm: true`.',
  {
    path: z.string(),
    type: z.enum(["resume", "cover_letter", "other"]),
    name: z.string().optional(),
    confirm: z.literal(true).describe("Must be true; signals the user approved this upload"),
  },
  (a) =>
    wrap(async () => {
      requireMutation("ww_upload_document");
      return core().uploadDocument(a.path, a.type, a.name);
    }),
);

server.tool(
  "ww_execute_resume_replacement",
  [
    "Executes a previously generated résumé replacement plan. EXTERNAL MUTATION: requires user approval and `confirm: true`.",
    "For each eligible application, sequentially: 1. snapshots the current application; 2. cancels the existing application;",
    "3. recreates the application; 4. replaces the résumé; 5. preserves supported application data (cover letter, transcript,",
    "other documents, question answers); 6. submits; 7. verifies the resulting application against the snapshot.",
    "Execution stops on the first error. A plan can be executed only once. If an application was cancelled but not",
    "resubmitted, the result lists it under requiresRecovery; the user must run `ww recover <job_id>`.",
  ].join(" "),
  { plan_id: z.string(), confirm: z.literal(true).describe("Must be true; signals the user approved this exact plan_id") },
  (a) =>
    wrap(async () => {
      requireMutation("ww_execute_resume_replacement");
      const progress: string[] = [];
      const r = await core().executeResumeReplacement(a.plan_id, ({ index, total, result }) =>
        progress.push(`${index}/${total} job ${result.jobId}: ${result.state}${result.error ? " — " + result.error : ""}`),
      );
      return { ...r, progress };
    }),
);

server.tool(
  "ww_replace_application_resume",
  [
    "Replace the résumé on ONE application (snapshot → cancel → resubmit → verify). With dry_run=true it only snapshots and",
    "reports the plan. With dry_run=false it is an EXTERNAL MUTATION that requires user approval, `confirm: true`, and the",
    "server flag WW_MCP_ALLOW_DIRECT_REPLACE=1. Prefer preview → plan → execute.",
  ].join(" "),
  {
    application_id: z.string(),
    resume_id: z.string(),
    old_resume_id: z
      .string()
      .optional()
      .describe("Résumé ID(s) or name(s) expected on the application, comma-separated. Required when the package matches several identical résumés."),
    other_document_id: z.string().optional().describe('Also swap the "Other - Per Job Posting" document to this ID or name'),
    cover_letter_id: z.string().optional().describe("Also swap the cover letter to this ID or name"),
    dry_run: z.boolean(),
    confirm: z.boolean().optional(),
  },
  (a) =>
    wrap(async () => {
      if (!a.dry_run) {
        requireMutation("ww_replace_application_resume");
        if (!DIRECT_REPLACE_ALLOWED) throw new WWError("Direct replacement is disabled (WW_MCP_ALLOW_DIRECT_REPLACE=1 not set). Use preview/execute.", "DIRECT_REPLACE_DISABLED");
        if (a.confirm !== true) throw new WWError("confirm must be true for a non-dry-run replacement.", "CONFIRM_REQUIRED");
      }
      const expectedOldResumeIds: string[] = [];
      for (const key of (a.old_resume_id ?? "").split(",").map((k) => k.trim()).filter(Boolean)) expectedOldResumeIds.push((await core().resolveResume(key)).id);
      const documentOverrides = [];
      if (a.other_document_id) documentOverrides.push(await core().resolveDocument("other", a.other_document_id));
      if (a.cover_letter_id) documentOverrides.push(await core().resolveDocument("cover_letter", a.cover_letter_id));
      return core().replaceApplicationResume(a.application_id, a.resume_id, {
        dryRun: a.dry_run,
        expectedOldResumeIds: expectedOldResumeIds.length ? expectedOldResumeIds : undefined,
        documentOverrides,
      });
    }),
);

server.tool(
  "ww_recover",
  "Recover an interrupted replacement for a job/operation ID using its stored snapshot. dry_run=true only inspects. Otherwise EXTERNAL MUTATION requiring `confirm: true`.",
  {
    id: z.string(),
    dry_run: z.boolean().default(true),
    resume_id: z.string().optional().describe("Résumé ID or name to resubmit with, overriding the failed operation's résumé"),
    other_document_id: z.string().optional().describe('Resubmit with this "Other - Per Job Posting" document instead of the snapshot\'s'),
    confirm: z.boolean().optional(),
  },
  (a) =>
    wrap(async () => {
      if (!a.dry_run) {
        requireMutation("ww_recover");
        if (a.confirm !== true) throw new WWError("confirm must be true for a non-dry-run recovery.", "CONFIRM_REQUIRED");
      }
      const documentOverrides = a.other_document_id ? [await core().resolveDocument("other", a.other_document_id)] : undefined;
      return core().recover(a.id, { dryRun: a.dry_run, resumeId: a.resume_id, documentOverrides });
    }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = async () => {
    await coreRef?.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
