import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';
import { createCategory } from './helpers/fixtures.js';

const prisma = createTestPrisma();
const app = createApp();

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/categories (public)', () => {
  it('returns active categories only, alphabetically, with the list envelope', async () => {
    await createCategory(prisma, { name: 'Tools' });
    await createCategory(prisma, { name: 'cooking' });
    await createCategory(prisma, { name: 'Retired', isActive: false });

    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(['cooking', 'Tools']);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['description', 'id', 'name']);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 50, totalItems: 2, totalPages: 1 });
  });

  it('paginates and validates query parameters', async () => {
    for (const name of ['A', 'B', 'C']) await createCategory(prisma, { name });
    const res = await request(app).get('/api/categories').query({ page: 2, pageSize: 2 });
    expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(['C']);
    expect((await request(app).get('/api/categories').query({ pageSize: 51 })).status).toBe(400);
  });
});
