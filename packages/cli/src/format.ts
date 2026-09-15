import { aiSpecificity, externalLabel, formatSalary, type Application, type BatchReplacementPlan, type JobRow, type ReplacementResult, type Resume } from "@ww/core";

export const fmtDate = (d?: Date) => (d ? d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—");

export function kv(pairs: [string, unknown][]): string {
  return pairs.map(([k, v]) => `${k}:\n${v ?? "—"}\n`).join("\n");
}

export function applicationTable(apps: Application[]): string {
  if (!apps.length) return "(no applications)";
  const rows = apps.map((a) => [
    a.jobId,
    a.job?.employer ?? "",
    a.job?.title ?? "",
    a.status,
    a.resume?.name ?? "",
    fmtDate(a.job?.deadline),
    a.canCancel && a.canReapply ? "editable" : "",
  ]);
  return table(["Job", "Employer", "Position", "Status", "Résumé", "Deadline", ""], rows);
}

export function resumeTable(rs: Resume[]): string {
  if (!rs.length) return "(no résumés)";
  return table(
    ["ID", "Name", "Uploaded", "SHA-256"],
    rs.map((r) => [r.id, r.name, fmtDate(r.uploadedAt), r.sha256 ? r.sha256.slice(0, 12) + "…" : ""]),
  );
}

export function applicationDetail(a: Application): string {
  const docs = a.documents.filter((d) => d.type !== "resume");
  const byType = (t: string) => docs.filter((d) => d.type === t).map((d) => d.name).join(", ") || "—";
  return kv([
    ["Employer", a.job?.employer],
    ["Position", a.job?.title],
    ["Job ID", a.jobId],
    ["Application ID", a.id],
    ["Deadline", fmtDate(a.job?.deadline)],
    ["Status", a.status],
    ["Resume", a.resume?.name],
    ["Cover Letter", byType("cover_letter")],
    ["Transcript", byType("transcript")],
    ["Work History", byType("work_history")],
    ["Other", byType("other")],
    ["Questions", a.questions.length ? a.questions.map((q) => `  ${q.question} → ${q.answer}`).join("\n") : "—"],
    ["Can Cancel", a.canCancel ? "Yes" : "No"],
    ["Can Reapply", a.canReapply ? "Yes" : "No"],
  ]);
}

export function planSummary(p: BatchReplacementPlan): string {
  const lines: string[] = [];
  lines.push(kv([
    ["Plan ID", p.id],
    [`Applications using ${p.oldResumeName ?? p.oldResumeId}`, p.eligible.length + p.ineligible.length],
    ["Eligible", p.eligible.length],
    ["Ineligible", p.ineligible.length],
  ]));
  lines.push("\nProposed changes\n────────────────────────\n");
  for (const c of p.eligible) {
    lines.push(`${c.jobId}\n${c.employer ?? ""}\n${c.title ?? ""}\n\n${c.currentResumeName ?? p.oldResumeName}\n      ↓\n${p.newResumeName ?? p.newResumeId}\n\nOther documents:\nUNCHANGED\n\n`);
  }
  if (p.ineligible.length) {
    lines.push("\nIneligible\n────────────────────────\n");
    for (const c of p.ineligible) lines.push(`${c.jobId}  ${c.employer ?? ""}  ${c.title ?? ""}\n  reason: ${c.reason}\n`);
  }
  return lines.join("\n");
}

export function resultLine(r: ReplacementResult): string {
  const icon = r.state === "verified" ? "✅" : r.dryRun ? "📝" : "❌";
  let s = `${icon} job ${r.jobId}  ${r.state}`;
  if (r.newApplicationId) s += `  new=${r.newApplicationId}`;
  if (r.error) s += `\n   error: ${r.error}`;
  if (r.verification?.issues.length) s += "\n   " + r.verification.issues.map((i) => `${i.field}: expected ${i.expected}, got ${i.actual}`).join("\n   ");
  if (r.requiresRecovery) s += `\n   ⚠ RECOVERY REQUIRED — run: ww recover ${r.jobId}`;
  return s;
}

export function table(headers: string[], rows: string[][]): string {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(w[i])).join("  ");
  return [line(headers), w.map((n) => "─".repeat(n)).join("  "), ...rows.map(line)].join("\n");
}

export function jobTable(rows: JobRow[]): string {
  if (!rows.length) return "(no postings cached; run `ww jobs scan`)";
  return table(
    ["Job", "Employer", "Position", "Pay", "$/hr", "Location", "Deadline", "AI", "Outside WW"],
    rows.map((r) => [
      r.posting.jobId,
      r.posting.employer,
      r.posting.title,
      formatSalary(r.salary),
      r.salary.hourly !== undefined ? r.salary.hourly.toFixed(2) : "",
      r.posting.location ?? r.posting.city ?? "",
      fmtDate(r.posting.deadline),
      aiSpecificity(r) === "specific tooling" ? "tool" : aiSpecificity(r) ? "gen" : "",
      externalLabel(r) ? (r.external.kind === "method" ? "only" : "also") : "",
    ]),
  );
}
