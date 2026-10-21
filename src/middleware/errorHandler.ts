import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/AppError.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown[];
  };
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(AppError.notFound('Route not found.'));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let status = 500;
  let body: ErrorBody = {
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  };

  if (err instanceof AppError) {
    status = err.statusCode;
    body = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
  } else if (err instanceof ZodError) {
    status = 400;
    body = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request contains invalid data.',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  } else if (isBodyParserError(err)) {
    // Malformed JSON or oversized body from express.json().
    status = err.status;
    body = {
      error: {
        code: 'VALIDATION_ERROR',
        message:
          err.type === 'entity.parse.failed'
            ? 'The request body is not valid JSON.'
            : 'The request body could not be processed.',
      },
    };
  } else {
    // Never send stack traces or internals to the client.
    console.error('Unhandled error:', err);
  }

  res.status(status).json(body);
};

function isBodyParserError(err: unknown): err is { status: number; type: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof err.type === 'string' &&
    'status' in err &&
    typeof err.status === 'number' &&
    err.status >= 400 &&
    err.status < 500
  );
}
