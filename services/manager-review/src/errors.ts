export class ReviewServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewServiceError";
    this.status = status;
    this.code = code;
  }
}

export function corruptStore(message: string): ReviewServiceError {
  return new ReviewServiceError(500, "REVIEW_STORE_CORRUPT", `Manager review store is corrupt: ${message}`);
}
