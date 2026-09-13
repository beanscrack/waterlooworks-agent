import pino from "pino";

const REDACT_PATHS = [
  "password",
  "*.password",
  "cookie",
  "cookies",
  "*.cookies",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "token",
  "*.token",
  "mfa",
  "*.mfa",
];

export interface LoggerOptions {
  level?: string;
  /** Write to stderr (required for MCP stdio servers, where stdout is the protocol channel). */
  stderr?: boolean;
}

export function createLogger(opts: LoggerOptions = {}) {
  return pino(
    {
      level: opts.level ?? process.env.WW_LOG_LEVEL ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination(opts.stderr === false ? 1 : 2),
  );
}

export type Logger = ReturnType<typeof createLogger>;

export type EventName =
  | "PLAN_CREATED"
  | "SNAPSHOT_CREATED"
  | "APPLICATION_CANCELLED"
  | "APPLICATION_SUBMITTED"
  | "APPLICATION_VERIFIED"
  | "VERIFICATION_FAILED"
  | "OPERATION_FAILED"
  | "RECOVERY_STARTED"
  | "RECOVERY_COMPLETED"
  | "RESUME_UPLOADED"
  | "DOCUMENT_UPLOADED"
  | "DOCUMENT_ARCHIVED"
  | "DOCUMENT_DEFAULT_CHANGED";

export function logEvent(log: Logger, event: EventName, data: Record<string, unknown>) {
  log.info({ event, ...data }, event);
}
