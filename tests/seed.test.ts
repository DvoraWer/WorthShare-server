import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseSeedConfig, runSeed, type SeedConfig } from '../prisma/seed.js';
import { verifyPassword } from '../src/utils/password.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';

const prisma = createTestPrisma();

const config: SeedConfig = parseSeedConfig({
  SEED_ADMIN_EMAIL: '  Admin@Example.com ',
  SEED_ADMIN_PASSWORD: 'admin-test-password',
  SEED_DEMO_USER_PASSWORD: 'demo-test-password',
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

describe('seed configuration', () => {
  it('requires admin credentials from the environment', () => {
    expect(() => parseSeedConfig({})).toThrow(/SEED_ADMIN_EMAIL/);
    expect(() =>
      parseSeedConfig({
        SEED_ADMIN_EMAIL: 'admin@example.com',
        SEED_ADMIN_PASSWORD: 'short',
        SEED_DEMO_USER_PASSWORD: 'demo-test-password',
      }),
    ).toThrow(/SEED_ADMIN_PASSWORD/);
  });

  it('normalizes the admin email', () => {
    expect(config.SEED_ADMIN_EMAIL).toBe('admin@example.com');
  });
});

describe('runSeed', () => {
  it('creates the data required by the spec', async () => {
    const summary = await runSeed(prisma, config);
    expect(summary.users.created).toBe(4);

    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } });
    expect(admin.role).toBe('Admin');
    expect(admin.isActive).toBe(true);
    expect(admin.passwordHash).not.toBe(config.SEED_ADMIN_PASSWORD);
    expect(await verifyPassword(config.SEED_ADMIN_PASSWORD, admin.passwordHash)).toBe(true);

    expect(await prisma.user.count({ where: { role: 'User' } })).toBeGreaterThanOrEqual(2);
    expect(await prisma.category.count({ where: { isActive: true } })).toBeGreaterThanOrEqual(2);
    expect(await prisma.category.count({ where: { isActive: false } })).toBeGreaterThanOrEqual(1);

    expect(
      await prisma.recommendation.count({ where: { status: 'Published', isSponsored: false } }),
    ).toBeGreaterThanOrEqual(2);

    const sponsored = await prisma.recommendation.findMany({
      where: { status: 'Published', isSponsored: true },
    });
    expect(sponsored).toHaveLength(1);
    expect(sponsored[0]?.declaresSponsored).toBe(true);
    expect(
      await prisma.recommendation.count({ where: { status: 'Published', isSponsored: false, declaresSponsored: true } }),
    ).toBe(0);
    expect(sponsored[0]?.reviewedByUserId).toBe(admin.id);
    expect(sponsored[0]?.reviewedAt).toBeInstanceOf(Date);

    const pending = await prisma.recommendation.findMany({
      where: { status: 'PendingSponsoredApproval' },
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.isSponsored).toBe(false);
    expect(pending[0]?.declaresSponsored).toBe(true);

    const rejected = await prisma.recommendation.findMany({ where: { status: 'Rejected' } });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.isSponsored).toBe(false);
    expect(rejected[0]?.declaresSponsored).toBe(true);
    expect(rejected[0]?.reviewedByUserId).toBe(admin.id);
    expect(rejected[0]?.rejectionReason).toBeTruthy();

    // Every declared-sponsored demo row carries its disclosure.
    for (const rec of [...sponsored, ...pending, ...rejected]) {
      expect(rec.sponsorName).toBeTruthy();
      expect(rec.productName).toBeTruthy();
      expect(rec.sponsorshipType).toBeTruthy();
    }
  });

  it('is idempotent: a second run creates nothing', async () => {
    await runSeed(prisma, config);
    const counts = async () => ({
      users: await prisma.user.count(),
      categories: await prisma.category.count(),
      recommendations: await prisma.recommendation.count(),
    });
    const before = await counts();

    const second = await runSeed(prisma, config);
    expect(second.users.created).toBe(0);
    expect(second.categories.created).toBe(0);
    expect(second.recommendations.created).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it('does not overwrite existing user or category data', async () => {
    await prisma.user.create({
      data: {
        fullName: 'Existing Person',
        email: 'admin@example.com',
        passwordHash: 'existing-hash',
        role: 'User',
      },
    });
    await prisma.category.create({ data: { name: 'לימודים', description: 'mine', isActive: false } });

    await runSeed(prisma, config);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } });
    expect(user).toMatchObject({
      fullName: 'Existing Person',
      passwordHash: 'existing-hash',
      role: 'User',
    });
    const category = await prisma.category.findUniqueOrThrow({ where: { name: 'לימודים' } });
    expect(category).toMatchObject({ name: 'לימודים', description: 'mine', isActive: false });
  });
});
