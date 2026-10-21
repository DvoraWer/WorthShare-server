import type { RequestHandler } from 'express';
import { prisma } from '../db/prisma.js';
import { safeUserSelect, toSafeUser } from '../dto/user.js';
import type { Role } from '../generated/prisma/client.js';
import { AppError } from '../utils/AppError.js';
import { verifyAccessToken } from '../utils/jwt.js';

const BEARER = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const INVALID_TOKEN = 'Invalid or expired access token.';

/**
 * Requires a valid Bearer token. The user is reloaded from the database on
 * every request, so deactivation and role changes take effect immediately.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization');
  if (!header) throw AppError.unauthorized('Authentication is required.');

  const token = BEARER.exec(header.trim())?.[1];
  if (!token) throw AppError.unauthorized(INVALID_TOKEN);

  const userId = await verifyAccessToken(token);
  if (!userId) throw AppError.unauthorized(INVALID_TOKEN);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...safeUserSelect, isActive: true },
  });
  if (!user || !user.isActive) throw AppError.unauthorized(INVALID_TOKEN);

  req.user = toSafeUser(user);
  next();
};

/** Use after `authenticate`. Responds 403 when the user's role is not allowed. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw AppError.unauthorized('Authentication is required.');
    if (!roles.includes(req.user.role)) throw AppError.forbidden();
    next();
  };
}
