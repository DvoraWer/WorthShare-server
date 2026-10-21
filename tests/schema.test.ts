import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPrisma, resetDatabase } from './helpers/db.js';

const prisma = createTestPrisma();

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

async function makeUser(email = 'user@example.com') {
  return prisma.user.create({ data: { fullName: 'Test User', email, passwordHash: 'x' } });
}

async function makeCategory(name = 'Education', isActive = true) {
  return prisma.category.create({ data: { name, isActive } });
}

const DISCLOSURE = { sponsorName: 'Acme', productName: 'Acme Drill', sponsorshipType: 'FreeProduct' } as const;

// Declared rows get disclosure details unless the test sets them itself.
async function makeRecommendation(overrides: Record<string, unknown> = {}) {
  const disclosure = overrides.declaresSponsored === true ? DISCLOSURE : {};
  const user = await makeUser(`author-${Math.random().toString(36).slice(2)}@example.com`);
  const category = await makeCategory(`Cat ${Math.random().toString(36).slice(2)}`);
  return prisma.recommendation.create({
    data: {
      title: 'Title',
      description: 'Description',
      categoryId: category.id,
      createdByUserId: user.id,
      ...disclosure,
      ...overrides,
    },
  });
}

describe('defaults', () => {
  it('new users default to role User and active', async () => {
    const user = await makeUser();
    expect(user.role).toBe('User');
    expect(user.isActive).toBe(true);
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  it('new recommendations default to Published and not sponsored', async () => {
    const rec = await makeRecommendation();
    expect(rec.status).toBe('Published');
    expect(rec.isSponsored).toBe(false);
    expect(rec.reviewedByUserId).toBeNull();
  });
});

describe('uniqueness', () => {
  it('rejects duplicate emails', async () => {
    await makeUser('same@example.com');
    await expect(makeUser('same@example.com')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects category names that differ only by case', async () => {
    await makeCategory('Cooking Tips');
    await expect(makeCategory('cooking TIPS')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('finds categories by name case-insensitively', async () => {
    const created = await makeCategory('Digital Tools');
    const found = await prisma.category.findUnique({ where: { name: 'DIGITAL tools' } });
    expect(found?.id).toBe(created.id);
  });
});

describe('check constraints', () => {
  it('requires emails to be stored normalized', async () => {
    await expect(makeUser('Mixed.Case@Example.com')).rejects.toThrow(/users_email_normalized/);
  });

  it('rejects blank full names, titles and category names', async () => {
    await expect(
      prisma.user.create({ data: { fullName: '   ', email: 'a@example.com', passwordHash: 'x' } }),
    ).rejects.toThrow(/users_fullName_not_blank/);
    await expect(makeCategory('  ')).rejects.toThrow(/categories_name_not_blank/);
    await expect(makeRecommendation({ title: ' ' })).rejects.toThrow(
      /recommendations_title_not_blank/,
    );
  });

  it('enforces maximum title and description lengths', async () => {
    await expect(makeRecommendation({ title: 'a'.repeat(121) })).rejects.toThrow();
    await expect(makeRecommendation({ description: 'a'.repeat(3001) })).rejects.toThrow();
    await expect(
      makeRecommendation({ title: 'a'.repeat(120), description: 'a'.repeat(3000) }),
    ).resolves.toBeDefined();
  });

  it('only allows http and https URLs', async () => {
    await expect(makeRecommendation({ url: 'ftp://example.com' })).rejects.toThrow(
      /recommendations_url_http/,
    );
    await expect(makeRecommendation({ imageUrl: 'javascript:alert(1)' })).rejects.toThrow(
      /recommendations_imageUrl_http/,
    );
    await expect(
      makeRecommendation({ url: 'https://example.com', imageUrl: 'http://example.com/a.png' }),
    ).resolves.toBeDefined();
  });

  it('does not allow a sponsored flag on pending or rejected recommendations', async () => {
    // declaresSponsored: true so only the constraint under test is violated.
    await expect(
      makeRecommendation({ status: 'PendingSponsoredApproval', isSponsored: true, declaresSponsored: true }),
    ).rejects.toThrow(/recommendations_sponsored_status/);
    await expect(
      makeRecommendation({ status: 'Rejected', isSponsored: true, declaresSponsored: true }),
    ).rejects.toThrow(/recommendations_sponsored_status/);
  });

  describe('sponsorship disclosure', () => {
    it('never lets a declared-sponsored recommendation be public without the sponsored label', async () => {
      await expect(
        makeRecommendation({ status: 'Published', isSponsored: false, declaresSponsored: true }),
      ).rejects.toThrow(/recommendations_published_disclosure/);
    });

    it('never shows a sponsored label that the owner did not declare', async () => {
      await expect(
        makeRecommendation({ status: 'Published', isSponsored: true, declaresSponsored: false }),
      ).rejects.toThrow(/recommendations_approved_implies_declared|recommendations_published_disclosure/);
    });

    it('requires pending and rejected recommendations to be declared sponsored', async () => {
      await expect(
        makeRecommendation({ status: 'PendingSponsoredApproval', declaresSponsored: false }),
      ).rejects.toThrow(/recommendations_review_states_declared/);
      await expect(makeRecommendation({ status: 'Rejected', declaresSponsored: false })).rejects.toThrow(
        /recommendations_review_states_declared/,
      );
    });

    it('blocks turning a rejected recommendation public by changing only its status', async () => {
      const rec = await makeRecommendation({ status: 'Rejected', declaresSponsored: true });
      await expect(
        prisma.recommendation.update({ where: { id: rec.id }, data: { status: 'Published' } }),
      ).rejects.toThrow(/recommendations_published_disclosure/);
    });

    it('requires disclosure details on every declared-sponsored recommendation', async () => {
      for (const missing of ['sponsorName', 'productName', 'sponsorshipType']) {
        await expect(
          makeRecommendation({ status: 'PendingSponsoredApproval', declaresSponsored: true, [missing]: null }),
        ).rejects.toThrow(/recommendations_disclosure_details/);
      }
    });

    it('does not keep disclosure details without a declaration', async () => {
      await expect(makeRecommendation({ status: 'Published', sponsorName: 'Acme' })).rejects.toThrow(
        /recommendations_disclosure_details/,
      );
      await expect(makeRecommendation({ status: 'Published', disclosureDetails: 'Some details' })).rejects.toThrow(
        /recommendations_disclosure_details/,
      );
    });

    it('requires details when the relationship is Other', async () => {
      await expect(
        makeRecommendation({ status: 'PendingSponsoredApproval', declaresSponsored: true, sponsorshipType: 'Other' }),
      ).rejects.toThrow(/recommendations_other_requires_details/);
      await expect(
        makeRecommendation({ status: 'PendingSponsoredApproval', declaresSponsored: true, sponsorshipType: 'Other', disclosureDetails: '  ' }),
      ).rejects.toThrow(/recommendations_other_requires_details/);
      await expect(
        makeRecommendation({ status: 'PendingSponsoredApproval', declaresSponsored: true, sponsorshipType: 'Other', disclosureDetails: 'A friend owns the shop.' }),
      ).resolves.toBeDefined();
    });

    it('rejects blank sponsor and product names', async () => {
      await expect(
        makeRecommendation({ status: 'PendingSponsoredApproval', declaresSponsored: true, sponsorName: '  ' }),
      ).rejects.toThrow(/recommendations_sponsorName_not_blank/);
      await expect(
        makeRecommendation({ status: 'PendingSponsoredApproval', declaresSponsored: true, productName: '  ' }),
      ).rejects.toThrow(/recommendations_productName_not_blank/);
    });

    it('allows the valid combinations', async () => {
      await expect(makeRecommendation({ status: 'Published' })).resolves.toBeDefined();
      await expect(
        makeRecommendation({ status: 'PendingSponsoredApproval', declaresSponsored: true }),
      ).resolves.toBeDefined();
      await expect(
        makeRecommendation({ status: 'Removed', isSponsored: true, declaresSponsored: true }),
      ).resolves.toBeDefined();
    });
  });

  it('requires reviewer and review time to be set together', async () => {
    await expect(makeRecommendation({ reviewedAt: new Date() })).rejects.toThrow(
      /recommendations_review_pair/,
    );
  });
});

describe('relations', () => {
  it('cannot physically delete a category referenced by recommendations', async () => {
    const rec = await makeRecommendation();
    await expect(prisma.category.delete({ where: { id: rec.categoryId } })).rejects.toThrow();
  });

  it('cannot physically delete a user who authored recommendations', async () => {
    const rec = await makeRecommendation();
    await expect(prisma.user.delete({ where: { id: rec.createdByUserId } })).rejects.toThrow();
  });

  it('rejects recommendations pointing to a missing category', async () => {
    const user = await makeUser();
    await expect(
      prisma.recommendation.create({
        data: { title: 'T', description: 'D', categoryId: 9999, createdByUserId: user.id },
      }),
    ).rejects.toThrow();
  });
});
