import { prisma } from '../db/prisma.js';
import { paginate, type Paginated } from '../dto/pagination.js';
import {
  recommendationInclude,
  toAdminRecommendation,
  toOwnerRecommendation,
  toPublicRecommendation,
  type AdminRecommendationDto,
  type OwnerRecommendationDto,
  type PublicRecommendationDto,
} from '../dto/recommendation.js';
import type { Prisma, Recommendation } from '../generated/prisma/client.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { escapeLike } from '../utils/search.js';
import type {
  AdminListRecommendationsQuery,
  ListRecommendationsQuery,
  RecommendationInput,
  UpdateRecommendationInput,
} from '../validation/recommendations.js';
import type { RequestSponsoredInput } from '../validation/sponsoredReview.js';

type Actor = NonNullable<Express.Request['user']>;
type Tx = Prisma.TransactionClient;

const DEFAULT_PAGE_SIZE = 10;
const NOT_FOUND = 'Recommendation not found.';
const CONCURRENT_CHANGE = 'The recommendation was changed by another request. Reload it and try again.';

// Clears the previous review so stale reviewer data never sticks to new content.
const CLEARED_REVIEW = { reviewedByUserId: null, reviewedAt: null, rejectionReason: null } as const;

// Withdrawing the declaration also removes its details (DB CHECK).
const CLEARED_DISCLOSURE = { sponsorName: null, productName: null, sponsorshipType: null, disclosureDetails: null } as const;

// ---------------------------------------------------------------- listing

function buildListArgs(query: ListRecommendationsQuery, baseWhere: Prisma.RecommendationWhereInput) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const sortBy = query.sortBy ?? 'createdAt';
  // Newest first by date; alphabetical by title, unless specified.
  const sortOrder = query.sortOrder ?? (sortBy === 'title' ? 'asc' : 'desc');

  const where: Prisma.RecommendationWhereInput = { ...baseWhere };
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.search) {
    const term = escapeLike(query.search);
    where.OR = [
      { title: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } },
    ];
  }

  return {
    page,
    pageSize,
    where,
    // `id` as a tie-breaker keeps pages stable when sort values are equal.
    orderBy: [{ [sortBy]: sortOrder }, { id: sortOrder }] as Prisma.RecommendationOrderByWithRelationInput[],
  };
}

async function findPage(query: ListRecommendationsQuery, baseWhere: Prisma.RecommendationWhereInput) {
  const { page, pageSize, where, orderBy } = buildListArgs(query, baseWhere);
  const [totalItems, rows] = await prisma.$transaction([
    prisma.recommendation.count({ where }),
    prisma.recommendation.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: recommendationInclude,
    }),
  ]);
  return { rows, page, pageSize, totalItems };
}

/** Public listing: Published only, regardless of whether the category was later disabled. */
export async function listPublished(query: ListRecommendationsQuery): Promise<Paginated<PublicRecommendationDto>> {
  const { rows, page, pageSize, totalItems } = await findPage(query, { status: 'Published' });
  return paginate(rows.map(toPublicRecommendation), page, pageSize, totalItems);
}

/** The caller's own recommendations in every status, including Removed. */
export async function listMine(actor: Actor, query: ListRecommendationsQuery): Promise<Paginated<OwnerRecommendationDto>> {
  const { rows, page, pageSize, totalItems } = await findPage(query, { createdByUserId: actor.id });
  return paginate(rows.map(toOwnerRecommendation), page, pageSize, totalItems);
}

type RecommendationRow = Awaited<ReturnType<typeof findPage>>['rows'][number];

/**
 * Adds the reviewer's display name to each row. Loaded in one separate query
 * (not as a second users join inside a transaction, which makes Prisma's pg
 * adapter issue overlapping queries on one connection — deprecated in pg 9).
 */
export async function withReviewers(rows: RecommendationRow[]): Promise<AdminRecommendationDto[]> {
  const reviewerIds = [...new Set(rows.flatMap((r) => (r.reviewedByUserId ? [r.reviewedByUserId] : [])))];
  const reviewers = reviewerIds.length
    ? await prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, fullName: true } })
    : [];
  const byId = new Map(reviewers.map((u) => [u.id, u]));
  return rows.map((r) =>
    toAdminRecommendation({ ...r, reviewedBy: r.reviewedByUserId ? (byId.get(r.reviewedByUserId) ?? null) : null }),
  );
}

/**
 * Admin listing across all users, in every status (including Rejected and
 * Removed) unless `status` is given. Read-only: never restores or changes a row.
 */
export async function listAll(query: AdminListRecommendationsQuery): Promise<Paginated<AdminRecommendationDto>> {
  const { rows, page, pageSize, totalItems } = await findPage(query, query.status ? { status: query.status } : {});
  return paginate(await withReviewers(rows), page, pageSize, totalItems);
}

export async function getPublished(id: number): Promise<PublicRecommendationDto> {
  const rec = await prisma.recommendation.findFirst({
    where: { id, status: 'Published' },
    include: recommendationInclude,
  });
  if (!rec) throw AppError.notFound(NOT_FOUND);
  return toPublicRecommendation(rec);
}

// ---------------------------------------------------------------- helpers

async function assertCategoryAssignable(tx: Tx, categoryId: number) {
  const category = await tx.category.findUnique({ where: { id: categoryId }, select: { isActive: true } });
  if (!category?.isActive) {
    throw AppError.badRequest('The selected category does not exist or is disabled.', [
      { path: 'categoryId', message: 'Category must exist and be active.' },
    ]);
  }
}

/**
 * Loads a recommendation the actor may modify. Removed ones count as deleted (404).
 * Someone else's: 403 if it is public, 404 if private (its existence is not revealed).
 */
async function loadForChange(tx: Tx, actor: Actor, id: number, options: { ownerOnly: boolean }) {
  const rec = await tx.recommendation.findUnique({ where: { id } });
  if (!rec || rec.status === 'Removed') throw AppError.notFound(NOT_FOUND);

  const isOwner = rec.createdByUserId === actor.id;
  const allowed = isOwner || (!options.ownerOnly && actor.role === 'Admin');
  if (!allowed) {
    if (rec.status === 'Published') throw AppError.forbidden('You can only change your own recommendations.');
    throw AppError.notFound(NOT_FOUND);
  }
  return { rec, isOwner };
}

/**
 * Applies `data` only if the row is unchanged since it was read (same status
 * and updatedAt), so concurrent requests cannot both act on a stale state.
 */
async function applyIfUnchanged(tx: Tx, rec: Recommendation, data: Prisma.RecommendationUncheckedUpdateManyInput) {
  const { count } = await tx.recommendation.updateMany({
    where: { id: rec.id, status: rec.status, updatedAt: rec.updatedAt },
    data,
  });
  if (count === 0) throw AppError.conflict(CONCURRENT_CHANGE);
  return tx.recommendation.findUniqueOrThrow({ where: { id: rec.id }, include: recommendationInclude });
}

/** Called only after the transaction commits, so the log never records a rolled-back change. */
function logAdminAction(actor: Actor, isOwner: boolean, action: string, rec: Recommendation, extra: Record<string, string> = {}) {
  if (isOwner) return;
  logger.info('recommendation.admin_action', {
    action,
    adminUserId: actor.id,
    recommendationId: rec.id,
    ownerUserId: rec.createdByUserId,
    previousStatus: rec.status,
    ...extra,
  });
}

// ---------------------------------------------------------------- commands

export async function create(actor: Actor, input: RecommendationInput): Promise<OwnerRecommendationDto> {
  const rec = await prisma.$transaction(async (tx) => {
    await assertCategoryAssignable(tx, input.categoryId);
    return tx.recommendation.create({
      data: {
        title: input.title,
        description: input.description,
        categoryId: input.categoryId,
        url: input.url ?? null,
        imageUrl: input.imageUrl ?? null,
        // Server-controlled: the author is the caller; new recommendations are regular and public.
        createdByUserId: actor.id,
        status: 'Published',
        isSponsored: false,
        declaresSponsored: false,
      },
      include: recommendationInclude,
    });
  });
  return toOwnerRecommendation(rec);
}

/**
 * Status rules on edit:
 * - publishAsRegular (Rejected only): Published, not sponsored, declaration and its details withdrawn, review cleared.
 * - Approved sponsored (owner or admin edit): back to PendingSponsoredApproval, approval and review cleared.
 * - Anything else keeps its status.
 */
export async function update(actor: Actor, id: number, input: UpdateRecommendationInput): Promise<OwnerRecommendationDto> {
  const { updated, existing, isOwner, transition } = await prisma.$transaction(async (tx) => {
    const { rec: existing, isOwner } = await loadForChange(tx, actor, id, { ownerOnly: false });

    if (input.categoryId !== existing.categoryId) {
      await assertCategoryAssignable(tx, input.categoryId);
    }

    let workflow: Prisma.RecommendationUncheckedUpdateManyInput = {};
    let transition = 'edited';
    if (input.publishAsRegular) {
      if (existing.status !== 'Rejected') {
        throw AppError.invalidState('Only a rejected sponsored recommendation can be published as a regular recommendation.');
      }
      workflow = { status: 'Published', isSponsored: false, declaresSponsored: false, ...CLEARED_DISCLOSURE, ...CLEARED_REVIEW };
      transition = 'published_as_regular';
    } else if (existing.status === 'Published' && existing.isSponsored) {
      workflow = { status: 'PendingSponsoredApproval', isSponsored: false, ...CLEARED_REVIEW };
      transition = 'sponsored_approval_revoked';
    }

    const updated = await applyIfUnchanged(tx, existing, {
      title: input.title,
      description: input.description,
      categoryId: input.categoryId,
      // PUT replaces the resource: omitted optional URLs are cleared.
      url: input.url ?? null,
      imageUrl: input.imageUrl ?? null,
      ...workflow,
    });
    return { updated, existing, isOwner, transition };
  });
  logAdminAction(actor, isOwner, 'update', existing, { transition, newStatus: updated.status });
  return toOwnerRecommendation(updated);
}

/** Soft delete: status becomes Removed; the row and its audit fields are kept. */
export async function remove(actor: Actor, id: number): Promise<void> {
  const { rec, isOwner } = await prisma.$transaction(async (tx) => {
    const loaded = await loadForChange(tx, actor, id, { ownerOnly: false });
    await applyIfUnchanged(tx, loaded.rec, { status: 'Removed' });
    return loaded;
  });
  logAdminAction(actor, isOwner, 'remove', rec);
}

/**
 * Owner-only. Stores the disclosure and moves the recommendation to PendingSponsoredApproval.
 * - From a regular Published recommendation or from Rejected: a new request, previous review cleared.
 * - From PendingSponsoredApproval: replaces the disclosure of the pending request. This changes
 *   updatedAt, so an admin review of the previous version is refused as stale (409).
 * - Already approved: 409 (edit it first, which returns it to pending).
 */
export async function requestSponsored(actor: Actor, id: number, input: RequestSponsoredInput): Promise<OwnerRecommendationDto> {
  const rec = await prisma.$transaction(async (tx) => {
    const { rec: existing } = await loadForChange(tx, actor, id, { ownerOnly: true });

    if (existing.status === 'Published' && existing.isSponsored) {
      throw AppError.invalidState('This recommendation is already an approved sponsored recommendation.');
    }

    return applyIfUnchanged(tx, existing, {
      status: 'PendingSponsoredApproval',
      isSponsored: false,
      declaresSponsored: true,
      sponsorName: input.sponsorName,
      productName: input.productName,
      sponsorshipType: input.sponsorshipType,
      disclosureDetails: input.disclosureDetails ?? null,
      ...CLEARED_REVIEW,
    });
  });
  return toOwnerRecommendation(rec);
}
