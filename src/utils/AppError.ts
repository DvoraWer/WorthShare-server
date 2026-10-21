export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE_TRANSITION'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown[],
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown[]) {
    return new AppError(400, 'VALIDATION_ERROR', message, details);
  }

  static unauthorized(message = 'Authentication is required.') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You do not have permission to perform this action.') {
    return new AppError(403, 'FORBIDDEN', message);
  }

  static notFound(message = 'The requested resource was not found.') {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string) {
    return new AppError(409, 'CONFLICT', message);
  }

  /** 409 for an action that is not allowed in the resource's current state. */
  static invalidState(message: string) {
    return new AppError(409, 'INVALID_STATE_TRANSITION', message);
  }
}
