import type { JobPosting } from "../models/index.js";

/**
 * Postings you cannot finish inside WaterlooWorks. Two different things qualify:
 *
 * - `method`   — the posting's "Application Method" field is not WaterlooWorks at all.
 * - `dual`     — you apply in WaterlooWorks *and* must do something else: the employer's own form,
 *                an ATS link, a take-home project. WaterlooWorks calls these "two step" postings and
 *                warns, when you cancel one, that the external half has to be withdrawn separately.
 *
 * Interview-process blurbs ("a 45-minute technical interview") and recruiter-contact notes are not
 * external applications, so a match needs an apply verb aimed at somewhere other than WaterlooWorks.
 */
export type ExternalKind = "method" | "dual" | "none";

export interface ExternalApplication {
  kind: ExternalKind;
  isExternal: boolean;
  /** Verbatim "Application Method", when the posting stated one. */
  method?: string;
  /** Employer/ATS links found in the sentence that triggered the match. */
  urls: string[];
  /** Why it was flagged: the method, or the sentence demanding the extra step. */
  evidence?: string;
}

/** Applicant tracking systems; a link to one inside an "apply" sentence is a strong signal. */
const ATS =
  /\b(?:myworkdayjobs|workday|greenhouse\.io|boards\.greenhouse|lever\.co|jobs\.lever|ashbyhq|smartrecruiters|icims|taleo|bamboohr|jazzhr|workable|breezy\.hr|teamtailor|recruitee|jobvite|successfactors|eightfold|paylocity|dayforce)\b/i;

const URL = /https?:\/\/[^\s)>\]]+/gi;

/** An instruction to apply somewhere besides WaterlooWorks. */
const DUAL_APPLY: RegExp[] = [
  // "apply through WaterlooWorks and directly to the employer"
  /\bappl(?:y|ication|icants?)\b[^.]{0,90}\b(?:and|as well as|in addition to)\b[^.]{0,90}\b(?:direct(?:ly)?|employer'?s?|company'?s?|external|their|our)\b[^.]{0,40}\b(?:site|website|portal|page|link|careers?|job\s*board)?/i,
  // "you must also apply on our careers page"
  /\b(?:also|additionally|in addition|separately)\b[^.]{0,60}\bappl(?:y|ication)\b/i,
  // "apply via the employer's website"
  /\bappl(?:y|ication)\b[^.]{0,40}\b(?:through|via|on|at|to)\b[^.]{0,40}\b(?:employer'?s?|company'?s?|our|their|external)\b[^.]{0,30}\b(?:website|site|portal|careers?|page|link)/i,
  // "apply ... to the D2L Careers page" / "through the BMO Careers page" — WaterlooWorks is never
  // called a careers page, so the phrase names somewhere else even without a possessive.
  /\bappl(?:y|ication|icants?)\b[^.]{0,80}\b(?:careers?\s*(?:page|site|portal|website|centre|center)|job\s*board|application\s*(?:site|portal))\b/i,
  // WaterlooWorks' own wording for these postings
  /\btwo[\s-]step\b[^.]{0,40}\b(?:process|application)/i,
];

/** Rules out interview logistics that happen to contain an apply-ish word. */
const NOT_AN_APPLICATION = /\b(interview process|interview will|contacting you|contact you directly|make interview arrangements|interviews take place)\b/i;

// Deliberately not splitting on ":" — employers write "apply here: https://…" and the link is the
// most useful part of the evidence.
const sentences = (text: string) =>
  text
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

const urlsIn = (text: string) => [...new Set(text.match(URL) ?? [])];

export function classifyApplication(posting: JobPosting): ExternalApplication {
  const method = posting.applicationMethod?.trim();
  if (method && !/waterloo\s*works/i.test(method)) {
    return { kind: "method", isExternal: true, method, urls: urlsIn(method), evidence: `Application Method: ${method}` };
  }

  // The employer's own instructions, wherever they wrote them.
  const text = [posting.additionalInfo, posting.specialRequirements].filter(Boolean).join("\n");
  for (const sentence of sentences(text)) {
    if (NOT_AN_APPLICATION.test(sentence)) continue;
    const urls = urlsIn(sentence);
    const phrase = DUAL_APPLY.some((re) => re.test(sentence));
    const atsLink = urls.some((u) => ATS.test(u)) && /\bappl/i.test(sentence);
    if (!phrase && !atsLink) continue;
    // Employers often put the link on the line below the instruction ("apply here:\nhttps://…"),
    // so fall back to the links anywhere in the instructions once we know this posting is external.
    return { kind: "dual", isExternal: true, method, urls: urls.length ? urls : urlsIn(text), evidence: sentence };
  }
  return { kind: "none", isExternal: false, method, urls: [] };
}
