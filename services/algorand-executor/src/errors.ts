export class ExecutorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ExecutorError";
  }
}

export const conflict = (message: string): ExecutorError =>
  new ExecutorError("STATE_CONFLICT", message, 409);

export const notFound = (message: string): ExecutorError =>
  new ExecutorError("RESOURCE_NOT_FOUND", message, 404);

export const unauthorized = (message = "Authentication failed."): ExecutorError =>
  new ExecutorError("UNAUTHORIZED", message, 401);

export const forbidden = (message = "Authorization failed."): ExecutorError =>
  new ExecutorError("FORBIDDEN", message, 403);

export const invalid = (message: string): ExecutorError =>
  new ExecutorError("SCHEMA_INVALID", message, 422);

export const unavailable = (message: string): ExecutorError =>
  new ExecutorError("DEPENDENCY_UNAVAILABLE", message, 503);
