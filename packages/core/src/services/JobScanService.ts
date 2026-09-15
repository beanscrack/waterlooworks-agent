import type { Logger } from "../logger.js";
import { logEvent } from "../logger.js";
import type { JobPosting } from "../models/index.js";
import type { JobPostingRepository } from "../database/repositories.js";
import type { ScanJobsOptions, WaterlooWorksProvider } from "../providers/WaterlooWorksProvider.js";

export interface ScanOptions {
  myProgramOnly?: boolean;
  maxJobs?: number;
  /** Re-read postings already in the database instead of skipping them. */
  refresh?: boolean;
  onProgress?: (scraped: number, seen: number, total?: number) => void;
}

export interface ScanResult {
  scope: string;
  scraped: number;
  cached: number;
  failed: string[];
  postings: JobPosting[];
}

export const scopeOf = (myProgramOnly: boolean | undefined) => (myProgramOnly ? "my-program" : "all");

/**
 * Reads job postings into SQLite. Each posting is committed as it is read, so an interrupted scan
 * (session timeout, closed browser) resumes where it stopped instead of starting over.
 */
export class JobScanService {
  constructor(
    private provider: WaterlooWorksProvider,
    private repo: JobPostingRepository,
    private log: Logger,
  ) {}

  async scan(opts: ScanOptions = {}): Promise<ScanResult> {
    const scope = scopeOf(opts.myProgramOnly);
    const known = opts.refresh ? new Set<string>() : this.repo.ids();
    const failed: string[] = [];
    let scraped = 0;

    const providerOpts: ScanJobsOptions = {
      myProgramOnly: opts.myProgramOnly,
      maxJobs: opts.maxJobs,
      skip: (jobId) => known.has(jobId),
      onPosting: (p) => {
        this.repo.put(p, scope);
        scraped++;
      },
      onError: (jobId, err) => {
        failed.push(jobId);
        this.log.warn({ jobId, err: String(err) }, "job posting skipped");
      },
      onProgress: (seen, total) => opts.onProgress?.(scraped, seen, total),
    };

    await this.provider.scanJobs(providerOpts);
    logEvent(this.log, "JOBS_SCANNED", { scope, scraped, failed: failed.length });
    return { scope, scraped, cached: known.size, failed, postings: this.repo.list(scope) };
  }

  list(scope?: string): JobPosting[] {
    return this.repo.list(scope);
  }
}
