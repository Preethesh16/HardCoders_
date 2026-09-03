/** Errors that carry the exact HTTP status and stable code a client sees. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, detail?: Record<string, unknown>): ApiError =>
  new ApiError('BAD_REQUEST', message, 400, detail);
export const unauthorized = (message = 'Authentication is required.'): ApiError =>
  new ApiError('UNAUTHORIZED', message, 401);
export const forbidden = (message = 'You are not authorized to perform this action.'): ApiError =>
  new ApiError('FORBIDDEN', message, 403);
export const notFound = (message: string): ApiError => new ApiError('NOT_FOUND', message, 404);
export const conflict = (message: string, detail?: Record<string, unknown>): ApiError =>
  new ApiError('CONFLICT', message, 409, detail);
export const unprocessable = (message: string, detail?: Record<string, unknown>): ApiError =>
  new ApiError('UNPROCESSABLE', message, 422, detail);
export const unavailable = (message: string): ApiError =>
  new ApiError('DEPENDENCY_UNAVAILABLE', message, 503);
