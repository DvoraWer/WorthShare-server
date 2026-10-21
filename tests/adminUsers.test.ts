import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';
import { authHeader, createCategory, createUser } from './helpers/fixtures.js';

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

const USERS = '/api/admin/users';
const USER_KEYS = ['createdAt', 'email', 'fullName', 'id', 'isActive', 'role', 'updatedAt'];

function userLogs() {
  return infoSpy.mock.calls
    .map((args: unknown[]) => JSON.parse(String(args[0])) as Record<string, unknown>)
    .filter((entry: Record<string, unknown>) => entry.event === 'user.admin_action');
}

const setRole = async (actor: { id: number } | null, id: number | string, body: unknown) => {
  const req = request(app).patch(`${USERS}/${id}/role`);
  return (actor ? req.set(await authHeader(actor)) : req).send(body as object);
};
const setStatus = async (actor: { id: number } | null, id: number | string, body: unknown) => {
  const req = request(app).patch(`${USERS}/${id}/status`);
  return (actor ? req.set(await authHeader(actor)) : req).send(body as object);
};

const snapshotUsers = () => prisma.user.findMany({ orderBy: { id: 'asc' } });
const activeAdminCount = () => prisma.user.count({ where: { role: 'Admin', isActive: true } });

async function seedUsers() {
  const admin = await createUser(prisma, { fullName: 'Ada Admin', email: 'ada@example.com', role: 'Admin' });
  const alice = await createUser(prisma, { fullName: 'Alice Smith', email: 'alice@example.com' });
  const bob = await createUser(prisma, { fullName: 'Bob Jones', email: 'bob.jones@sample.org' });
  return { admin, alice, bob };
}

// ====================================================================== authorization

describe('authorization (all user-admin endpoints are admin-only)', () => {
  it('returns 401 without a token and 403 for regular users, changing nothing', async () => {
    const { alice, bob } = await seedUsers();
    const before = await snapshotUsers();

    expect((await request(app).get(USERS)).status).toBe(401);
    expect((await setRole(null, bob.id, { role: 'Admin' })).status).toBe(401);
    expect((await setStatus(null, bob.id, { isActive: false })).status).toBe(401);

    const auth = await authHeader(alice);
    expect((await request(app).get(USERS).set(auth)).status).toBe(403);
    // A regular user cannot promote themselves or anyone else.
    expect((await setRole(alice, alice.id, { role: 'Admin' })).status).toBe(403);
    expect((await setStatus(alice, bob.id, { isActive: false })).status).toBe(403);

    expect(await snapshotUsers()).toEqual(before);
  });

  it('immediately revokes admin access from a demoted or deactivated admin', async () => {
    const { admin } = await seedUsers();
    const second = await createUser(prisma, { email: 'second@example.com', role: 'Admin' });
    const third = await createUser(prisma, { email: 'third@example.com', role: 'Admin' });
    const secondAuth = await authHeader(second);
    const thirdAuth = await authHeader(third);

    expect((await request(app).get(USERS).set(secondAuth)).status).toBe(200);
    expect((await setRole(admin, second.id, { role: 'User' })).status).toBe(200);
    expect((await request(app).get(USERS).set(secondAuth)).status).toBe(403);

    expect((await setStatus(admin, third.id, { isActive: false })).status).toBe(200);
    expect((await request(app).get(USERS).set(thirdAuth)).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(thirdAuth)).status).toBe(401);
  });
});

// ====================================================================== listing

describe('GET /api/admin/users', () => {
  it('lists users with safe fields only, oldest first, with the list envelope', async () => {
    const { admin, alice, bob } = await seedUsers();
    const res = await request(app).get(USERS).set(await authHeader(admin));
    expect(res.status).toBe(200);
    expect(res.body.items.map((u: { id: number }) => u.id)).toEqual([admin.id, alice.id, bob.id]);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 10, totalItems: 3, totalPages: 1 });
    for (const user of res.body.items) expect(Object.keys(user).sort()).toEqual(USER_KEYS);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$|test-password/);
  });

  it('searches full name and email case-insensitively and literally', async () => {
    const { admin, alice, bob } = await seedUsers();
    const auth = await authHeader(admin);
    const ids = async (search: string) =>
      (await request(app).get(USERS).query({ search }).set(auth)).body.items.map((u: { id: number }) => u.id);

    expect(await ids('SMITH')).toEqual([alice.id]);
    expect(await ids('sample.ORG')).toEqual([bob.id]);
    expect(await ids('example.com')).toEqual([admin.id, alice.id]);
    expect(await ids('%')).toEqual([]);
    expect(await ids('_')).toEqual([]);
  });

  it('paginates and validates query parameters', async () => {
    const { admin } = await seedUsers();
    const auth = await authHeader(admin);
    const page2 = await request(app).get(USERS).query({ page: 2, pageSize: 2 }).set(auth);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.pagination).toEqual({ page: 2, pageSize: 2, totalItems: 3, totalPages: 2 });
    for (const query of [{ pageSize: 51 }, { page: 0 }, { page: 'x' }, { search: 'a'.repeat(101) }]) {
      const res = await request(app).get(USERS).query(query).set(auth);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

// ====================================================================== role and status changes

describe('PATCH /api/admin/users/:id/role and /status', () => {
  it('promotes a user to Admin; the new role is read from the database on their next request', async () => {
    const { admin, alice } = await seedUsers();
    const aliceAuth = await authHeader(alice); // token issued while still a regular user
    expect((await request(app).get(USERS).set(aliceAuth)).status).toBe(403);

    const res = await setRole(admin, alice.id, { role: 'Admin' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(USER_KEYS);
    expect(res.body).toMatchObject({ id: alice.id, role: 'Admin', isActive: true });
    expect((await request(app).get(USERS).set(aliceAuth)).status).toBe(200);
  });

  it('deactivates and reactivates a user: tokens and login stop working, then work again', async () => {
    const { admin, alice } = await seedUsers();
    const aliceAuth = await authHeader(alice);

    expect((await setStatus(admin, alice.id, { isActive: false })).body).toMatchObject({ isActive: false, role: 'User' });
    expect((await request(app).get('/api/auth/me').set(aliceAuth)).status).toBe(401);
    const login = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'test-password' });
    expect(login.status).toBe(401);
    expect(login.body.error.message).toBe('Invalid email or password.');

    expect((await setStatus(admin, alice.id, { isActive: true })).body.isActive).toBe(true);
    expect((await request(app).get('/api/auth/me').set(aliceAuth)).status).toBe(200);
  });

  it('lets one of several active admins be demoted or deactivated by another', async () => {
    const { admin } = await seedUsers();
    const second = await createUser(prisma, { email: 'second@example.com', role: 'Admin' });
    const third = await createUser(prisma, { email: 'third@example.com', role: 'Admin' });

    expect((await setRole(admin, second.id, { role: 'User' })).status).toBe(200);
    expect((await setStatus(admin, third.id, { isActive: false })).status).toBe(200);
    expect(await activeAdminCount()).toBe(1);
  });

  it('allows changes to inactive admins (they are not active admins)', async () => {
    const { admin } = await seedUsers();
    const dormant = await createUser(prisma, { email: 'dormant@example.com', role: 'Admin', isActive: false });
    expect((await setRole(admin, dormant.id, { role: 'User' })).status).toBe(200);
  });

  it('treats a request for the current value as a no-op (200, logged as unchanged)', async () => {
    const { admin, alice } = await seedUsers();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect((await setRole(admin, alice.id, { role: 'User' })).status).toBe(200);
    expect((await setStatus(admin, alice.id, { isActive: true })).status).toBe(200);
    // An admin re-affirming their own role/status is not a demotion.
    expect((await setRole(admin, admin.id, { role: 'Admin' })).status).toBe(200);
    expect((await setStatus(admin, admin.id, { isActive: true })).status).toBe(200);

    expect(await prisma.user.findUniqueOrThrow({ where: { id: alice.id } })).toEqual(before);
    expect(userLogs().map((l: Record<string, unknown>) => l.outcome)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
  });

  it('ignores privileged fields sent to the other endpoint', async () => {
    const { admin, alice } = await seedUsers();
    // Status endpoint must not change the role, and vice versa.
    await setStatus(admin, alice.id, { isActive: true, role: 'Admin' });
    await setRole(admin, alice.id, { role: 'User', isActive: false, passwordHash: 'x', email: 'evil@example.com' });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(stored).toMatchObject({ role: 'User', isActive: true, email: 'alice@example.com' });
    expect(stored.passwordHash).not.toBe('x');
  });

  it('never lets registration or unrelated endpoints set role or status', async () => {
    const { alice } = await seedUsers();
    const cooking = await createCategory(prisma, { name: 'Cooking' });

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'Mallory', email: 'mallory@example.com', password: 'long-enough-password', role: 'Admin', isActive: false });
    expect(reg.status).toBe(201);
    expect(await prisma.user.findUniqueOrThrow({ where: { email: 'mallory@example.com' } })).toMatchObject({ role: 'User', isActive: true });

    const rec = await request(app)
      .post('/api/recommendations')
      .set(await authHeader(alice))
      .send({ title: 'T', description: 'D', categoryId: cooking.id, role: 'Admin', isActive: false, createdBy: { role: 'Admin' } });
    expect(rec.status).toBe(201);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: alice.id } })).toMatchObject({ role: 'User', isActive: true });
  });

  it.each([
    ['an unknown role', 'role', { role: 'SuperAdmin' }],
    ['a lowercase role', 'role', { role: 'admin' }],
    ['a missing role', 'role', {}],
    ['isActive as a string', 'status', { isActive: 'false' }],
    ['a missing isActive', 'status', {}],
  ] as const)('rejects %s with 400', async (_label, endpoint, body) => {
    const { admin, alice } = await seedUsers();
    const before = await snapshotUsers();
    const res = endpoint === 'role' ? await setRole(admin, alice.id, body) : await setStatus(admin, alice.id, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await snapshotUsers()).toEqual(before);
  });

  it('returns 400 for invalid ids and 404 for unknown users', async () => {
    const { admin } = await seedUsers();
    expect((await setRole(admin, 'abc', { role: 'User' })).status).toBe(400);
    expect((await setStatus(admin, '0', { isActive: false })).status).toBe(400);
    expect((await setRole(admin, 999999, { role: 'User' })).status).toBe(404);
    expect((await setStatus(admin, 999999, { isActive: false })).status).toBe(404);
  });
});

// ====================================================================== safeguards

describe('administrative safeguards', () => {
  it('rejects self-demotion and self-deactivation with 409, even when other admins exist', async () => {
    const { admin } = await seedUsers();
    await createUser(prisma, { email: 'other-admin@example.com', role: 'Admin' });
    const before = await snapshotUsers();

    const demote = await setRole(admin, admin.id, { role: 'User' });
    expect(demote.status).toBe(409);
    expect(demote.body.error).toEqual({ code: 'CONFLICT', message: 'You cannot demote your own account.' });

    const deactivate = await setStatus(admin, admin.id, { isActive: false });
    expect(deactivate.status).toBe(409);
    expect(deactivate.body.error).toEqual({ code: 'CONFLICT', message: 'You cannot deactivate your own account.' });

    expect(await snapshotUsers()).toEqual(before);
    expect(userLogs()).toEqual([
      expect.objectContaining({ action: 'role_change', outcome: 'rejected', reason: 'self_demotion', adminUserId: admin.id, targetUserId: admin.id }),
      expect.objectContaining({ action: 'status_change', outcome: 'rejected', reason: 'self_deactivation' }),
    ]);
  });

  it('keeps the sole (last) active admin: it cannot be demoted or deactivated', async () => {
    const { admin } = await seedUsers();
    await createUser(prisma, { email: 'inactive-admin@example.com', role: 'Admin', isActive: false });
    expect(await activeAdminCount()).toBe(1);

    expect((await setRole(admin, admin.id, { role: 'User' })).status).toBe(409);
    expect((await setStatus(admin, admin.id, { isActive: false })).status).toBe(409);
    expect(await activeAdminCount()).toBe(1);
  });

  // The in-transaction re-check of the acting admin is only reachable in a real
  // race (the auth middleware already rejects stale admins between requests);
  // the simultaneous-request tests below exercise it.
  it.each([
    ['deactivate each other', 'status'],
    ['demote each other', 'role'],
    ['one demotes, one deactivates', 'mixed'],
  ] as const)('never leaves zero active admins when two admins %s simultaneously', async (_label, mode) => {
    for (let round = 0; round < 5; round++) {
      await resetDatabase(prisma);
      const a = await createUser(prisma, { email: `a${round}@example.com`, role: 'Admin' });
      const b = await createUser(prisma, { email: `b${round}@example.com`, role: 'Admin' });

      const aToB = mode === 'role' || mode === 'mixed' ? setRole(a, b.id, { role: 'User' }) : setStatus(a, b.id, { isActive: false });
      const bToA = mode === 'role' ? setRole(b, a.id, { role: 'User' }) : setStatus(b, a.id, { isActive: false });
      const results = await Promise.all([aToB, bToA]);

      expect(await activeAdminCount()).toBe(1);
      // Exactly one wins. The loser is refused either by authentication (401:
      // already deactivated / 403: already demoted when its request arrived)
      // or by the in-transaction re-check of the acting admin (403).
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect([401, 403]).toContain(statuses.find((s) => s !== 200));
    }
  });

  it('never leaves zero active admins when three admins each target the next simultaneously', async () => {
    for (let round = 0; round < 5; round++) {
      await resetDatabase(prisma);
      const admins = await Promise.all(
        [0, 1, 2].map((i) => createUser(prisma, { email: `admin${i}-${round}@example.com`, role: 'Admin' })),
      );
      const results = await Promise.all(
        admins.map((actor, i) => setStatus(actor, admins[(i + 1) % 3]!.id, { isActive: false })),
      );
      expect(await activeAdminCount()).toBeGreaterThanOrEqual(1);
      // Every success removed exactly one active admin.
      expect(await activeAdminCount()).toBe(3 - results.filter((r) => r.status === 200).length);
    }
  });
});

// ====================================================================== audit logging

describe('audit logging', () => {
  it('records actor, target, action and outcome for role and status changes, without secrets', async () => {
    const { admin, alice } = await seedUsers();
    await setRole(admin, alice.id, { role: 'Admin' });
    await setStatus(admin, alice.id, { isActive: false });

    expect(userLogs()).toEqual([
      expect.objectContaining({ level: 'info', action: 'role_change', adminUserId: admin.id, targetUserId: alice.id, outcome: 'changed', previousRole: 'User', role: 'Admin' }),
      expect.objectContaining({ action: 'status_change', adminUserId: admin.id, targetUserId: alice.id, outcome: 'changed', previousIsActive: true, isActive: false }),
    ]);
    const text = JSON.stringify(userLogs());
    expect(text).not.toMatch(/password|token|Bearer|\$2[aby]\$|@example\.com/i);
    for (const entry of userLogs()) expect(entry.time).toEqual(expect.any(String));
  });

  it('does not log anything for requests rejected by authorization or validation', async () => {
    const { admin, alice } = await seedUsers();
    await setRole(alice, admin.id, { role: 'User' });
    await setRole(admin, alice.id, { role: 'Owner' });
    expect(userLogs()).toEqual([]);
  });
});
