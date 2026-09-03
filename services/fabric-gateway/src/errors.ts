export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'SCHEMA_INVALID'
  | 'RESOURCE_NOT_FOUND'
  | 'STATE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'LEDGER_UNAVAILABLE'
  | 'LEDGER_COMMIT_TIMEOUT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

const statusByCode: Readonly<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SCHEMA_INVALID: 400,
  RESOURCE_NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  LEDGER_UNAVAILABLE: 503,
  LEDGER_COMMIT_TIMEOUT: 503,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

const messageByCode: Readonly<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'The authenticated actor is not authorized.',
  SCHEMA_INVALID: 'The request is invalid.',
  RESOURCE_NOT_FOUND: 'The requested evidence was not found.',
  STATE_CONFLICT: 'The evidence state conflicts with this operation.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key was reused for a different command.',
  LEDGER_UNAVAILABLE: 'The Fabric ledger is unavailable.',
  LEDGER_COMMIT_TIMEOUT: 'The Fabric commit result is temporarily ambiguous.',
  RATE_LIMITED: 'Too many requests.',
  INTERNAL_ERROR: 'An internal error occurred.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  public constructor(code: ErrorCode, options?: ErrorOptions) {
    super(messageByCode[code], options);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusByCode[code];
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return '';

  const messages = [`${error.name}: ${error.message}`];
  const details = (error as Error & { details?: unknown }).details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (typeof detail === 'object' && detail !== null && 'message' in detail) {
        const message = (detail as { message?: unknown }).message;
        if (typeof message === 'string') messages.push(message);
      }
    }
  }

  return messages.join('\n').toLowerCase();
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const text = errorText(error);
  if (text.includes('not found')) return new AppError('RESOURCE_NOT_FOUND');
  if (text.includes('deadline') || text.includes('timeout')) return new AppError('LEDGER_COMMIT_TIMEOUT');
  if (text.includes('authorize') || text.includes('access denied')) return new AppError('FORBIDDEN');
  if (text.includes('conflict') || text.includes('already decided') || text.includes('new version')) {
    return new AppError('STATE_CONFLICT');
  }
  return new AppError('LEDGER_UNAVAILABLE', { cause: error });
}
