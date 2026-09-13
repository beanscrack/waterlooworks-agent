import { describe, expect, it } from "vitest";
import { verifyReplacement, type Application, type ApplicationSnapshot } from "../src/index.js";

const snap: ApplicationSnapshot = {
  id: "s",
  applicationId: "a",
  jobId: "1",
  status: "submitted",
  resume: { id: "old", name: "old.pdf", filename: "old.pdf" },
  documents: [
    { type: "resume", name: "old.pdf" },
    { type: "cover_letter", name: "cl.pdf" },
  ],
  questions: [{ question: "Q1", answer: "A1" }],
  capturedAt: new Date(),
};
const base: Application = {
  id: "b",
  jobId: "1",
  status: "submitted",
  resume: { id: "new", name: "new.pdf", filename: "new.pdf" },
  documents: [
    { type: "resume", name: "new.pdf" },
    { type: "cover_letter", name: "cl.pdf" },
  ],
  questions: [{ question: "Q1", answer: "A1" }],
  canCancel: true,
  canReapply: true,
};

describe("verifyReplacement", () => {
  it("verifies when only the résumé changed", () => {
    expect(verifyReplacement(base, snap, { id: "new", name: "new.pdf" }).status).toBe("VERIFIED");
  });
  it("fails when a document is missing", () => {
    const r = verifyReplacement({ ...base, documents: [base.documents[0]] }, snap, { id: "new", name: "new.pdf" });
    expect(r.status).toBe("FAILED_VERIFICATION");
    expect(r.issues[0].field).toContain("cover_letter");
  });
  it("fails when an answer differs or the résumé is wrong", () => {
    expect(verifyReplacement({ ...base, questions: [{ question: "Q1", answer: "B" }] }, snap, { id: "new", name: "new.pdf" }).status).toBe("FAILED_VERIFICATION");
    expect(verifyReplacement(base, snap, { id: "other", name: "other.pdf" }).status).toBe("FAILED_VERIFICATION");
  });
  it("accepts any candidate of an ambiguous document", () => {
    const s2 = { ...snap, documents: [...snap.documents, { type: "other" as const, name: "gyatt | gyatt", id: "1|2" }] };
    const f2 = { ...base, documents: [...base.documents, { type: "other" as const, name: "gyatt", id: "1" }] };
    expect(verifyReplacement(f2, s2, { id: "new", name: "new.pdf" }).status).toBe("VERIFIED");
  });
  it("accepts the new résumé when it was identified ambiguously among identical uploads", () => {
    const f = { ...base, resume: { id: "new|twin", name: "new.pdf | twin.pdf", filename: "new.pdf" } };
    expect(verifyReplacement(f, snap, { id: "new", name: "new.pdf" }).status).toBe("VERIFIED");
    expect(verifyReplacement(f, snap, { id: "other", name: "other.pdf" }).status).toBe("FAILED_VERIFICATION");
  });
  it("fails on wrong job or non-submitted status", () => {
    expect(verifyReplacement({ ...base, jobId: "2" }, snap, { id: "new", name: "new.pdf" }).issues.some((i) => i.field === "jobId")).toBe(true);
    expect(verifyReplacement({ ...base, status: "cancelled" }, snap, { id: "new", name: "new.pdf" }).issues.some((i) => i.field === "status")).toBe(true);
  });
});
