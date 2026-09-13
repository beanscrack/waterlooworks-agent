import { newId } from "../ids.js";
import { logEvent, type Logger } from "../logger.js";
import type { Application, ApplicationSnapshot } from "../models/index.js";
import type { SnapshotRepository } from "../database/repositories.js";
import type { WaterlooWorksProvider } from "../providers/WaterlooWorksProvider.js";

export class SnapshotService {
  constructor(private provider: WaterlooWorksProvider, private repo: SnapshotRepository, private log: Logger) {}

  fromApplication(app: Application): ApplicationSnapshot {
    return {
      id: newId("snap"),
      applicationId: app.id,
      jobId: app.jobId,
      job: app.job,
      status: app.status,
      resume: app.resume,
      documents: app.documents.map((d) => ({ ...d })),
      questions: app.questions.map((q) => ({ ...q })),
      capturedAt: new Date(),
    };
  }

  /** Capture and persist. Returns only after the row is committed (spec section 11). */
  async snapshotApplication(applicationId: string): Promise<ApplicationSnapshot> {
    const app = await this.provider.getApplication(applicationId);
    return this.persist(app);
  }

  persist(app: Application): ApplicationSnapshot {
    const snap = this.fromApplication(app);
    this.repo.insert(snap);
    if (!this.repo.get(snap.id)) throw new Error(`Snapshot ${snap.id} was not persisted`);
    logEvent(this.log, "SNAPSHOT_CREATED", { snapshotId: snap.id, applicationId: app.id, jobId: app.jobId });
    return snap;
  }
}
