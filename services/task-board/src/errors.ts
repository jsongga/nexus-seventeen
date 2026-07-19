export class TaskBoardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskBoardError";
  }
}

export function conflict(code: string, message: string): TaskBoardError {
  return new TaskBoardError(409, code, message);
}
