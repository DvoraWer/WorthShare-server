import { prisma } from '../db/prisma.js';
import { paginate, type Paginated } from '../dto/pagination.js';
import { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { escapeLike } from '../utils/search.js';
import type { CategoryInput, ListAdminCategoriesQuery, StatusInput } from '../validation/admin.js';

type Actor = NonNullable<Express.Request['user']>;

const DEFAULT_PAGE_SIZE = 50;
const DUPLICATE_NAME = 'A category with this name already exists.';

const adminCategorySelect = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CategorySelect;

type AdminCategoryRecord = Prisma.CategoryGetPayload<{ select: typeof adminCategorySelect }>;

export interface AdminCategoryDto {
  id: number;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function toAdminCategory(c: AdminCategoryRecord): AdminCategoryDto {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isNotFound(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

function logCategoryAction(actor: Actor, action: string, categoryId: number, extra: Record<string, string | boolean> = {}) {
  logger.info('category.admin_action', { action, adminUserId: actor.id, categoryId, ...extra });
}

/** Active and disabled categories, alphabetical. */
export async function list(query: ListAdminCategoriesQuery): Promise<Paginated<AdminCategoryDto>> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const where: Prisma.CategoryWhereInput = query.search
    ? { name: { contains: escapeLike(query.search), mode: 'insensitive' } }
    : {};

  const [totalItems, rows] = await prisma.$transaction([
    prisma.category.count({ where }),
    prisma.category.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: adminCategorySelect,
    }),
  ]);
  return paginate(rows.map(toAdminCategory), page, pageSize, totalItems);
}

/** New categories are always active; uniqueness is case-insensitive (citext). */
export async function create(actor: Actor, input: CategoryInput): Promise<AdminCategoryDto> {
  try {
    const category = await prisma.category.create({
      data: { name: input.name, description: input.description ?? null },
      select: adminCategorySelect,
    });
    logCategoryAction(actor, 'create', category.id);
    return toAdminCategory(category);
  } catch (error) {
    if (isUniqueViolation(error)) throw AppError.conflict(DUPLICATE_NAME);
    throw error;
  }
}

/** Replaces name and description. Status is changed only via updateStatus. */
export async function update(actor: Actor, id: number, input: CategoryInput): Promise<AdminCategoryDto> {
  try {
    const category = await prisma.category.update({
      where: { id },
      data: { name: input.name, description: input.description ?? null },
      select: adminCategorySelect,
    });
    logCategoryAction(actor, 'update', id);
    return toAdminCategory(category);
  } catch (error) {
    if (isUniqueViolation(error)) throw AppError.conflict(DUPLICATE_NAME);
    if (isNotFound(error)) throw AppError.notFound('Category not found.');
    throw error;
  }
}

/**
 * Enables or disables a category. Disabling never deletes the category or
 * hides recommendations already published in it; it only prevents new
 * assignments (enforced in the recommendation service).
 */
export async function updateStatus(actor: Actor, id: number, input: StatusInput): Promise<AdminCategoryDto> {
  try {
    const before = await prisma.category.findUnique({ where: { id }, select: { isActive: true } });
    if (!before) throw AppError.notFound('Category not found.');
    const category = await prisma.category.update({
      where: { id },
      data: { isActive: input.isActive },
      select: adminCategorySelect,
    });
    logCategoryAction(actor, 'status_change', id, {
      previousIsActive: before.isActive,
      isActive: category.isActive,
      outcome: before.isActive === category.isActive ? 'unchanged' : 'changed',
    });
    return toAdminCategory(category);
  } catch (error) {
    if (isNotFound(error)) throw AppError.notFound('Category not found.');
    throw error;
  }
}
