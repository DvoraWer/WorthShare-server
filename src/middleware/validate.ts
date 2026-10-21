import type { RequestHandler } from 'express';
import type { z } from 'zod';

// Zod errors thrown here are turned into 400 VALIDATION_ERROR by the error handler.

/** Validates and replaces `req.body` with the parsed value (unknown keys are stripped). */
export function validateBody(schema: z.ZodType): RequestHandler {
  return (req, _res, next) => {
    req.body = schema.parse(req.body ?? {});
    next();
  };
}

/** Validates `req.query`; the parsed value is stored in `res.locals.query` (req.query is read-only in Express 5). */
export function validateQuery(schema: z.ZodType): RequestHandler {
  return (req, res, next) => {
    res.locals.query = schema.parse(req.query);
    next();
  };
}

/** Validates `req.params`; the parsed value is stored in `res.locals.params`. */
export function validateParams(schema: z.ZodType): RequestHandler {
  return (req, res, next) => {
    res.locals.params = schema.parse(req.params);
    next();
  };
}
