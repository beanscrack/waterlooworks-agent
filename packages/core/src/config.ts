import path from "node:path";
import fs from "node:fs";

export interface WWConfig {
  rootDir: string;
  dbPath: string;
  browserProfileDir: string;
  baseUrl: string;
  headless: boolean;
  /** Use the in-memory fake provider instead of Playwright (for tests / demos). */
  fake: boolean;
  logLevel: string;
}

export function findRootDir(): string {
  if (process.env.WW_ROOT) return process.env.WW_ROOT;
  // Walk up from cwd looking for package.json with name waterlooworks-agent, else cwd.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) {
      try {
        const j = JSON.parse(fs.readFileSync(pj, "utf8"));
        if (j.name === "waterlooworks-agent") return dir;
      } catch {
        /* ignore */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function loadConfig(overrides: Partial<WWConfig> = {}): WWConfig {
  const rootDir = overrides.rootDir ?? findRootDir();
  const cfg: WWConfig = {
    rootDir,
    dbPath: process.env.WW_DB_PATH ?? path.join(rootDir, "data", "ww.db"),
    browserProfileDir: process.env.WW_PROFILE_DIR ?? path.join(rootDir, "browser-profile"),
    baseUrl: process.env.WW_BASE_URL ?? "https://waterlooworks.uwaterloo.ca",
    headless: process.env.WW_HEADLESS === "1",
    fake: process.env.WW_FAKE === "1",
    logLevel: process.env.WW_LOG_LEVEL ?? "info",
    ...overrides,
  };
  fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  return cfg;
}
