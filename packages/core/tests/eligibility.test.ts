import { describe, expect, it } from "vitest";
import { checkEligibility, type Application } from "../src/index.js";

const base: Application = {
  id: "1",
  jobId: "1",
  job: { id: "1", title: "t", employer: "e", status: "open", deadline: new Date(Date.now() + 86400_000) },
  status: "submitted",
  documents: [],
  questions: [],
  canCancel: true,
  canReapply: true,
};

describe("checkEligibility with ambiguous résumés", () => {
  const amb = { ...base, resume: { id: "a|b", name: "a | b", filename: "" } };
  it("is ineligible when the ambiguity is not covered", () => {
    expect(checkEligibility({ app: amb, oldResumeId: "a", newResumeId: "n" })).toEqual({ eligible: false, reason: "ambiguous_resume" });
  });
  it("is eligible when every candidate is in the old set", () => {
    expect(checkEligibility({ app: amb, oldResumeIds: ["a", "b"], newResumeId: "n" })).toEqual({ eligible: true });
  });
  it("still refuses when the new résumé is already attached", () => {
    expect(checkEligibility({ app: amb, oldResumeIds: ["a", "b"], newResumeId: "b" })).toEqual({ eligible: false, reason: "resume_already_replaced" });
  });
  it("treats an unidentified résumé as unknown state when an old résumé is expected", () => {
    expect(checkEligibility({ app: { ...base, resume: undefined }, oldResumeId: "a", newResumeId: "n" })).toEqual({ eligible: false, reason: "unknown_state" });
  });
});
