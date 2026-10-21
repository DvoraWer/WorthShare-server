import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';
import { authHeader, createCategory, createRecommendation, createUser } from './helpers/fixtures.js';

const prisma = createTestPrisma();
const app = createApp();

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const LIST = '/api/admin/recommendations';
const ADMIN_KEYS = [
  'author', 'category', 'createdAt', 'declaresSponsored', 'description', 'disclosure', 'id', 'imageUrl',
  'isSponsored', 'rejectionReason', 'reviewedAt', 'reviewedBy', 'status', 'title', 'updatedAt', 'url',
];

/** Two authors, one recommendation in every status, with distinct creation times. */
async function seedWorld() {
  const alice = await createUser(prisma, { fullName: 'Alice Author', email: 'alice@example.com' });
  const bob = await createUser(prisma, { fullName: 'Bob Other', email: 'bob@example.com' });
  const admin = await createUser(prisma, { fullName: 'Ada Admin', email: 'ada@example.com', role: 'Admin' });
  const cooking = await createCategory(prisma, { name: 'Cooking' });
  const tools = await createCategory(prisma, { name: 'Tools' });
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
  const recs = {
    published: await createRecommendation(prisma, { author: alice, category: cooking, title: 'Alice published', createdAt: t(1) }),
    sponsored: await createRecommendation(prisma, { author: bob, category: tools, state: 'sponsored', reviewer: admin, title: 'Bob sponsored', createdAt: t(2) }),
    pending: await createRecommendation(prisma, { author: alice, category: cooking, state: 'pending', title: 'Alice pending', createdAt: t(3) }),
    rejected: await createRecommendation(prisma, { author: bob, category: cooking, state: 'rejected', reviewer: admin, title: 'Bob rejected', createdAt: t(4) }),
    removed: await createRecommendation(prisma, { author: alice, category: tools, state: 'removed', title: 'Alice removed', createdAt: t(5) }),
  };
  return { alice, bob, admin, cooking, tools, recs, adminAuth: await authHeader(admin) };
}

const ids = (res: request.Response) => res.body.items.map((r: { id: number }) => r.id);

describe('GET /api/admin/recommendations: authorization', () => {
  it('returns 401 without a token and 403 for regular users (even for their own items)', async () => {
    const { alice } = await seedWorld();
    expect((await request(app).get(LIST)).status).toBe(401);
    const res = await request(app).get(LIST).query({ status: 'Removed' }).set(await authHeader(alice));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a demoted (403) or deactivated (401) admin token immediately', async () => {
    const { admin, adminAuth } = await seedWorld();
    const other = await createUser(prisma, { email: 'other@example.com', role: 'Admin' });
    const otherAuth = await authHeader(other);
    await prisma.user.update({ where: { id: other.id }, data: { role: 'User' } });
    expect((await request(app).get(LIST).set(otherAuth)).status).toBe(403);
    await prisma.user.update({ where: { id: admin.id }, data: { isActive: false } });
    expect((await request(app).get(LIST).set(adminAuth)).status).toBe(401);
  });
});

describe('GET /api/admin/recommendations: listing and filters', () => {
  it('without status returns every status from every user, newest first', async () => {
    const { adminAuth, recs } = await seedWorld();
    const res = await request(app).get(LIST).set(adminAuth);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([recs.removed.id, recs.rejected.id, recs.pending.id, recs.sponsored.id, recs.published.id]);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 10, totalItems: 5, totalPages: 1 });
    expect(new Set(res.body.items.map((r: { author: { id: number } }) => r.author.id)).size).toBe(2);
  });

  it.each([
    ['Published', ['sponsored', 'published']],
    ['PendingSponsoredApproval', ['pending']],
    ['Rejected', ['rejected']],
    ['Removed', ['removed']],
  ] as const)('status=%s returns exactly those recommendations', async (status, expected) => {
    const { adminAuth, recs } = await seedWorld();
    const res = await request(app).get(LIST).query({ status }).set(adminAuth);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(expected.map((k) => recs[k].id));
    for (const item of res.body.items) expect(item.status).toBe(status);
  });

  it('returns exactly the admin fields, with review details where available and no sensitive data', async () => {
    const { adminAuth, admin, recs } = await seedWorld();
    const res = await request(app).get(LIST).set(adminAuth);
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(ADMIN_KEYS);
      expect(Object.keys(item.author).sort()).toEqual(['fullName', 'id']);
      expect(Object.keys(item.category).sort()).toEqual(['id', 'name']);
    }
    const byId = new Map(res.body.items.map((r: { id: number }) => [r.id, r]));
    expect(byId.get(recs.rejected.id)).toMatchObject({
      status: 'Rejected',
      declaresSponsored: true,
      isSponsored: false,
      rejectionReason: 'Not suitable as sponsored.',
      reviewedBy: { id: admin.id, fullName: 'Ada Admin' },
      reviewedAt: expect.any(String),
    });
    expect(byId.get(recs.sponsored.id)).toMatchObject({ isSponsored: true, declaresSponsored: true, reviewedBy: { id: admin.id } });
    expect(byId.get(recs.removed.id)).toMatchObject({ status: 'Removed', reviewedBy: null });
    expect(JSON.stringify(res.body)).not.toMatch(/@example\.com|passwordHash|\$2[aby]\$|test-password/);
  });

  it('supports search, categoryId and sorting together with status', async () => {
    const { adminAuth, recs, cooking } = await seedWorld();
    const bySearch = await request(app).get(LIST).query({ search: 'BOB' }).set(adminAuth);
    expect(ids(bySearch)).toEqual([recs.rejected.id, recs.sponsored.id]);
    const byCategory = await request(app).get(LIST).query({ categoryId: cooking.id, status: 'Rejected' }).set(adminAuth);
    expect(ids(byCategory)).toEqual([recs.rejected.id]);
    const byTitle = await request(app).get(LIST).query({ sortBy: 'title' }).set(adminAuth);
    expect(byTitle.body.items.map((r: { title: string }) => r.title)).toEqual([
      'Alice pending', 'Alice published', 'Alice removed', 'Bob rejected', 'Bob sponsored',
    ]);
  });

  it('returns an empty page with the standard envelope when nothing matches', async () => {
    const { adminAuth } = await seedWorld();
    await prisma.recommendation.deleteMany({ where: { status: 'Removed' } }); // test database only
    const res = await request(app).get(LIST).query({ status: 'Removed' }).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], pagination: { page: 1, pageSize: 10, totalItems: 0, totalPages: 0 } });
  });

  it.each([
    ['an unknown status', 'status=Deleted'],
    ['a lower-case status', 'status=published'],
    ['an empty status', 'status='],
    ['a repeated status', 'status=Published&status=Removed'],
    ['pageSize above 50', 'pageSize=51'],
    ['page 0', 'page=0'],
    ['an unknown sortBy', 'sortBy=status'],
  ])('rejects %s with 400', async (_label, query) => {
    const { adminAuth } = await seedWorld();
    const res = await request(app).get(`${LIST}?${query}`).set(adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('names the allowed statuses in the validation message', async () => {
    const { adminAuth } = await seedWorld();
    const res = await request(app).get(LIST).query({ status: 'Deleted' }).set(adminAuth);
    expect(res.body.error.details).toEqual([
      { path: 'status', message: 'status must be one of: Published, PendingSponsoredApproval, Rejected, Removed.' },
    ]);
  });
});

describe('GET /api/admin/recommendations: pagination and safety', () => {
  it('paginates in the database with deterministic ordering, even for identical timestamps', async () => {
    const { adminAuth, alice, cooking } = await seedWorld();
    const same = new Date(Date.UTC(2026, 5, 1));
    for (let i = 0; i < 7; i++) {
      await createRecommendation(prisma, { author: alice, category: cooking, state: i % 2 ? 'removed' : 'rejected', title: `Same time ${i}`, createdAt: same });
    }
    // 5 from seedWorld + 7 = 12
    const pageOf = (page: number) => request(app).get(LIST).query({ page, pageSize: 5 }).set(adminAuth);
    const pages = await Promise.all([pageOf(1), pageOf(2), pageOf(3), pageOf(4)]);
    expect(pages[0]!.body.pagination).toEqual({ page: 1, pageSize: 5, totalItems: 12, totalPages: 3 });
    expect(pages.map((p) => p.body.items.length)).toEqual([5, 5, 2, 0]);

    const all = pages.flatMap((p) => ids(p));
    expect(new Set(all).size).toBe(12);
    // Same createdAt is ordered by id, in the same direction (desc).
    const sameTime = pages.flatMap((p) => p.body.items).filter((r: { title: string }) => r.title.startsWith('Same time'));
    const sameIds = sameTime.map((r: { id: number }) => r.id);
    expect(sameIds).toEqual([...sameIds].sort((a, b) => b - a));

    // Repeating the same request returns the same order.
    expect(ids(await pageOf(2))).toEqual(ids(pages[1]!));
  });

  it('is read-only: listing never changes any recommendation, and removed ones stay removed', async () => {
    const { adminAuth, recs } = await seedWorld();
    const before = await prisma.recommendation.findMany({ orderBy: { id: 'asc' } });
    for (const status of [undefined, 'Published', 'PendingSponsoredApproval', 'Rejected', 'Removed']) {
      await request(app).get(LIST).query(status ? { status } : {}).set(adminAuth);
    }
    expect(await prisma.recommendation.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect((await request(app).get(`/api/recommendations/${recs.removed.id}`)).status).toBe(404);
  });

  it('does not change the public listing or /mine (existing endpoints keep their scope)', async () => {
    const { alice, recs } = await seedWorld();
    const pub = await request(app).get('/api/recommendations');
    expect(ids(pub).sort()).toEqual([recs.published.id, recs.sponsored.id].sort());
    const mine = await request(app).get('/api/recommendations/mine').set(await authHeader(alice));
    expect(ids(mine).sort()).toEqual([recs.published.id, recs.pending.id, recs.removed.id].sort());
  });
});
