import express from 'express';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { authenticate, requireRole } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { hashPassword } from '../src/utils/password.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';

const prisma = createTestPrisma();
const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

const PASSWORD = 'correct-horse-battery';
const secret = new TextEncoder().encode(process.env.JWT_SECRET);

async function createUser(overrides: { email?: string; role?: 'User' | 'Admin'; isActive?: boolean } = {}) {
  return prisma.user.create({
    data: {
      fullName: 'Existing User',
      email: overrides.email ?? 'existing@example.com',
      passwordHash: await hashPassword(PASSWORD),
      role: overrides.role ?? 'User',
      isActive: overrides.isActive ?? true,
    },
  });
}

async function loginAs(email: string, password = PASSWORD) {
  return request(app).post('/api/auth/login').send({ email, password });
}

function forgeToken(sub: string, options: { key?: Uint8Array; exp?: number | string; iss?: string; aud?: string } = {}) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(options.iss ?? 'worthshare-api')
    .setAudience(options.aud ?? 'worthshare-client')
    .setIssuedAt()
    .setExpirationTime(options.exp ?? '1h')
    .sign(options.key ?? secret);
}

function expectNoSecrets(body: unknown) {
  const json = JSON.stringify(body);
  expect(json).not.toMatch(/passwordHash/i);
  expect(json).not.toMatch(/\$2[aby]\$/); // bcrypt hash prefix
  expect(json).not.toContain(PASSWORD);
}

describe('POST /api/auth/register', () => {
  const valid = { fullName: '  New Person ', email: '  New.Person@Example.COM ', password: PASSWORD };

  it('creates a regular user and returns a token with safe user data', async () => {
    const res = await request(app).post('/api/auth/register').send(valid);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 3600,
      user: { fullName: 'New Person', email: 'new.person@example.com', role: 'User' },
    });
    expect(typeof res.body.accessToken).toBe('string');
    expect(Object.keys(res.body.user).sort()).toEqual(['email', 'fullName', 'id', 'role']);
    expectNoSecrets(res.body);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: 'new.person@example.com' } });
    expect(stored.role).toBe('User');
    expect(stored.passwordHash).not.toBe(PASSWORD);
  });

  it('ignores role and status supplied by the client', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...valid, role: 'Admin', isActive: false, id: 999 });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('User');

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: 'new.person@example.com' } });
    expect(stored).toMatchObject({ role: 'User', isActive: true });
    expect(stored.id).not.toBe(999);
  });

  it('rejects a duplicate email (case-insensitive) with 409', async () => {
    await createUser({ email: 'taken@example.com' });
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...valid, email: 'TAKEN@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it.each([
    ['missing full name', { email: 'a@example.com', password: PASSWORD }, 'fullName'],
    ['blank full name', { fullName: '   ', email: 'a@example.com', password: PASSWORD }, 'fullName'],
    ['invalid email', { fullName: 'A', email: 'not-an-email', password: PASSWORD }, 'email'],
    ['short password', { fullName: 'A', email: 'a@example.com', password: 'short' }, 'password'],
    ['password over 72 bytes', { fullName: 'A', email: 'a@example.com', password: 'é'.repeat(37) }, 'password'],
    ['non-string password', { fullName: 'A', email: 'a@example.com', password: 12345678 }, 'password'],
  ])('rejects %s with 400', async (_label, body, field) => {
    const res = await request(app).post('/api/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe('POST /api/auth/login', () => {
  it('returns a token and safe user data for valid credentials', async () => {
    const user = await createUser();
    const res = await loginAs('  EXISTING@example.com ');
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: user.id,
      fullName: 'Existing User',
      email: 'existing@example.com',
      role: 'User',
    });
    expect(res.body.tokenType).toBe('Bearer');
    expect(res.body.accessToken.split('.')).toHaveLength(3);
    expectNoSecrets(res.body);
  });

  it('uses the same generic 401 for wrong password, unknown email and inactive account', async () => {
    await createUser();
    await createUser({ email: 'inactive@example.com', isActive: false });

    const responses = await Promise.all([
      loginAs('existing@example.com', 'wrong-password'),
      loginAs('nobody@example.com'),
      loginAs('inactive@example.com'),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { code: 'UNAUTHORIZED', message: 'Invalid email or password.' },
      });
    }
  });

  it('rejects malformed input with 400', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user for a valid token', async () => {
    const user = await createUser();
    const { body } = await loginAs('existing@example.com');
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: user.id, fullName: 'Existing User', email: 'existing@example.com', role: 'User' },
    });
    expectNoSecrets(res.body);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects tokens issued by a registration once the user is deactivated', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'Soon Inactive', email: 'soon@example.com', password: PASSWORD });
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    expect((await request(app).get('/api/auth/me').set(auth)).status).toBe(200);

    await prisma.user.update({ where: { email: 'soon@example.com' }, data: { isActive: false } });
    const res = await request(app).get('/api/auth/me').set(auth);
    expect(res.status).toBe(401);
  });

  it('reads the role from the database, not from the token', async () => {
    const user = await createUser();
    const { body } = await loginAs('existing@example.com');
    await prisma.user.update({ where: { id: user.id }, data: { role: 'Admin' } });

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.accessToken}`);
    expect(res.body.user.role).toBe('Admin');
  });

  it.each([
    ['a non-Bearer scheme', async () => 'Basic abc'],
    ['a malformed token', async () => 'Bearer not.a.jwt!'],
    ['a token signed with another secret', async (id: number) =>
      `Bearer ${await forgeToken(String(id), { key: new TextEncoder().encode('x'.repeat(48)) })}`],
    ['an expired token', async (id: number) =>
      `Bearer ${await forgeToken(String(id), { exp: Math.floor(Date.now() / 1000) - 60 })}`],
    ['a wrong issuer', async (id: number) => `Bearer ${await forgeToken(String(id), { iss: 'evil' })}`],
    ['a wrong audience', async (id: number) => `Bearer ${await forgeToken(String(id), { aud: 'evil' })}`],
    ['a non-numeric subject', async () => `Bearer ${await forgeToken('admin')}`],
    ['a token for a user that does not exist', async () => `Bearer ${await forgeToken('999999')}`],
    ['an unsigned (alg: none) token', async (id: number) => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `Bearer ${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: String(id), iss: 'worthshare-api', aud: 'worthshare-client', exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
    }],
  ])('rejects %s with 401', async (_label, makeHeader) => {
    const user = await createUser();
    const res = await request(app).get('/api/auth/me').set('Authorization', await makeHeader(user.id));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('requireRole', () => {
  const guarded = express();
  guarded.get('/admin-only', authenticate, requireRole('Admin'), (_req, res) => {
    res.json({ ok: true });
  });
  guarded.use(errorHandler);

  async function tokenFor(role: 'User' | 'Admin') {
    await createUser({ email: `${role.toLowerCase()}@example.com`, role });
    const { body } = await loginAs(`${role.toLowerCase()}@example.com`);
    return `Bearer ${body.accessToken}`;
  }

  it('returns 401 without a token', async () => {
    expect((await request(guarded).get('/admin-only')).status).toBe(401);
  });

  it('returns 403 for an authenticated regular user', async () => {
    const res = await request(guarded).get('/admin-only').set('Authorization', await tokenFor('User'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows an administrator', async () => {
    const res = await request(guarded).get('/admin-only').set('Authorization', await tokenFor('Admin'));
    expect(res.status).toBe(200);
  });
});
