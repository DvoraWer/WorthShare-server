import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';
import { authHeader, createCategory, createRecommendation, createUser } from './helpers/fixtures.js';

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

const CATS = '/api/admin/categories';
const CATEGORY_KEYS = ['createdAt', 'description', 'id', 'isActive', 'name', 'updatedAt'];

function categoryLogs() {
  return infoSpy.mock.calls
    .map((args: unknown[]) => JSON.parse(String(args[0])) as Record<string, unknown>)
    .filter((entry: Record<string, unknown>) => entry.event === 'category.admin_action');
}

async function seed() {
  const admin = await createUser(prisma, { fullName: 'Ada Admin', email: 'ada@example.com', role: 'Admin' });
  const alice = await createUser(prisma, { fullName: 'Alice', email: 'alice@example.com' });
  const cooking = await createCategory(prisma, { name: 'Cooking' });
  const tools = await createCategory(prisma, { name: 'Tools' });
  const retired = await createCategory(prisma, { name: 'Retired', isActive: false });
  return { admin, alice, cooking, tools, retired, adminAuth: await authHeader(admin), aliceAuth: await authHeader(alice) };
}

const snapshotCategories = () => prisma.category.findMany({ orderBy: { id: 'asc' } });

// ====================================================================== authorization

describe('authorization (all category-admin endpoints are admin-only)', () => {
  it('returns 401 without a token and 403 for regular users, changing nothing', async () => {
    const { cooking, aliceAuth } = await seed();
    const before = await snapshotCategories();
    const calls = [
      () => request(app).get(CATS),
      () => request(app).post(CATS).send({ name: 'New' }),
      () => request(app).put(`${CATS}/${cooking.id}`).send({ name: 'Renamed' }),
      () => request(app).patch(`${CATS}/${cooking.id}/status`).send({ isActive: false }),
    ];
    for (const call of calls) expect((await call()).status).toBe(401);
    for (const call of calls) {
      const res = await call().set(aliceAuth);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect(await snapshotCategories()).toEqual(before);
  });

  it('rejects a deactivated (401) or demoted (403) admin', async () => {
    const { admin, adminAuth } = await seed();
    const other = await createUser(prisma, { email: 'other@example.com', role: 'Admin' });
    const otherAuth = await authHeader(other);
    await prisma.user.update({ where: { id: other.id }, data: { role: 'User' } });
    expect((await request(app).post(CATS).set(otherAuth).send({ name: 'X' })).status).toBe(403);

    await prisma.user.update({ where: { id: admin.id }, data: { isActive: false } });
    expect((await request(app).post(CATS).set(adminAuth).send({ name: 'X' })).status).toBe(401);
    expect(await prisma.category.count({ where: { name: 'X' } })).toBe(0);
  });

  it('has no delete endpoint: categories are disabled, never deleted', async () => {
    const { cooking, adminAuth } = await seed();
    const res = await request(app).delete(`${CATS}/${cooking.id}`).set(adminAuth);
    expect(res.status).toBe(404);
    expect(await prisma.category.findUnique({ where: { id: cooking.id } })).not.toBeNull();
  });
});

// ====================================================================== listing

describe('GET /api/admin/categories', () => {
  it('lists active and disabled categories alphabetically with admin fields', async () => {
    const { adminAuth } = await seed();
    const res = await request(app).get(CATS).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.items.map((c: { name: string; isActive: boolean }) => [c.name, c.isActive])).toEqual([
      ['Cooking', true],
      ['Retired', false],
      ['Tools', true],
    ]);
    for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(CATEGORY_KEYS);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 50, totalItems: 3, totalPages: 1 });
  });

  it('paginates, searches and validates the query', async () => {
    const { adminAuth } = await seed();
    const page = await request(app).get(CATS).query({ page: 2, pageSize: 2 }).set(adminAuth);
    expect(page.body.items.map((c: { name: string }) => c.name)).toEqual(['Tools']);
    const search = await request(app).get(CATS).query({ search: 'RET' }).set(adminAuth);
    expect(search.body.items.map((c: { name: string }) => c.name)).toEqual(['Retired']);
    expect((await request(app).get(CATS).query({ pageSize: 51 }).set(adminAuth)).status).toBe(400);
  });
});

// ====================================================================== create

describe('POST /api/admin/categories', () => {
  it('creates an active category (client isActive ignored), trimming input', async () => {
    const { adminAuth, admin } = await seed();
    const res = await request(app)
      .post(CATS)
      .set(adminAuth)
      .send({ name: '  Gardening  ', description: '  Plants and tools  ', isActive: false, id: 999 });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(CATEGORY_KEYS);
    expect(res.body).toMatchObject({ name: 'Gardening', description: 'Plants and tools', isActive: true });
    expect(res.body.id).not.toBe(999);
    expect(categoryLogs()).toEqual([expect.objectContaining({ action: 'create', adminUserId: admin.id, categoryId: res.body.id })]);

    // New active categories are public immediately.
    const pub = await request(app).get('/api/categories');
    expect(pub.body.items.map((c: { name: string }) => c.name)).toContain('Gardening');
  });

  it('stores a blank description as null', async () => {
    const { adminAuth } = await seed();
    const res = await request(app).post(CATS).set(adminAuth).send({ name: 'Books', description: '   ' });
    expect(res.body.description).toBeNull();
  });

  it.each([['Cooking'], ['cooking'], ['COOKING'], ['  Cooking  '], ['retired']])(
    'rejects the duplicate name %j with 409 (case-insensitive)',
    async (name) => {
      const { adminAuth } = await seed();
      const res = await request(app).post(CATS).set(adminAuth).send({ name });
      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({ code: 'CONFLICT', message: 'A category with this name already exists.' });
      expect(await prisma.category.count()).toBe(3);
    },
  );

  it('lets only one of two simultaneous creations with the same name succeed', async () => {
    const { adminAuth } = await seed();
    const results = await Promise.all([
      request(app).post(CATS).set(adminAuth).send({ name: 'Travel' }),
      request(app).post(CATS).set(adminAuth).send({ name: 'TRAVEL' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.category.count({ where: { name: 'travel' } })).toBe(1);
  });

  it.each([
    ['a missing name', {}, 'name'],
    ['a blank name', { name: '   ' }, 'name'],
    ['a name over 100 characters', { name: 'a'.repeat(101) }, 'name'],
    ['a non-string name', { name: 42 }, 'name'],
    ['a description over 500 characters', { name: 'Ok', description: 'a'.repeat(501) }, 'description'],
    ['a non-string description', { name: 'Ok', description: 5 }, 'description'],
  ])('rejects %s with 400', async (_label, body, field) => {
    const { adminAuth } = await seed();
    const res = await request(app).post(CATS).set(adminAuth).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
    expect(await prisma.category.count()).toBe(3);
  });
});

// ====================================================================== update

describe('PUT /api/admin/categories/:id', () => {
  it('renames and replaces the description; isActive in the body is ignored', async () => {
    const { adminAuth, cooking } = await seed();
    await prisma.category.update({ where: { id: cooking.id }, data: { description: 'old' } });
    const res = await request(app).put(`${CATS}/${cooking.id}`).set(adminAuth).send({ name: 'Cooking & Baking', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: cooking.id, name: 'Cooking & Baking', description: null, isActive: true });
  });

  it("allows changing the letter case of the category's own name", async () => {
    const { adminAuth, cooking } = await seed();
    const res = await request(app).put(`${CATS}/${cooking.id}`).set(adminAuth).send({ name: 'COOKING' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('COOKING');
  });

  it("rejects another category's name (any case) with 409 and changes nothing", async () => {
    const { adminAuth, cooking } = await seed();
    const before = await snapshotCategories();
    const res = await request(app).put(`${CATS}/${cooking.id}`).set(adminAuth).send({ name: 'tOOLS' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(await snapshotCategories()).toEqual(before);
  });

  it('returns 404 for unknown and 400 for invalid ids or bodies', async () => {
    const { adminAuth, cooking } = await seed();
    expect((await request(app).put(`${CATS}/999999`).set(adminAuth).send({ name: 'X' })).status).toBe(404);
    expect((await request(app).put(`${CATS}/abc`).set(adminAuth).send({ name: 'X' })).status).toBe(400);
    expect((await request(app).put(`${CATS}/${cooking.id}`).set(adminAuth).send({ name: '' })).status).toBe(400);
  });
});

// ====================================================================== status

describe('PATCH /api/admin/categories/:id/status', () => {
  it('disables a category: hidden from the public list, existing published recommendations stay public, new assignments rejected', async () => {
    const { adminAuth, aliceAuth, alice, admin, cooking, tools } = await seed();
    const published = await createRecommendation(prisma, { author: alice, category: cooking, title: 'Soup tips' });
    const elsewhere = await createRecommendation(prisma, { author: alice, category: tools, title: 'Drill tips' });

    const res = await request(app).patch(`${CATS}/${cooking.id}/status`).set(adminAuth).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: cooking.id, isActive: false });
    expect(categoryLogs()).toEqual([
      expect.objectContaining({ action: 'status_change', adminUserId: admin.id, categoryId: cooking.id, previousIsActive: true, isActive: false, outcome: 'changed' }),
    ]);

    // Category and recommendation still exist.
    expect(await prisma.category.findUnique({ where: { id: cooking.id } })).not.toBeNull();
    const pubCats = await request(app).get('/api/categories');
    expect(pubCats.body.items.map((c: { name: string }) => c.name)).not.toContain('Cooking');

    expect((await request(app).get(`/api/recommendations/${published.id}`)).status).toBe(200);
    const list = await request(app).get('/api/recommendations').query({ categoryId: cooking.id });
    expect(list.body.items.map((r: { id: number }) => r.id)).toEqual([published.id]);

    // No new recommendations in it, and none can be moved into it.
    const create = await request(app).post('/api/recommendations').set(aliceAuth).send({ title: 'New', description: 'D', categoryId: cooking.id });
    expect(create.status).toBe(400);
    const move = await request(app)
      .put(`/api/recommendations/${elsewhere.id}`)
      .set(aliceAuth)
      .send({ title: 'Drill tips', description: 'D', categoryId: cooking.id });
    expect(move.status).toBe(400);
  });

  it('re-enables a category: public again and assignable', async () => {
    const { adminAuth, aliceAuth, retired } = await seed();
    const res = await request(app).patch(`${CATS}/${retired.id}/status`).set(adminAuth).send({ isActive: true });
    expect(res.body.isActive).toBe(true);
    const pubCats = await request(app).get('/api/categories');
    expect(pubCats.body.items.map((c: { name: string }) => c.name)).toContain('Retired');
    const create = await request(app).post('/api/recommendations').set(aliceAuth).send({ title: 'New', description: 'D', categoryId: retired.id });
    expect(create.status).toBe(201);
  });

  it('treats setting the current status as a no-op logged as unchanged', async () => {
    const { adminAuth, cooking } = await seed();
    const res = await request(app).patch(`${CATS}/${cooking.id}/status`).set(adminAuth).send({ isActive: true });
    expect(res.status).toBe(200);
    expect(categoryLogs()[0]).toMatchObject({ outcome: 'unchanged' });
  });

  it('ignores other fields and validates the body and id', async () => {
    const { adminAuth, cooking } = await seed();
    const ignored = await request(app).patch(`${CATS}/${cooking.id}/status`).set(adminAuth).send({ isActive: false, name: 'Hacked' });
    expect(ignored.body).toMatchObject({ name: 'Cooking', isActive: false });

    for (const body of [{}, { isActive: 'false' }, { isActive: 0 }]) {
      const res = await request(app).patch(`${CATS}/${cooking.id}/status`).set(adminAuth).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('isActive');
    }
    expect((await request(app).patch(`${CATS}/999999/status`).set(adminAuth).send({ isActive: false })).status).toBe(404);
    expect((await request(app).patch(`${CATS}/-1/status`).set(adminAuth).send({ isActive: false })).status).toBe(400);
  });

  it('logs category actions without secrets', async () => {
    const { adminAuth, cooking } = await seed();
    await request(app).post(CATS).set(adminAuth).send({ name: 'Logged' });
    await request(app).put(`${CATS}/${cooking.id}`).set(adminAuth).send({ name: 'Cooking 2' });
    await request(app).patch(`${CATS}/${cooking.id}/status`).set(adminAuth).send({ isActive: false });
    expect(categoryLogs().map((l: Record<string, unknown>) => l.action)).toEqual(['create', 'update', 'status_change']);
    expect(JSON.stringify(categoryLogs())).not.toMatch(/password|token|Bearer|@example\.com/i);
  });
});
