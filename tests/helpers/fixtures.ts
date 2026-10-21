import type { Prisma, RecommendationStatus, Role } from '../../src/generated/prisma/client.js';
import { signAccessToken } from '../../src/utils/jwt.js';
import { hashPassword } from '../../src/utils/password.js';
import type { createTestPrisma } from './db.js';

type TestPrisma = ReturnType<typeof createTestPrisma>;

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function createUser(
  prisma: TestPrisma,
  options: { fullName?: string; email?: string; role?: Role; isActive?: boolean } = {},
) {
  return prisma.user.create({
    data: {
      fullName: options.fullName ?? 'Test User',
      email: options.email ?? `user-${unique()}@example.com`,
      passwordHash: await hashPassword('test-password'),
      role: options.role ?? 'User',
      isActive: options.isActive ?? true,
    },
  });
}

export async function authHeader(user: { id: number }) {
  return { Authorization: `Bearer ${await signAccessToken(user.id)}` };
}

export function createCategory(prisma: TestPrisma, options: { name?: string; isActive?: boolean } = {}) {
  return prisma.category.create({
    data: { name: options.name ?? `Category ${unique()}`, isActive: options.isActive ?? true },
  });
}

/** Disclosure stored on every declared-sponsored fixture (the DB requires it). */
export const FIXTURE_DISCLOSURE = {
  sponsorName: 'Acme Tools',
  productName: 'Acme Drill X',
  sponsorshipType: 'FreeProduct',
  disclosureDetails: 'Received for free to review.',
} as const;

type RecState = 'published' | 'sponsored' | 'pending' | 'rejected' | 'removed';

const STATES: Record<RecState, { status: RecommendationStatus; isSponsored: boolean; declaresSponsored: boolean; reviewed: boolean }> = {
  published: { status: 'Published', isSponsored: false, declaresSponsored: false, reviewed: false },
  sponsored: { status: 'Published', isSponsored: true, declaresSponsored: true, reviewed: true },
  pending: { status: 'PendingSponsoredApproval', isSponsored: false, declaresSponsored: true, reviewed: false },
  rejected: { status: 'Rejected', isSponsored: false, declaresSponsored: true, reviewed: true },
  removed: { status: 'Removed', isSponsored: false, declaresSponsored: false, reviewed: false },
};

export async function createRecommendation(
  prisma: TestPrisma,
  options: {
    author: { id: number };
    category: { id: number };
    state?: RecState;
    reviewer?: { id: number };
    title?: string;
    description?: string;
    url?: string | null;
    createdAt?: Date;
  },
) {
  const state = STATES[options.state ?? 'published'];
  const data: Prisma.RecommendationUncheckedCreateInput = {
    title: options.title ?? `Recommendation ${unique()}`,
    description: options.description ?? 'A useful description.',
    categoryId: options.category.id,
    createdByUserId: options.author.id,
    url: options.url ?? null,
    status: state.status,
    isSponsored: state.isSponsored,
    declaresSponsored: state.declaresSponsored,
    ...(state.declaresSponsored ? FIXTURE_DISCLOSURE : {}),
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
  };
  if (state.reviewed) {
    data.reviewedByUserId = (options.reviewer ?? options.author).id;
    data.reviewedAt = new Date();
    if (state.status === 'Rejected') data.rejectionReason = 'Not suitable as sponsored.';
  }
  return prisma.recommendation.create({ data });
}
