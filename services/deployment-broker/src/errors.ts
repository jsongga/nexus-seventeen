export class BrokerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export function storeCorrupt(message: string): Error {
  return new Error(`DEPLOYMENT_GRANT_STORE_CORRUPT: ${message}`);
}
