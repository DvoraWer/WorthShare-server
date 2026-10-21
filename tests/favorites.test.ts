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

const PUBLIC_KEYS = ['author', 'category', 'createdAt', 'description', 'id', 'imageUrl', 'isSponsored', 'title', 'updatedAt', 'url'];

async function seedWorld() {
  const alice = await createUser(prisma, { fullName: 'Alice Author', email: 'alice@example.com' });
  const bob = await createUser(prisma, { fullName: 'Bob Saver', email: 'bob@example.com' });
  const cooking = await createCategory(prisma, { name: 'Cooking' });
  const recs = {
    published: await createRecommendation(prisma, { author: alice, category: cooking, title: 'Banana bread' }),
    another: await createRecommendation(prisma, { author: alice, category: cooking, title: 'Apple pie' }),
    sponsored: await createRecommendation(prisma, { author: alice, category: cooking, state: 'sponsored', title: 'Drill' }),
    pending: await createRecommendation(prisma, { author: alice, category: cooking, state: 'pending' }),
    rejected: await createRecommendation(prisma, { author: alice, category: cooking, state: 'rejected' }),
    removed: await createRecommendation(prisma, { author: alice, category: cooking, state: 'removed' }),
  };
  return { alice, bob, recs };
}

const favoriteUrl = (id: number | string) => `/api/recommendations/${id}/favorite`;

async function add(user: { id: number }, id: number) {
  return request(app).post(favoriteUrl(id)).set(await authHeader(user));
}

async function listFor(user: { id: number }, query: Record<string, unknown> = {}) {
  return request(app).get('/api/recommendations/favorites').query(query).set(await authHeader(user));
}

async function idsFor(user: { id: number }) {
  return (await request(app).get('/api/recommendations/favorites/ids').set(await authHeader(user))).body.ids;
}

describe('favorites', () => {
  it('requires authentication on every favorites endpoint', async () => {
    const { recs } = await seedWorld();
    expect((await request(app).get('/api/recommendations/favorites')).status).toBe(401);
    expect((await request(app).get('/api/recommendations/favorites/ids')).status).toBe(401);
    expect((await request(app).post(favoriteUrl(recs.published.id))).status).toBe(401);
    expect((await request(app).delete(favoriteUrl(recs.published.id))).status).toBe(401);
  });

  it('saves a published recommendation and lists it in the public view', async () => {
    const { bob, recs } = await seedWorld();
    const res = await add(bob, recs.published.id);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    const list = await listFor(bob);
    expect(list.status).toBe(200);
    expect(list.body.pagination).toEqual({ page: 1, pageSize: 10, totalItems: 1, totalPages: 1 });
    expect(list.body.items).toHaveLength(1);
    expect(Object.keys(list.body.items[0]).sort()).toEqual(PUBLIC_KEYS);
    expect(list.body.items[0]).toMatchObject({ id: recs.published.id, title: 'Banana bread', author: { fullName: 'Alice Author' } });
    expect(JSON.stringify(list.body)).not.toMatch(/@example\.com|passwordHash/);
    expect(await idsFor(bob)).toEqual([recs.published.id]);
  });

  it('is idempotent: saving twice (even concurrently) keeps a single favorite', async () => {
    const { bob, recs } = await seedWorld();
    expect((await add(bob, recs.published.id)).status).toBe(204);
    const results = await Promise.all([add(bob, recs.published.id), add(bob, recs.published.id)]);
    expect(results.map((r) => r.status)).toEqual([204, 204]);
    expect(await prisma.favorite.count({ where: { userId: bob.id } })).toBe(1);
  });

  it('allows saving approved sponsored recommendations and the caller’s own', async () => {
    const { alice, bob, recs } = await seedWorld();
    expect((await add(bob, recs.sponsored.id)).status).toBe(204);
    expect((await add(alice, recs.published.id)).status).toBe(204);
    expect(await idsFor(alice)).toEqual([recs.published.id]);
  });

  it.each(['pending', 'rejected', 'removed'] as const)('refuses to save a %s recommendation with 404', async (state) => {
    const { bob, recs } = await seedWorld();
    const res = await add(bob, recs[state].id);
    expect(res.status).toBe(404);
    expect(await prisma.favorite.count()).toBe(0);
  });

  it('returns 404 for unknown recommendations and 400 for invalid ids', async () => {
    const { bob } = await seedWorld();
    expect((await add(bob, 999999)).status).toBe(404);
    expect((await request(app).post(favoriteUrl('abc')).set(await authHeader(bob))).status).toBe(400);
  });

  it('keeps each user’s favorites private', async () => {
    const { alice, bob, recs } = await seedWorld();
    await add(bob, recs.published.id);
    expect((await listFor(alice)).body.items).toEqual([]);
    expect(await idsFor(alice)).toEqual([]);
  });

  it('lists most recently saved first and paginates', async () => {
    const { bob, recs } = await seedWorld();
    await add(bob, recs.published.id);
    await prisma.favorite.update({
      where: { userId_recommendationId: { userId: bob.id, recommendationId: recs.published.id } },
      data: { createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    await add(bob, recs.another.id);

    const all = await listFor(bob);
    expect(all.body.items.map((r: { id: number }) => r.id)).toEqual([recs.another.id, recs.published.id]);

    const page2 = await listFor(bob, { page: 2, pageSize: 1 });
    expect(page2.body.pagination).toEqual({ page: 2, pageSize: 1, totalItems: 2, totalPages: 2 });
    expect(page2.body.items.map((r: { id: number }) => r.id)).toEqual([recs.published.id]);

    expect((await listFor(bob, { pageSize: 0 })).status).toBe(400);
  });

  it('hides a saved recommendation once it leaves public view', async () => {
    const { bob, recs } = await seedWorld();
    await add(bob, recs.published.id);
    await prisma.recommendation.update({ where: { id: recs.published.id }, data: { status: 'Removed' } });

    expect((await listFor(bob)).body.items).toEqual([]);
    expect(await idsFor(bob)).toEqual([]);
  });

  it('removes a favorite, and removing one that is not saved still returns 204', async () => {
    const { bob, recs } = await seedWorld();
    await add(bob, recs.published.id);

    const removed = await request(app).delete(favoriteUrl(recs.published.id)).set(await authHeader(bob));
    expect(removed.status).toBe(204);
    expect(await idsFor(bob)).toEqual([]);

    const again = await request(app).delete(favoriteUrl(recs.published.id)).set(await authHeader(bob));
    expect(again.status).toBe(204);
  });
});
