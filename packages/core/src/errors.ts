export class WWError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class NotAuthenticatedError extends WWError {
  constructor(msg = "Not authenticated with WaterlooWorks. Run `ww login`.") {
    super(msg, "NOT_AUTHENTICATED");
  }
}
export class NotFoundError extends WWError {
  constructor(what: string, id: string) {
    super(`${what} not found: ${id}`, "NOT_FOUND");
  }
}
export class IneligibleError extends WWError {
  constructor(msg: string, public readonly reason: string) {
    super(msg, "INELIGIBLE");
  }
}
export class UnknownStateError extends WWError {
  constructor(msg: string) {
    super(msg, "UNKNOWN_STATE");
  }
}
export class VerificationError extends WWError {
  constructor(msg: string) {
    super(msg, "FAILED_VERIFICATION");
  }
}
export class SelectorError extends WWError {
  /** Raised by the page-object layer when the live DOM does not match expectations. */
  constructor(msg: string) {
    super(msg, "SELECTOR_MISMATCH");
  }
}
