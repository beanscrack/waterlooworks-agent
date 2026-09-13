import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS resumes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    sha256 TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS application_snapshots (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_app ON application_snapshots(application_id, created_at);`,
  `CREATE TABLE IF NOT EXISTS replacement_plans (
    id TEXT PRIMARY KEY,
    old_resume_id TEXT NOT NULL,
    new_resume_id TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    executed_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    plan_id TEXT,
    application_id TEXT NOT NULL,
    new_application_id TEXT,
    job_id TEXT,
    snapshot_id TEXT,
    operation_type TEXT NOT NULL,
    state TEXT NOT NULL,
    old_resume_id TEXT,
    new_resume_id TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_operations_state ON operations(state);`,
  `CREATE TABLE IF NOT EXISTS job_postings (
    job_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    posting_json TEXT NOT NULL,
    scraped_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_job_postings_scope ON job_postings(scope);`,
  `CREATE TABLE IF NOT EXISTS package_analyses (
    package_doc_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
];

export function openDatabase(dbPath: string): DB {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const m of MIGRATIONS) db.exec(m);
  return db;
}
