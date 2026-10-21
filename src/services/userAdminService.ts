import { prisma } from '../db/prisma.js';
import { paginate, type Paginated } from '../dto/pagination.js';
import type { Prisma, Role } from '../generated/prisma/client.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { escapeLike } from '../utils/search.js';
import type { ListUsersQuery, RoleInput, StatusInput } from '../validation/admin.js';

type Actor = NonNullable<Express.Request['user']>;

const DEFAULT_PAGE_SIZE = 10;

/**
 * Transaction-scoped PostgreSQL advisory lock key for role/status changes.
 * Taking it serializes every such change, so two admins demoting or
 * deactivating each other at the same moment cannot both pass the
 * last-active-admin check. Released automatically at commit/rollback.
 */
const USER_ADMIN_LOCK_KEY = 727_274_001;

// Never select passwordHash.
const adminUserSelect = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.UserSelect;

type AdminUserRecord = Prisma.UserGetPayload<{ select: typeof adminUserSelect }>;

export interface AdminUserDto {
  id: number;
  fullName: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function toAdminUser(u: AdminUserRecord): AdminUserDto {
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

/** Search by full name or email (case-insensitive, literal), oldest accounts first. */
export async function list(query: ListUsersQuery): Promise<Paginated<AdminUserDto>> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const where: Prisma.UserWhereInput = {};
  if (query.search) {
    const term = escapeLike(query.search);
    where.OR = [
      { fullName: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
    ];
  }

  const [totalItems, rows] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: adminUserSelect,
    }),
  ]);
  return paginate(rows.map(toAdminUser), page, pageSize, totalItems);
}

type Change = { action: 'role_change'; role: Role } | { action: 'status_change'; isActive: boolean };

type Rejection = 'actor_not_active_admin' | 'self_demotion' | 'self_deactivation' | 'last_active_admin';

class SafeguardViolation extends Error {
  constructor(
    readonly reason: Rejection,
    readonly appError: AppError,
  ) {
    super(appError.message);
  }
}

/**
 * Applies a role or status change under the advisory lock:
 * 1. re-checks that the actor is still an active Admin (they may have been
 *    demoted or deactivated by a concurrent request after authenticating);
 * 2. refuses to remove the actor's own active-admin status;
 * 3. refuses to remove the last active Admin.
 * Any refusal rolls back the transaction, so the database is left unchanged.
 */
async function applyChange(actor: Actor, targetId: number, change: Change): Promise<AdminUserDto> {
  const requested = change.action === 'role_change' ? { role: change.role } : { isActive: change.isActive };

  let result: { user: AdminUserRecord; before: AdminUserRecord; changed: boolean };
  try {
    result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_ADMIN_LOCK_KEY}::bigint)`;

      const actorNow = await tx.user.findUnique({ where: { id: actor.id }, select: { role: true, isActive: true } });
      if (actorNow?.role !== 'Admin' || !actorNow.isActive) {
        throw new SafeguardViolation('actor_not_active_admin', AppError.forbidden());
      }

      const target = await tx.user.findUnique({ where: { id: targetId }, select: adminUserSelect });
      if (!target) throw AppError.notFound('User not found.');

      const next = { role: target.role, isActive: target.isActive, ...requested };
      if (next.role === target.role && next.isActive === target.isActive) {
        return { user: target, before: target, changed: false };
      }

      const removesActiveAdmin = target.role === 'Admin' && target.isActive && !(next.role === 'Admin' && next.isActive);
      if (removesActiveAdmin) {
        if (target.id === actor.id) {
          throw change.action === 'role_change'
            ? new SafeguardViolation('self_demotion', AppError.conflict('You cannot demote your own account.'))
            : new SafeguardViolation('self_deactivation', AppError.conflict('You cannot deactivate your own account.'));
        }
        const activeAdmins = await tx.user.count({ where: { role: 'Admin', isActive: true } });
        if (activeAdmins <= 1) {
          throw new SafeguardViolation(
            'last_active_admin',
            AppError.conflict(
              change.action === 'role_change'
                ? 'The last active administrator cannot be demoted.'
                : 'The last active administrator cannot be deactivated.',
            ),
          );
        }
      }

      const user = await tx.user.update({ where: { id: targetId }, data: requested, select: adminUserSelect });
      return { user, before: target, changed: true };
    });
  } catch (error) {
    if (error instanceof SafeguardViolation) {
      logger.info('user.admin_action', {
        action: change.action,
        adminUserId: actor.id,
        targetUserId: targetId,
        outcome: 'rejected',
        reason: error.reason,
        ...(change.action === 'role_change' ? { requestedRole: change.role } : { requestedIsActive: change.isActive }),
      });
      throw error.appError;
    }
    throw error;
  }

  // Logged after commit (spec §4: role and status changes are recorded in server logs).
  logger.info('user.admin_action', {
    action: change.action,
    adminUserId: actor.id,
    targetUserId: targetId,
    outcome: result.changed ? 'changed' : 'unchanged',
    ...(change.action === 'role_change'
      ? { previousRole: result.before.role, role: result.user.role }
      : { previousIsActive: result.before.isActive, isActive: result.user.isActive }),
  });
  return toAdminUser(result.user);
}

export function changeRole(actor: Actor, targetId: number, input: RoleInput) {
  return applyChange(actor, targetId, { action: 'role_change', role: input.role });
}

export function changeStatus(actor: Actor, targetId: number, input: StatusInput) {
  return applyChange(actor, targetId, { action: 'status_change', isActive: input.isActive });
}
