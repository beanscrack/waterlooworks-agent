import { NotFoundError, WWError } from "../errors.js";
import { logEvent, type Logger } from "../logger.js";
import type { DocumentType } from "../models/index.js";
import type { UserDocument, WaterlooWorksProvider } from "../providers/WaterlooWorksProvider.js";

export const USER_DOC_TYPES: readonly DocumentType[] = ["resume", "cover_letter", "other"];

export interface CleanupCandidate extends UserDocument {
  action: "archive" | "keep";
  reason: string;
  /** Job IDs of submitted applications whose package contains (or may contain) this document. */
  usedBy: string[];
}

export interface CleanupPlan {
  newDefaultResume?: UserDocument;
  /** Résumés currently flagged default that will lose the flag. */
  unsetDefaults: UserDocument[];
  candidates: CleanupCandidate[];
  archive: CleanupCandidate[];
  keep: CleanupCandidate[];
}

export interface CleanupResult {
  unsetDefaults: string[];
  setDefault?: string;
  archived: string[];
  failed?: { id: string; error: string };
}

/**
 * Archive every user document that no submitted application uses, and make one résumé the
 * single default. Archiving is reversible in the WaterlooWorks UI ("Unarchive Selected").
 * Documents referenced by any current package are always kept: the apply wizard can only
 * select non-archived documents, so archiving them would break replacements and recovery.
 */
export class DocumentCleanupService {
  constructor(private provider: WaterlooWorksProvider, private log: Logger) {}

  onProgress?: (message: string) => void;

  async plan(input: { defaultResume?: string; keep?: string[] } = {}): Promise<CleanupPlan> {
    const byType = new Map<DocumentType, UserDocument[]>();
    for (const t of USER_DOC_TYPES) byType.set(t, await this.provider.listDocuments(t));
    const all = [...byType.values()].flat();

    const resolve = (type: DocumentType | undefined, key: string): UserDocument => {
      const pool = type ? byType.get(type)! : all;
      const byId = pool.find((d) => d.id === key);
      const byName = pool.filter((d) => d.name === key);
      const d = byId ?? (byName.length === 1 ? byName[0] : undefined);
      if (!d) throw new NotFoundError(byName.length > 1 ? "Unique document (several share that name; use the ID)" : "Document", key);
      return d;
    };
    const newDefault = input.defaultResume ? resolve("resume", input.defaultResume) : undefined;
    const keepIds = new Set((input.keep ?? []).map((k) => resolve(undefined, k).id));

    // Which documents do current submitted applications reference? Composite ids ("a|b") mean the
    // package matched several identical uploads; all of them count as in use (conservative).
    const usedBy = new Map<string, Set<string>>();
    const mark = (id: string | undefined, jobId: string) => {
      for (const part of (id ?? "").split("|").filter(Boolean)) {
        if (!usedBy.has(part)) usedBy.set(part, new Set());
        usedBy.get(part)!.add(jobId);
      }
    };
    const submitted = await this.provider.listApplications({ status: "submitted" });
    for (const s of submitted) {
      this.onProgress?.(`inspecting application ${s.jobId}`);
      const app = await this.provider.getApplication(s.id);
      mark(app.resume?.id, app.jobId);
      for (const d of app.documents) mark(d.id, app.jobId);
    }

    const candidates: CleanupCandidate[] = all.map((d) => {
      const jobs = [...(usedBy.get(d.id) ?? [])].sort();
      let action: CleanupCandidate["action"] = "archive";
      let reason = "not used by any submitted application";
      if (newDefault && d.id === newDefault.id) [action, reason] = ["keep", "new default résumé"];
      else if (keepIds.has(d.id)) [action, reason] = ["keep", "kept on request"];
      else if (jobs.length) [action, reason] = ["keep", `used by ${jobs.length} submitted application${jobs.length > 1 ? "s" : ""}`];
      return { ...d, action, reason, usedBy: jobs };
    });
    const unsetDefaults = byType.get("resume")!.filter((d) => d.isDefault && d.id !== newDefault?.id);
    if (!newDefault) {
      // Without a new default, keep the current defaults (the UI refuses to archive them anyway).
      for (const c of candidates) if (c.isDefault && c.action === "archive") [c.action, c.reason] = ["keep", "current default (pass --default to replace)"];
      unsetDefaults.length = 0;
    }
    return {
      newDefaultResume: newDefault,
      unsetDefaults,
      candidates,
      archive: candidates.filter((c) => c.action === "archive"),
      keep: candidates.filter((c) => c.action === "keep"),
    };
  }

  /** Execute a plan: unset old defaults → set the new default → archive, type by type. Stops at the first failure. */
  async execute(plan: CleanupPlan): Promise<CleanupResult> {
    const result: CleanupResult = { unsetDefaults: [], archived: [] };
    if (plan.newDefaultResume) {
      for (const d of plan.unsetDefaults) {
        await this.provider.setDefaultDocument("resume", d.id, false);
        result.unsetDefaults.push(d.id);
        logEvent(this.log, "DOCUMENT_DEFAULT_CHANGED", { id: d.id, name: d.name, isDefault: false });
      }
      if (!plan.newDefaultResume.isDefault) {
        await this.provider.setDefaultDocument("resume", plan.newDefaultResume.id, true);
        logEvent(this.log, "DOCUMENT_DEFAULT_CHANGED", { id: plan.newDefaultResume.id, name: plan.newDefaultResume.name, isDefault: true });
      }
      result.setDefault = plan.newDefaultResume.id;
    } else if (plan.archive.some((c) => c.isDefault)) {
      throw new WWError("Plan archives a default document but names no new default.", "INVALID_PLAN");
    }
    for (const type of USER_DOC_TYPES) {
      const ids = plan.archive.filter((c) => c.type === type).map((c) => c.id);
      if (!ids.length) continue;
      this.onProgress?.(`archiving ${ids.length} ${type} document${ids.length > 1 ? "s" : ""}`);
      try {
        const done = await this.provider.archiveDocuments(type, ids);
        result.archived.push(...done);
        for (const id of done) logEvent(this.log, "DOCUMENT_ARCHIVED", { id, type });
        if (done.length !== ids.length) throw new WWError(`Only ${done.length}/${ids.length} ${type} documents were archived.`, "PARTIAL");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const next = ids.find((id) => !result.archived.includes(id)) ?? "?";
        result.failed = { id: next, error: msg };
        logEvent(this.log, "OPERATION_FAILED", { operationId: "cleanup", jobId: "-", phase: `archive ${type}`, error: msg, requiresRecovery: false });
        return result;
      }
    }
    return result;
  }
}
