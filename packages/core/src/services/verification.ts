import type { Application, ApplicationDocument, ApplicationSnapshot, VerificationResult, VerificationIssue } from "../models/index.js";

/** Candidate names for a document; "a | b" means several identical uploads were indistinguishable. */
const names = (d: ApplicationDocument) => d.name.split(" | ").map((n) => n.trim());
const sameDoc = (a: ApplicationDocument, b: ApplicationDocument) => a.type === b.type && names(a).some((n) => names(b).includes(n));
const label = (d: ApplicationDocument) => `${d.type}:${d.name}`;

/**
 * Compare a freshly reloaded application against the snapshot and the intended
 * résumé (spec section 13). Clicking Submit is never treated as success.
 */
export function verifyReplacement(
  fresh: Application,
  snapshot: ApplicationSnapshot,
  expectedResume: { id: string; name: string },
): VerificationResult {
  const issues: VerificationIssue[] = [];
  const push = (field: string, expected: unknown, actual: unknown) =>
    issues.push({ field, expected: String(expected), actual: String(actual) });

  if (fresh.jobId !== snapshot.jobId) push("jobId", snapshot.jobId, fresh.jobId);
  if (fresh.status !== "submitted") push("status", "submitted", fresh.status);

  // The provider may identify the résumé as "a|b" when several uploads render identically.
  const resumeOk =
    fresh.resume &&
    (fresh.resume.id.split("|").includes(expectedResume.id) || fresh.resume.name.split(" | ").map((n) => n.trim()).includes(expectedResume.name));
  if (!resumeOk) push("resume", `${expectedResume.name} (${expectedResume.id})`, fresh.resume ? `${fresh.resume.name} (${fresh.resume.id})` : "none");

  const expectedDocs = snapshot.documents.filter((d) => d.type !== "resume");
  const actualDocs = fresh.documents.filter((d) => d.type !== "resume");
  for (const e of expectedDocs) if (!actualDocs.some((a) => sameDoc(e, a))) push(`document ${label(e)}`, "present", "missing");
  for (const a of actualDocs) if (!expectedDocs.some((e) => sameDoc(e, a))) push(`document ${label(a)}`, "absent", "present");

  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const expQ = new Map(snapshot.questions.map((q) => [norm(q.question), norm(q.answer)]));
  const actQ = new Map(fresh.questions.map((q) => [norm(q.question), norm(q.answer)]));
  for (const [q, a] of expQ) {
    if (!actQ.has(q)) push(`question "${q}"`, a, "missing");
    else if (actQ.get(q) !== a) push(`question "${q}"`, a, actQ.get(q));
  }

  return { status: issues.length ? "FAILED_VERIFICATION" : "VERIFIED", issues };
}
