import { prisma } from '../db/prisma.js';
import { paginate, type Paginated } from '../dto/pagination.js';
import {
  recommendationInclude,
  toAdminRecommendation,
  type AdminRecommendationDto,
} from '../dto/recommendation.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import type {
  ApproveSponsoredInput,
  ListPendingQuery,
  RejectSponsoredInput,
} from '../validation/sponsoredReview.js';
import { withReviewers } from './recommendationService.js';

type Actor = NonNullable<Express.Request['user']>;
type Tx = Prisma.TransactionClient;

const DEFAULT_PAGE_SIZE = 10;

/** All pending requests from every user, oldest first (a review queue). */
export async function listPending(query: ListPendingQuery): Promise<Paginated<AdminRecommendationDto>> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const where: Prisma.RecommendationWhereInput = { status: 'PendingSponsoredApproval' };

  const [totalItems, rows] = await prisma.$transaction([
    prisma.recommendation.count({ where }),
    prisma.recommendation.findMany({
      where,
      // updatedAt changes when sponsorship is requested or the request is edited.
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: recommendationInclude,
    }),
  ]);
  return paginate(await withReviewers(rows), page, pageSize, totalItems);
}

type Decision = 'approve' | 'reject';

const STALE_REVIEW = 'The recommendation was changed after you loaded it. Reload it and review the current version.';

/** Explains why a review cannot be applied to the current row (404 / 409). */
async function refuse(tx: Tx, id: number, decision: Decision, expectedUpdatedAt: Date): Promise<never> {
  const current = await tx.recommendation.findUnique({ where: { id }, select: { status: true, updatedAt: true } });
  if (!current || current.status === 'Removed') throw AppError.notFound('Recommendation not found.');
  if (current.status !== 'PendingSponsoredApproval') {
    throw AppError.invalidState(
      `Only recommendations pending sponsored approval can be ${decision === 'approve' ? 'approved' : 'rejected'}. Current status: ${current.status}.`,
    );
  }
  if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw AppError.conflict(STALE_REVIEW);
  // Pending and unchanged, yet the conditional update matched nothing: it was
  // changed and changed back concurrently. Treat as stale.
  throw AppError.conflict(STALE_REVIEW);
}

/**
 * Applies a review atomically, only to the exact version the admin reviewed:
 * 1. the recommendation must be pending and have `updatedAt === expectedUpdatedAt`;
 * 2. approval only: its category row is locked FOR SHARE and must be active.
 *    The lock makes a concurrent deactivation (an UPDATE of that row) wait
 *    until this transaction commits; a deactivation that committed first is
 *    seen here and refuses the approval. So the check cannot go stale before
 *    the write;
 * 3. a single conditional UPDATE re-checks status, version and category, so a
 *    concurrent second review (or an edit) cannot also apply.
 * Any refusal rolls back the whole transaction: nothing is partially updated.
 */
async function review(
  actor: Actor,
  id: number,
  decision: Decision,
  expectedUpdatedAt: Date,
  data: Prisma.RecommendationUncheckedUpdateManyInput,
): Promise<AdminRecommendationDto> {
  const { updated, ownerUserId } = await prisma.$transaction(async (tx) => {
    const current = await tx.recommendation.findUnique({
      where: { id },
      select: { status: true, updatedAt: true, categoryId: true },
    });
    if (
      !current ||
      current.status !== 'PendingSponsoredApproval' ||
      current.updatedAt.getTime() !== expectedUpdatedAt.getTime()
    ) {
      await refuse(tx, id, decision, expectedUpdatedAt);
    }
    const categoryId = current!.categoryId;

    if (decision === 'approve') {
      const [category] = await tx.$queryRaw<Array<{ isActive: boolean }>>`
        SELECT "isActive" FROM "categories" WHERE "id" = ${categoryId} FOR SHARE`;
      if (!category?.isActive) {
        throw AppError.conflict(
          "This recommendation's category is disabled, so it cannot be approved as sponsored. Re-enable the category, reject the request, or wait for the owner to move it to an active category.",
        );
      }
    }

    const { count } = await tx.recommendation.updateMany({
      where: { id, status: 'PendingSponsoredApproval', updatedAt: expectedUpdatedAt, categoryId },
      data,
    });
    if (count === 0) await refuse(tx, id, decision, expectedUpdatedAt);

    // The reviewer is always the acting admin, so it is not re-loaded from the
    // database (avoids a second users join inside the transaction).
    const row = await tx.recommendation.findUniqueOrThrow({ where: { id }, include: recommendationInclude });
    return { updated: { ...row, reviewedBy: { id: actor.id, fullName: actor.fullName } }, ownerUserId: row.createdByUserId };
  });

  // Logged after commit, so a rolled-back review is never recorded as done.
  logger.info('recommendation.sponsored_review', {
    decision,
    recommendationId: id,
    adminUserId: actor.id,
    ownerUserId,
    selfReview: ownerUserId === actor.id,
    newStatus: updated.status,
    hasRejectionReason: decision === 'reject' ? updated.rejectionReason !== null : undefined,
  });
  return toAdminRecommendation(updated);
}

export function approve(actor: Actor, id: number, input: ApproveSponsoredInput) {
  return review(actor, id, 'approve', input.expectedUpdatedAt, {
    status: 'Published',
    isSponsored: true,
    // Pending requests are always declared; keeping it explicit satisfies the
    // published-disclosure constraint (declaresSponsored = isSponsored).
    declaresSponsored: true,
    reviewedByUserId: actor.id,
    reviewedAt: new Date(),
    rejectionReason: null,
  });
}

export function reject(actor: Actor, id: number, input: RejectSponsoredInput) {
  return review(actor, id, 'reject', input.expectedUpdatedAt, {
    status: 'Rejected',
    isSponsored: false,
    declaresSponsored: true,
    reviewedByUserId: actor.id,
    reviewedAt: new Date(),
    rejectionReason: input.rejectionReason ?? null,
  });
}
