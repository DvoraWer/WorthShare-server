import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';
import { authHeader, createCategory, createRecommendation, createUser, FIXTURE_DISCLOSURE } from './helpers/fixtures.js';

const prisma = createTestPrisma();
const app = createApp();

let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetDatabase(prisma);
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const PUBLIC_KEYS = ['author', 'category', 'createdAt', 'description', 'id', 'imageUrl', 'isSponsored', 'title', 'updatedAt', 'url'];
const OWNER_KEYS = [...PUBLIC_KEYS, 'declaresSponsored', 'disclosure', 'rejectionReason', 'reviewedAt', 'status'].sort();

function adminLogs() {
  return infoSpy.mock.calls
    .map((args: unknown[]) => JSON.parse(String(args[0])) as Record<string, unknown>)
    .filter((entry: Record<string, unknown>) => entry.event === 'recommendation.admin_action');
}

/** A world with one recommendation in every state, plus a published one in a disabled category. */
async function seedWorld() {
  const alice = await createUser(prisma, { fullName: 'Alice Author', email: 'alice@example.com' });
  const bob = await createUser(prisma, { fullName: 'Bob Other', email: 'bob@example.com' });
  const admin = await createUser(prisma, { fullName: 'Ada Admin', email: 'admin@example.com', role: 'Admin' });
  const cooking = await createCategory(prisma, { name: 'Cooking' });
  const tools = await createCategory(prisma, { name: 'Tools' });
  const retired = await createCategory(prisma, { name: 'Retired', isActive: false });

  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
  const recs = {
    published: await createRecommendation(prisma, { author: alice, category: cooking, title: 'Banana bread', description: 'Use very ripe bananas.', createdAt: t(1) }),
    sponsored: await createRecommendation(prisma, { author: alice, category: tools, state: 'sponsored', reviewer: admin, title: 'Cordless drill', description: 'Great battery life.', createdAt: t(2) }),
    inRetired: await createRecommendation(prisma, { author: bob, category: retired, title: 'Apple picking', description: 'Seasonal fun.', createdAt: t(3) }),
    pending: await createRecommendation(prisma, { author: alice, category: cooking, state: 'pending', title: 'Pending banana smoothie', createdAt: t(4) }),
    rejected: await createRecommendation(prisma, { author: alice, category: cooking, state: 'rejected', reviewer: admin, title: 'Rejected banana chips', createdAt: t(5) }),
    removed: await createRecommendation(prisma, { author: alice, category: cooking, state: 'removed', title: 'Removed banana split', createdAt: t(6) }),
    bobPending: await createRecommendation(prisma, { author: bob, category: cooking, state: 'pending', title: 'Bob pending', createdAt: t(7) }),
  };
  return { alice, bob, admin, cooking, tools, retired, recs };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  title: 'A new recommendation',
  description: 'Worth sharing.',
  ...overrides,
});

// ====================================================================== public

describe('GET /api/recommendations (public listing)', () => {
  it('returns only Published recommendations, including those in a later-disabled category', async () => {
    const { recs } = await seedWorld();
    const res = await request(app).get('/api/recommendations');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((r: { id: number }) => r.id).sort();
    expect(ids).toEqual([recs.published.id, recs.sponsored.id, recs.inRetired.id].sort());
  });

  it('returns safe public fields only (no email, hash or workflow fields) and the sponsored label', async () => {
    const { recs } = await seedWorld();
    const res = await request(app).get('/api/recommendations');
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(PUBLIC_KEYS);
      expect(Object.keys(item.author).sort()).toEqual(['fullName', 'id']);
      expect(Object.keys(item.category).sort()).toEqual(['id', 'name']);
      expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/@example\.com|passwordHash|\$2[aby]\$|declaresSponsored|rejectionReason/);
    const sponsored = res.body.items.find((r: { id: number }) => r.id === recs.sponsored.id);
    expect(sponsored.isSponsored).toBe(true);
    expect(res.body.items.filter((r: { isSponsored: boolean }) => r.isSponsored)).toHaveLength(1);
  });

  it('searches title and description case-insensitively, among published only', async () => {
    const { recs } = await seedWorld();
    const byTitle = await request(app).get('/api/recommendations').query({ search: 'BANANA' });
    expect(byTitle.body.items.map((r: { id: number }) => r.id)).toEqual([recs.published.id]);

    const byDescription = await request(app).get('/api/recommendations').query({ search: 'battery' });
    expect(byDescription.body.items.map((r: { id: number }) => r.id)).toEqual([recs.sponsored.id]);
  });

  it('treats % and _ in search as literal characters', async () => {
    const { alice, cooking } = await seedWorld();
    const literal = await createRecommendation(prisma, { author: alice, category: cooking, title: '100% cotton towels' });
    await createRecommendation(prisma, { author: alice, category: cooking, title: '1000 piece puzzle' }); // matches 100% as a wildcard
    const snake = await createRecommendation(prisma, { author: alice, category: cooking, title: 'snake_case naming' });
    await createRecommendation(prisma, { author: alice, category: cooking, title: 'snakeXcase naming' }); // matches _ as a wildcard
    const backslash = await createRecommendation(prisma, { author: alice, category: cooking, title: 'C:\\path tip' });

    const ids = async (search: string) =>
      (await request(app).get('/api/recommendations').query({ search })).body.items.map((r: { id: number }) => r.id);
    expect(await ids('100%')).toEqual([literal.id]);
    expect(await ids('snake_case')).toEqual([snake.id]);
    expect(await ids('_')).toEqual([snake.id]);
    expect(await ids('C:\\')).toEqual([backslash.id]);
  });

  it('filters by category', async () => {
    const { recs, tools, retired } = await seedWorld();
    const res = await request(app).get('/api/recommendations').query({ categoryId: tools.id });
    expect(res.body.items.map((r: { id: number }) => r.id)).toEqual([recs.sponsored.id]);
    const disabled = await request(app).get('/api/recommendations').query({ categoryId: retired.id });
    expect(disabled.body.items.map((r: { id: number }) => r.id)).toEqual([recs.inRetired.id]);
  });

  it('sorts by createdAt and title in both directions, with sensible defaults', async () => {
    await seedWorld();
    const titles = async (query: Record<string, string>) =>
      (await request(app).get('/api/recommendations').query(query)).body.items.map((r: { title: string }) => r.title);

    expect(await titles({})).toEqual(['Apple picking', 'Cordless drill', 'Banana bread']); // newest first
    expect(await titles({ sortBy: 'createdAt', sortOrder: 'asc' })).toEqual(['Banana bread', 'Cordless drill', 'Apple picking']);
    expect(await titles({ sortBy: 'title' })).toEqual(['Apple picking', 'Banana bread', 'Cordless drill']); // A→Z
    expect(await titles({ sortBy: 'title', sortOrder: 'desc' })).toEqual(['Cordless drill', 'Banana bread', 'Apple picking']);
  });

  it('paginates with the standard envelope and stable, non-overlapping pages', async () => {
    const { alice, cooking } = await seedWorld();
    for (let i = 0; i < 4; i++) await createRecommendation(prisma, { author: alice, category: cooking, title: `Extra ${i}` });
    // 3 published from seedWorld + 4 extra = 7

    const page = (n: number) => request(app).get('/api/recommendations').query({ page: n, pageSize: 3 });
    const [p1, p2, p3, p4] = await Promise.all([page(1), page(2), page(3), page(4)]);
    expect(p1.body.pagination).toEqual({ page: 1, pageSize: 3, totalItems: 7, totalPages: 3 });
    expect(p1.body.items).toHaveLength(3);
    expect(p2.body.items).toHaveLength(3);
    expect(p3.body.items).toHaveLength(1);
    expect(p4.status).toBe(200);
    expect(p4.body).toEqual({ items: [], pagination: { page: 4, pageSize: 3, totalItems: 7, totalPages: 3 } });

    const all = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((r: { id: number }) => r.id);
    expect(new Set(all).size).toBe(7);

    const defaults = await request(app).get('/api/recommendations');
    expect(defaults.body.pagination).toMatchObject({ page: 1, pageSize: 10 });
    expect((await request(app).get('/api/recommendations').query({ pageSize: 50 })).status).toBe(200);
  });

  it.each([
    ['pageSize above 50', 'pageSize=51'],
    ['pageSize 0', 'pageSize=0'],
    ['page 0', 'page=0'],
    ['negative page', 'page=-1'],
    ['fractional page', 'page=1.5'],
    ['non-numeric page', 'page=abc'],
    ['repeated page', 'page=1&page=2'],
    ['unknown sortBy', 'sortBy=passwordHash'],
    ['unknown sortOrder', 'sortOrder=up'],
    ['non-numeric categoryId', 'categoryId=x'],
    ['over-long search', `search=${'a'.repeat(101)}`],
  ])('rejects %s with 400', async (_label, query) => {
    const res = await request(app).get(`/api/recommendations?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });
});

describe('GET /api/recommendations/:id (public detail)', () => {
  it('returns a published recommendation with the public shape', async () => {
    const { recs } = await seedWorld();
    const res = await request(app).get(`/api/recommendations/${recs.sponsored.id}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(PUBLIC_KEYS);
    expect(res.body).toMatchObject({ id: recs.sponsored.id, isSponsored: true, author: { fullName: 'Alice Author' } });
  });

  it('shows only the sponsored label publicly, never the disclosure behind it', async () => {
    const { recs } = await seedWorld();
    const detail = await request(app).get(`/api/recommendations/${recs.sponsored.id}`);
    expect(detail.body.isSponsored).toBe(true);
    const list = await request(app).get('/api/recommendations');
    for (const body of [JSON.stringify(detail.body), JSON.stringify(list.body)]) {
      for (const value of Object.values(FIXTURE_DISCLOSURE)) expect(body).not.toContain(value);
      expect(body).not.toMatch(/disclosure|sponsorName|productName|sponsorshipType/);
    }
  });

  it('returns 404 for pending, rejected and removed recommendations, even to their owner', async () => {
    const { alice, recs } = await seedWorld();
    for (const rec of [recs.pending, recs.rejected, recs.removed]) {
      expect((await request(app).get(`/api/recommendations/${rec.id}`)).status).toBe(404);
      expect((await request(app).get(`/api/recommendations/${rec.id}`).set(await authHeader(alice))).status).toBe(404);
    }
  });

  it('returns 404 for unknown ids and 400 for invalid ids', async () => {
    expect((await request(app).get('/api/recommendations/999999')).status).toBe(404);
    expect((await request(app).get('/api/recommendations/abc')).status).toBe(400);
    expect((await request(app).get('/api/recommendations/99999999999')).status).toBe(400);
  });
});

// ====================================================================== mine

describe('GET /api/recommendations/mine', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/recommendations/mine')).status).toBe(401);
  });

  it("returns only the caller's recommendations in every status, including Removed", async () => {
    const { alice, recs } = await seedWorld();
    const res = await request(app).get('/api/recommendations/mine').set(await authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.pagination.totalItems).toBe(5);

    const byId = new Map(res.body.items.map((r: { id: number; status: string }) => [r.id, r.status]));
    expect(byId).toEqual(
      new Map([
        [recs.published.id, 'Published'],
        [recs.sponsored.id, 'Published'],
        [recs.pending.id, 'PendingSponsoredApproval'],
        [recs.rejected.id, 'Rejected'],
        [recs.removed.id, 'Removed'],
      ]),
    );
    for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(OWNER_KEYS);

    const rejected = res.body.items.find((r: { id: number }) => r.id === recs.rejected.id);
    expect(rejected).toMatchObject({ declaresSponsored: true, isSponsored: false, rejectionReason: 'Not suitable as sponsored.' });
    expect(rejected.reviewedAt).toEqual(expect.any(String));
    // Owners see their full disclosure on private requests; regular items have none.
    expect(rejected.disclosure).toEqual(FIXTURE_DISCLOSURE);
    expect(res.body.items.find((r: { id: number }) => r.id === recs.published.id).disclosure).toBeNull();
  });

  it('supports the same pagination and filters', async () => {
    const { alice, cooking } = await seedWorld();
    const res = await request(app)
      .get('/api/recommendations/mine')
      .query({ categoryId: cooking.id, pageSize: 2, sortBy: 'title' })
      .set(await authHeader(alice));
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 2, totalItems: 4, totalPages: 2 });
    expect(res.body.items.map((r: { title: string }) => r.title)).toEqual(['Banana bread', 'Pending banana smoothie']);
  });
});

// ====================================================================== create

describe('POST /api/recommendations', () => {
  it('requires authentication', async () => {
    const { cooking } = await seedWorld();
    expect((await request(app).post('/api/recommendations').send(body({ categoryId: cooking.id }))).status).toBe(401);
  });

  it('creates a public regular recommendation authored by the caller, ignoring server-controlled fields', async () => {
    const { alice, bob, admin, cooking } = await seedWorld();
    const res = await request(app)
      .post('/api/recommendations')
      .set(await authHeader(alice))
      .send(
        body({
          title: '  Trimmed title  ',
          categoryId: cooking.id,
          url: 'https://example.com/page',
          imageUrl: '',
          createdByUserId: bob.id,
          status: 'PendingSponsoredApproval',
          isSponsored: true,
          declaresSponsored: true,
          reviewedByUserId: admin.id,
        }),
      );
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(OWNER_KEYS);
    expect(res.body).toMatchObject({
      title: 'Trimmed title',
      status: 'Published',
      isSponsored: false,
      declaresSponsored: false,
      reviewedAt: null,
      url: 'https://example.com/page',
      imageUrl: null,
      author: { id: alice.id, fullName: 'Alice Author' },
      category: { id: cooking.id, name: 'Cooking' },
    });

    const stored = await prisma.recommendation.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored).toMatchObject({ createdByUserId: alice.id, reviewedByUserId: null, status: 'Published' });

    const pub = await request(app).get(`/api/recommendations/${res.body.id}`);
    expect(pub.status).toBe(200);
  });

  it('rejects a disabled or missing category with 400', async () => {
    const { alice, retired } = await seedWorld();
    for (const categoryId of [retired.id, 999999]) {
      const res = await request(app).post('/api/recommendations').set(await authHeader(alice)).send(body({ categoryId }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual([{ path: 'categoryId', message: 'Category must exist and be active.' }]);
    }
    expect(await prisma.recommendation.count({ where: { createdByUserId: alice.id, title: 'A new recommendation' } })).toBe(0);
  });

  it.each([
    ['missing title', { title: undefined }, 'title'],
    ['blank title', { title: '   ' }, 'title'],
    ['title over 120 characters', { title: 'a'.repeat(121) }, 'title'],
    ['description over 3000 characters', { description: 'a'.repeat(3001) }, 'description'],
    ['missing description', { description: undefined }, 'description'],
    ['ftp url', { url: 'ftp://example.com/file' }, 'url'],
    ['javascript url', { url: 'javascript:alert(1)' }, 'url'],
    ['invalid imageUrl', { imageUrl: 'not a url' }, 'imageUrl'],
    ['categoryId as a string', { categoryId: '1' }, 'categoryId'],
    ['missing categoryId', { categoryId: undefined }, 'categoryId'],
  ])('rejects %s with 400', async (_label, overrides, field) => {
    const { alice, cooking } = await seedWorld();
    const res = await request(app)
      .post('/api/recommendations')
      .set(await authHeader(alice))
      .send(body({ categoryId: cooking.id, ...overrides }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
  });

  it('accepts the maximum lengths', async () => {
    const { alice, cooking } = await seedWorld();
    const res = await request(app)
      .post('/api/recommendations')
      .set(await authHeader(alice))
      .send(body({ categoryId: cooking.id, title: 'a'.repeat(120), description: 'b'.repeat(3000) }));
    expect(res.status).toBe(201);
  });
});

// ====================================================================== update

describe('PUT /api/recommendations/:id', () => {
  it('lets the owner edit a regular recommendation, which stays published; omitted URLs are cleared', async () => {
    const { alice, tools, recs } = await seedWorld();
    await prisma.recommendation.update({ where: { id: recs.published.id }, data: { url: 'https://old.example.com' } });
    const res = await request(app)
      .put(`/api/recommendations/${recs.published.id}`)
      .set(await authHeader(alice))
      .send(body({ title: 'Better banana bread', categoryId: tools.id }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Better banana bread', status: 'Published', isSponsored: false, url: null, category: { id: tools.id } });
    expect(adminLogs()).toHaveLength(0);
  });

  it("returns 403 for someone else's public recommendation and 404 for someone else's private one", async () => {
    const { bob, cooking, recs } = await seedWorld();
    const auth = await authHeader(bob);
    const pub = await request(app).put(`/api/recommendations/${recs.published.id}`).set(auth).send(body({ categoryId: cooking.id }));
    expect(pub.status).toBe(403);
    for (const rec of [recs.pending, recs.rejected]) {
      const res = await request(app).put(`/api/recommendations/${rec.id}`).set(auth).send(body({ categoryId: cooking.id }));
      expect(res.status).toBe(404);
    }
    const unchanged = await prisma.recommendation.findUniqueOrThrow({ where: { id: recs.published.id } });
    expect(unchanged.title).toBe('Banana bread');
  });

  it("lets an admin edit anyone's recommendation and logs it", async () => {
    const { admin, cooking, recs, alice } = await seedWorld();
    const res = await request(app)
      .put(`/api/recommendations/${recs.published.id}`)
      .set(await authHeader(admin))
      .send(body({ title: 'Edited by admin', categoryId: cooking.id }));
    expect(res.status).toBe(200);
    expect(res.body.author.id).toBe(alice.id); // authorship never changes
    expect(adminLogs()).toEqual([
      expect.objectContaining({ action: 'update', adminUserId: admin.id, recommendationId: recs.published.id, ownerUserId: alice.id, transition: 'edited' }),
    ]);
    expect(JSON.stringify(adminLogs())).not.toMatch(/password|token|Bearer/i);
  });

  it('forbids switching to a disabled category but allows keeping a now-disabled one', async () => {
    const { alice, bob, retired, recs } = await seedWorld();
    const toDisabled = await request(app)
      .put(`/api/recommendations/${recs.published.id}`)
      .set(await authHeader(alice))
      .send(body({ categoryId: retired.id }));
    expect(toDisabled.status).toBe(400);
    expect(toDisabled.body.error.details[0].path).toBe('categoryId');

    const keep = await request(app)
      .put(`/api/recommendations/${recs.inRetired.id}`)
      .set(await authHeader(bob))
      .send(body({ title: 'Apple picking (updated)', categoryId: retired.id }));
    expect(keep.status).toBe(200);
    expect(keep.body.category.id).toBe(retired.id);
  });

  it.each([['owner'], ['admin']] as const)(
    'revokes sponsored approval when the %s edits an approved sponsored recommendation',
    async (who) => {
      const world = await seedWorld();
      const actor = who === 'owner' ? world.alice : world.admin;
      const res = await request(app)
        .put(`/api/recommendations/${world.recs.sponsored.id}`)
        .set(await authHeader(actor))
        .send(body({ title: 'Cordless drill v2', categoryId: world.tools.id }));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'PendingSponsoredApproval',
        isSponsored: false,
        declaresSponsored: true,
        reviewedAt: null,
        rejectionReason: null,
      });
      const stored = await prisma.recommendation.findUniqueOrThrow({ where: { id: world.recs.sponsored.id } });
      expect(stored.reviewedByUserId).toBeNull();
      // The unreviewed edit is no longer public.
      expect((await request(app).get(`/api/recommendations/${world.recs.sponsored.id}`)).status).toBe(404);
      if (who === 'admin') expect(adminLogs()[0]).toMatchObject({ transition: 'sponsored_approval_revoked', newStatus: 'PendingSponsoredApproval' });
    },
  );

  it('keeps a pending recommendation pending when edited', async () => {
    const { alice, cooking, recs } = await seedWorld();
    const res = await request(app).put(`/api/recommendations/${recs.pending.id}`).set(await authHeader(alice)).send(body({ categoryId: cooking.id }));
    expect(res.body).toMatchObject({ status: 'PendingSponsoredApproval', declaresSponsored: true, isSponsored: false });
  });

  it('keeps a rejected recommendation rejected and private when edited without publishAsRegular', async () => {
    const { alice, cooking, recs } = await seedWorld();
    const res = await request(app)
      .put(`/api/recommendations/${recs.rejected.id}`)
      .set(await authHeader(alice))
      .send(body({ categoryId: cooking.id, publishAsRegular: false }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'Rejected', declaresSponsored: true, isSponsored: false, rejectionReason: 'Not suitable as sponsored.' });
    expect((await request(app).get(`/api/recommendations/${recs.rejected.id}`)).status).toBe(404);
  });

  it('publishes a rejected recommendation as regular only via publishAsRegular, withdrawing the declaration and clearing the review', async () => {
    const { alice, cooking, recs } = await seedWorld();
    const res = await request(app)
      .put(`/api/recommendations/${recs.rejected.id}`)
      .set(await authHeader(alice))
      .send(body({ title: 'Banana chips (regular)', categoryId: cooking.id, publishAsRegular: true }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'Published',
      isSponsored: false,
      declaresSponsored: false,
      reviewedAt: null,
      rejectionReason: null,
    });
    const stored = await prisma.recommendation.findUniqueOrThrow({ where: { id: recs.rejected.id } });
    expect(stored).toMatchObject({
      reviewedByUserId: null,
      reviewedAt: null,
      rejectionReason: null,
      declaresSponsored: false,
      sponsorName: null,
      productName: null,
      sponsorshipType: null,
      disclosureDetails: null,
    });
    expect(res.body.disclosure).toBeNull();

    const pub = await request(app).get(`/api/recommendations/${recs.rejected.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.isSponsored).toBe(false);
  });

  it.each([['published'], ['sponsored'], ['pending']] as const)(
    'rejects publishAsRegular on a %s recommendation with 409 and changes nothing',
    async (state) => {
      const { alice, cooking, recs } = await seedWorld();
      const rec = recs[state];
      const before = await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } });
      const res = await request(app)
        .put(`/api/recommendations/${rec.id}`)
        .set(await authHeader(alice))
        .send(body({ categoryId: cooking.id, publishAsRegular: true }));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } })).toEqual(before);
    },
  );

  it('returns 404 for removed recommendations, for the owner and for admins', async () => {
    const { alice, admin, cooking, recs } = await seedWorld();
    for (const actor of [alice, admin]) {
      const res = await request(app).put(`/api/recommendations/${recs.removed.id}`).set(await authHeader(actor)).send(body({ categoryId: cooking.id }));
      expect(res.status).toBe(404);
    }
  });

  it('requires authentication and validates input', async () => {
    const { alice, cooking, recs } = await seedWorld();
    expect((await request(app).put(`/api/recommendations/${recs.published.id}`).send(body({ categoryId: cooking.id }))).status).toBe(401);
    const bad = await request(app)
      .put(`/api/recommendations/${recs.published.id}`)
      .set(await authHeader(alice))
      .send(body({ categoryId: cooking.id, publishAsRegular: 'yes' }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('publishAsRegular');
  });
});

// ====================================================================== delete

describe('DELETE /api/recommendations/:id', () => {
  it('soft-deletes: 204, row kept as Removed, hidden publicly, listed in /mine', async () => {
    const { alice, recs } = await seedWorld();
    const res = await request(app).delete(`/api/recommendations/${recs.published.id}`).set(await authHeader(alice));
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    const stored = await prisma.recommendation.findUniqueOrThrow({ where: { id: recs.published.id } });
    expect(stored.status).toBe('Removed');
    expect(stored.title).toBe('Banana bread');

    expect((await request(app).get(`/api/recommendations/${recs.published.id}`)).status).toBe(404);
    const list = await request(app).get('/api/recommendations');
    expect(list.body.items.map((r: { id: number }) => r.id)).not.toContain(recs.published.id);

    const mine = await request(app).get('/api/recommendations/mine').set(await authHeader(alice));
    expect(mine.body.items.find((r: { id: number }) => r.id === recs.published.id).status).toBe('Removed');
  });

  it('keeps an approved sponsored recommendation’s audit data when removed', async () => {
    const { alice, admin, recs } = await seedWorld();
    await request(app).delete(`/api/recommendations/${recs.sponsored.id}`).set(await authHeader(alice));
    const stored = await prisma.recommendation.findUniqueOrThrow({ where: { id: recs.sponsored.id } });
    expect(stored).toMatchObject({ status: 'Removed', reviewedByUserId: admin.id });
  });

  it('returns 403/404 for other users, allows admins (logged), and 404 when already removed', async () => {
    const { bob, admin, alice, recs } = await seedWorld();
    expect((await request(app).delete(`/api/recommendations/${recs.published.id}`).set(await authHeader(bob))).status).toBe(403);
    expect((await request(app).delete(`/api/recommendations/${recs.pending.id}`).set(await authHeader(bob))).status).toBe(404);

    expect((await request(app).delete(`/api/recommendations/${recs.pending.id}`).set(await authHeader(admin))).status).toBe(204);
    expect(adminLogs()).toEqual([expect.objectContaining({ action: 'remove', recommendationId: recs.pending.id, ownerUserId: alice.id, previousStatus: 'PendingSponsoredApproval' })]);

    expect((await request(app).delete(`/api/recommendations/${recs.removed.id}`).set(await authHeader(alice))).status).toBe(404);
    expect((await request(app).delete(`/api/recommendations/${recs.published.id}`)).status).toBe(401);
  });
});

// ====================================================================== request-sponsored

describe('POST /api/recommendations/:id/request-sponsored', () => {
  const disclosure = (overrides: Record<string, unknown> = {}) => ({
    sponsorName: 'BlendCo',
    productName: 'BlendCo Pro 900',
    sponsorshipType: 'PaidPromotion',
    disclosureDetails: 'Paid post; I bought the blender myself first.',
    ...overrides,
  });
  const requestSponsored = async (id: number, user?: { id: number }, payload: Record<string, unknown> = disclosure()) => {
    const req = request(app).post(`/api/recommendations/${id}/request-sponsored`).send(payload);
    return user ? req.set(await authHeader(user)) : req;
  };

  it('moves a regular published recommendation to pending with its disclosure; it leaves public view', async () => {
    const { alice, recs } = await seedWorld();
    const res = await requestSponsored(recs.published.id, alice);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'PendingSponsoredApproval',
      isSponsored: false,
      declaresSponsored: true,
      disclosure: disclosure(),
    });
    expect((await request(app).get(`/api/recommendations/${recs.published.id}`)).status).toBe(404);
  });

  it('trims the disclosure, treats blank details as none, and ignores server-controlled fields', async () => {
    const { alice, recs } = await seedWorld();
    const res = await requestSponsored(
      recs.published.id,
      alice,
      disclosure({ sponsorName: '  BlendCo  ', disclosureDetails: '   ', isSponsored: true, status: 'Published', declaresSponsored: false }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PendingSponsoredApproval', isSponsored: false, declaresSponsored: true });
    expect(res.body.disclosure).toMatchObject({ sponsorName: 'BlendCo', disclosureDetails: null });
  });

  it.each([
    ['missing sponsorName', { sponsorName: undefined }, 'sponsorName'],
    ['blank sponsorName', { sponsorName: '   ' }, 'sponsorName'],
    ['missing productName', { productName: undefined }, 'productName'],
    ['too long productName', { productName: 'x'.repeat(121) }, 'productName'],
    ['missing sponsorshipType', { sponsorshipType: undefined }, 'sponsorshipType'],
    ['unknown sponsorshipType', { sponsorshipType: 'Bribe' }, 'sponsorshipType'],
    ['too long disclosureDetails', { disclosureDetails: 'x'.repeat(1001) }, 'disclosureDetails'],
    ['Other without details', { sponsorshipType: 'Other', disclosureDetails: undefined }, 'disclosureDetails'],
    ['Other with blank details', { sponsorshipType: 'Other', disclosureDetails: '   ' }, 'disclosureDetails'],
  ])('rejects %s with 400 and changes nothing', async (_name, overrides, field) => {
    const { alice, recs } = await seedWorld();
    const before = await prisma.recommendation.findUniqueOrThrow({ where: { id: recs.published.id } });
    const res = await requestSponsored(recs.published.id, alice, disclosure(overrides));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
    expect(await prisma.recommendation.findUniqueOrThrow({ where: { id: recs.published.id } })).toEqual(before);
  });

  it('accepts Other when the relationship is explained in the details', async () => {
    const { alice, recs } = await seedWorld();
    const res = await requestSponsored(
      recs.published.id,
      alice,
      disclosure({ sponsorshipType: 'Other', disclosureDetails: 'My sister works at BlendCo.' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.disclosure).toMatchObject({ sponsorshipType: 'Other', disclosureDetails: 'My sister works at BlendCo.' });
  });

  it('rejects a request without a body with 400', async () => {
    const { alice, recs } = await seedWorld();
    const res = await request(app).post(`/api/recommendations/${recs.published.id}/request-sponsored`).set(await authHeader(alice));
    expect(res.status).toBe(400);
  });

  it('resubmits a rejected recommendation with a new disclosure and clears the previous review', async () => {
    const { alice, recs } = await seedWorld();
    const res = await requestSponsored(recs.rejected.id, alice, disclosure({ sponsorshipType: 'OwnBusiness' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PendingSponsoredApproval', reviewedAt: null, rejectionReason: null, declaresSponsored: true });
    expect(res.body.disclosure.sponsorshipType).toBe('OwnBusiness');
    const stored = await prisma.recommendation.findUniqueOrThrow({ where: { id: recs.rejected.id } });
    expect(stored.reviewedByUserId).toBeNull();
  });

  it('updates the disclosure of a pending request; an admin review of the previous version is then stale', async () => {
    const { alice, admin, recs } = await seedWorld();
    const before = await prisma.recommendation.findUniqueOrThrow({ where: { id: recs.pending.id } });

    const res = await requestSponsored(recs.pending.id, alice, disclosure({ sponsorName: 'Fixed Brand Name' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PendingSponsoredApproval', disclosure: { sponsorName: 'Fixed Brand Name' } });
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(before.updatedAt.getTime());

    const stale = await request(app)
      .put(`/api/admin/recommendations/${recs.pending.id}/approve-sponsored`)
      .set(await authHeader(admin))
      .send({ expectedUpdatedAt: before.updatedAt.toISOString() });
    expect(stale.status).toBe(409);
  });

  it('rejects already-approved recommendations with 409 and changes nothing', async () => {
    const { alice, recs } = await seedWorld();
    const before = await prisma.recommendation.findUniqueOrThrow({ where: { id: recs.sponsored.id } });
    const res = await requestSponsored(recs.sponsored.id, alice);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await prisma.recommendation.findUniqueOrThrow({ where: { id: recs.sponsored.id } })).toEqual(before);
  });

  it('is owner-only: 403 on others’ public items (even for admins), 404 on private/removed', async () => {
    const { bob, admin, alice, recs } = await seedWorld();
    expect((await requestSponsored(recs.published.id, bob)).status).toBe(403);
    expect((await requestSponsored(recs.published.id, admin)).status).toBe(403);
    expect((await requestSponsored(recs.rejected.id, bob)).status).toBe(404);
    expect((await requestSponsored(recs.pending.id, bob)).status).toBe(404);
    expect((await requestSponsored(recs.removed.id, alice)).status).toBe(404);
    expect((await requestSponsored(recs.published.id)).status).toBe(401);
  });

  it('lets only one of two simultaneous requests succeed', async () => {
    const { alice, recs } = await seedWorld();
    const results = await Promise.all([requestSponsored(recs.published.id, alice), requestSponsored(recs.published.id, alice)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('lets an admin request sponsorship for their own recommendation', async () => {
    const { admin, cooking } = await seedWorld();
    const own = await createRecommendation(prisma, { author: admin, category: cooking });
    expect((await requestSponsored(own.id, admin)).status).toBe(200);
  });
});
