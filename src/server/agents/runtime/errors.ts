export class AgentProcessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentProcessError";
  }
}
