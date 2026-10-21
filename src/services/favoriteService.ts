import { prisma } from '../db/prisma.js';
import { paginate, type Paginated } from '../dto/pagination.js';
import { recommendationInclude, toPublicRecommendation, type PublicRecommendationDto } from '../dto/recommendation.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../utils/AppError.js';
import type { ListFavoritesQuery } from '../validation/favorites.js';

type Actor = NonNullable<Express.Request['user']>;

const DEFAULT_PAGE_SIZE = 10;

// Favorites are listed only while their recommendation is public, so a
// favorite never exposes a pending, rejected or removed recommendation.
const visibleFavorites = (actor: Actor): Prisma.FavoriteWhereInput => ({
  userId: actor.id,
  recommendation: { status: 'Published' },
});

/** The caller's saved recommendations, most recently saved first. */
export async function listFavorites(actor: Actor, query: ListFavoritesQuery): Promise<Paginated<PublicRecommendationDto>> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const where = visibleFavorites(actor);

  const [totalItems, rows] = await prisma.$transaction([
    prisma.favorite.count({ where }),
    prisma.favorite.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { recommendationId: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { recommendation: { include: recommendationInclude } },
    }),
  ]);
  return paginate(rows.map((f) => toPublicRecommendation(f.recommendation)), page, pageSize, totalItems);
}

/** Ids of the caller's visible favorites, so lists can mark which items are saved. */
export async function listFavoriteIds(actor: Actor): Promise<{ ids: number[] }> {
  const rows = await prisma.favorite.findMany({
    where: visibleFavorites(actor),
    select: { recommendationId: true },
    orderBy: { recommendationId: 'asc' },
  });
  return { ids: rows.map((r) => r.recommendationId) };
}

/** Saves a published recommendation. Saving it again changes nothing. */
export async function addFavorite(actor: Actor, recommendationId: number): Promise<void> {
  const rec = await prisma.recommendation.findFirst({
    where: { id: recommendationId, status: 'Published' },
    select: { id: true },
  });
  if (!rec) throw AppError.notFound('Recommendation not found.');

  // Idempotent and safe under concurrent requests: an existing row is skipped.
  await prisma.favorite.createMany({
    data: [{ userId: actor.id, recommendationId }],
    skipDuplicates: true,
  });
}

/** Removes a saved recommendation. Removing one that is not saved changes nothing. */
export async function removeFavorite(actor: Actor, recommendationId: number): Promise<void> {
  await prisma.favorite.deleteMany({ where: { userId: actor.id, recommendationId } });
}
