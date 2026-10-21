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

const BASE = '/api/admin/recommendations';
const approveUrl = (id: number) => `${BASE}/${id}/approve-sponsored`;
const rejectUrl = (id: number) => `${BASE}/${id}/reject-sponsored`;

function reviewLogs() {
  return infoSpy.mock.calls
    .map((args: unknown[]) => JSON.parse(String(args[0])) as Record<string, unknown>)
    .filter((entry: Record<string, unknown>) => entry.event === 'recommendation.sponsored_review');
}

async function seedWorld() {
  const alice = await createUser(prisma, { fullName: 'Alice Author', email: 'alice@example.com' });
  const bob = await createUser(prisma, { fullName: 'Bob Other', email: 'bob@example.com' });
  const admin = await createUser(prisma, { fullName: 'Ada Admin', email: 'admin@example.com', role: 'Admin' });
  const admin2 = await createUser(prisma, { fullName: 'Second Admin', email: 'admin2@example.com', role: 'Admin' });
  const cooking = await createCategory(prisma, { name: 'Cooking' });
  const recs = {
    pendingA: await createRecommendation(prisma, { author: alice, category: cooking, state: 'pending', title: 'Alice pending' }),
    pendingB: await createRecommendation(prisma, { author: bob, category: cooking, state: 'pending', title: 'Bob pending' }),
    published: await createRecommendation(prisma, { author: alice, category: cooking, title: 'Alice regular' }),
    sponsored: await createRecommendation(prisma, { author: alice, category: cooking, state: 'sponsored', reviewer: admin, title: 'Alice sponsored' }),
    rejected: await createRecommendation(prisma, { author: alice, category: cooking, state: 'rejected', reviewer: admin, title: 'Alice rejected' }),
    removed: await createRecommendation(prisma, { author: alice, category: cooking, state: 'removed', title: 'Alice removed' }),
  };
  return { alice, bob, admin, admin2, cooking, recs };
}

const snapshot = (id: number) => prisma.recommendation.findUniqueOrThrow({ where: { id } });
/** The version an admin reviews: the recommendation's current updatedAt (as listed by the API). */
const versionOf = async (id: number) => (await snapshot(id)).updatedAt.toISOString();

// ====================================================================== authorization

describe('authorization (all review endpoints are admin-only)', () => {
  const calls = (id: number) => [
    ['GET pending list', () => request(app).get(`${BASE}/pending-sponsored`)],
    ['PUT approve', () => request(app).put(approveUrl(id)).send({ expectedUpdatedAt: new Date().toISOString() })],
    ['PUT reject', () => request(app).put(rejectUrl(id)).send({ rejectionReason: 'no', expectedUpdatedAt: new Date().toISOString() })],
  ] as const;

  it('returns 401 without a token', async () => {
    const { recs } = await seedWorld();
    for (const [, call] of calls(recs.pendingA.id)) expect((await call()).status).toBe(401);
  });

  it('returns 403 for regular users, including the owner of the request', async () => {
    const { alice, bob, recs } = await seedWorld();
    for (const user of [alice, bob]) {
      const auth = await authHeader(user);
      for (const [, call] of calls(recs.pendingA.id)) {
        const res = await call().set(auth);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    }
    expect((await snapshot(recs.pendingA.id)).status).toBe('PendingSponsoredApproval');
  });

  it('rejects an admin token once the admin is deactivated (401) or demoted (403)', async () => {
    const { admin, admin2, recs } = await seedWorld();
    const deactivated = await authHeader(admin);
    const demoted = await authHeader(admin2);
    await prisma.user.update({ where: { id: admin.id }, data: { isActive: false } });
    await prisma.user.update({ where: { id: admin2.id }, data: { role: 'User' } });

    const expectedUpdatedAt = await versionOf(recs.pendingA.id);
    expect((await request(app).put(approveUrl(recs.pendingA.id)).set(deactivated).send({ expectedUpdatedAt })).status).toBe(401);
    expect((await request(app).put(approveUrl(recs.pendingA.id)).set(demoted).send({ expectedUpdatedAt })).status).toBe(403);
    expect((await snapshot(recs.pendingA.id)).status).toBe('PendingSponsoredApproval');
  });
});

// ====================================================================== listing

describe('GET /api/admin/recommendations/pending-sponsored', () => {
  it('lists pending requests from all users, oldest first, with admin fields and the list envelope', async () => {
    const { admin, recs } = await seedWorld();
    // Make Bob's request older than Alice's.
    await prisma.recommendation.update({ where: { id: recs.pendingB.id }, data: { updatedAt: new Date('2026-01-01T00:00:00Z') } });

    const res = await request(app).get(`${BASE}/pending-sponsored`).set(await authHeader(admin));
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { id: number }) => r.id)).toEqual([recs.pendingB.id, recs.pendingA.id]);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 10, totalItems: 2, totalPages: 1 });
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      ['author', 'category', 'createdAt', 'declaresSponsored', 'description', 'disclosure', 'id', 'imageUrl', 'isSponsored', 'rejectionReason', 'reviewedAt', 'reviewedBy', 'status', 'title', 'updatedAt', 'url'],
    );
    expect(res.body.items[0]).toMatchObject({ status: 'PendingSponsoredApproval', isSponsored: false, declaresSponsored: true, reviewedBy: null });
    // The admin reviews the full disclosure.
    expect(res.body.items[0].disclosure).toEqual(FIXTURE_DISCLOSURE);
    expect(JSON.stringify(res.body)).not.toMatch(/@example\.com|passwordHash/);
  });

  it('paginates and validates query parameters', async () => {
    const { admin } = await seedWorld();
    const auth = await authHeader(admin);
    const page2 = await request(app).get(`${BASE}/pending-sponsored`).query({ page: 2, pageSize: 1 }).set(auth);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.pagination).toEqual({ page: 2, pageSize: 1, totalItems: 2, totalPages: 2 });
    expect((await request(app).get(`${BASE}/pending-sponsored`).query({ pageSize: 51 }).set(auth)).status).toBe(400);
    expect((await request(app).get(`${BASE}/pending-sponsored`).query({ page: 0 }).set(auth)).status).toBe(400);
  });
});

// ====================================================================== approve

describe('PUT /api/admin/recommendations/:id/approve-sponsored', () => {
  it('publishes with the sponsored label and records the reviewer and server timestamp', async () => {
    const { admin, alice, recs } = await seedWorld();
    const before = Date.now();
    const res = await request(app)
      .put(approveUrl(recs.pendingA.id))
      .set(await authHeader(admin))
      // Client-supplied outcome and reviewer are ignored.
      .send({
        expectedUpdatedAt: await versionOf(recs.pendingA.id),
        isSponsored: false,
        status: 'Rejected',
        reviewedByUserId: alice.id,
        reviewedAt: '2000-01-01T00:00:00Z',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: recs.pendingA.id,
      status: 'Published',
      isSponsored: true,
      declaresSponsored: true,
      rejectionReason: null,
      reviewedBy: { id: admin.id, fullName: 'Ada Admin' },
    });

    const stored = await snapshot(recs.pendingA.id);
    expect(stored).toMatchObject({ status: 'Published', isSponsored: true, declaresSponsored: true, reviewedByUserId: admin.id, rejectionReason: null });
    expect(stored.reviewedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(stored.reviewedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // Publicly visible with the label; no longer in the queue; owner sees it.
    const pub = await request(app).get(`/api/recommendations/${recs.pendingA.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.isSponsored).toBe(true);
    // The label only: the disclosure stays with the owner and admins.
    expect(pub.body).not.toHaveProperty('disclosure');
    const queue = await request(app).get(`${BASE}/pending-sponsored`).set(await authHeader(admin));
    expect(queue.body.items.map((r: { id: number }) => r.id)).not.toContain(recs.pendingA.id);
    const mine = await request(app).get('/api/recommendations/mine').set(await authHeader(alice));
    expect(mine.body.items.find((r: { id: number }) => r.id === recs.pendingA.id)).toMatchObject({ status: 'Published', isSponsored: true });
  });

  it('clears a stale rejection reason on approval', async () => {
    const { admin, recs } = await seedWorld();
    await prisma.recommendation.update({ where: { id: recs.pendingA.id }, data: { rejectionReason: 'old reason' } });
    const res = await request(app).put(approveUrl(recs.pendingA.id)).set(await authHeader(admin)).send({ expectedUpdatedAt: await versionOf(recs.pendingA.id) });
    expect(res.body.rejectionReason).toBeNull();
    expect((await snapshot(recs.pendingA.id)).rejectionReason).toBeNull();
  });

  it('rejects a request without a body: expectedUpdatedAt is required (400, nothing changed)', async () => {
    const { admin, recs } = await seedWorld();
    const before = await snapshot(recs.pendingA.id);
    const res = await request(app).put(approveUrl(recs.pendingA.id)).set(await authHeader(admin));
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ path: 'expectedUpdatedAt', message: expect.stringMatching(/required/) }]);
    expect(await snapshot(recs.pendingA.id)).toEqual(before);
  });

  it('lets an admin approve their own request and records them as reviewer (logged as self-review)', async () => {
    const { admin, cooking } = await seedWorld();
    const own = await createRecommendation(prisma, { author: admin, category: cooking, state: 'pending' });
    const res = await request(app).put(approveUrl(own.id)).set(await authHeader(admin)).send({ expectedUpdatedAt: await versionOf(own.id) });
    expect(res.status).toBe(200);
    expect((await snapshot(own.id)).reviewedByUserId).toBe(admin.id);
    expect(reviewLogs()).toEqual([expect.objectContaining({ decision: 'approve', selfReview: true, adminUserId: admin.id })]);
  });

  it('logs the review without user content or secrets', async () => {
    const { admin, alice, recs } = await seedWorld();
    await request(app).put(approveUrl(recs.pendingA.id)).set(await authHeader(admin)).send({ expectedUpdatedAt: await versionOf(recs.pendingA.id) });
    expect(reviewLogs()).toEqual([
      expect.objectContaining({ decision: 'approve', recommendationId: recs.pendingA.id, adminUserId: admin.id, ownerUserId: alice.id, selfReview: false, newStatus: 'Published' }),
    ]);
    expect(JSON.stringify(reviewLogs())).not.toMatch(/password|token|Bearer|Alice pending/i);
  });
});

// ====================================================================== reject

describe('PUT /api/admin/recommendations/:id/reject-sponsored', () => {
  it('rejects with a reason: private, not sponsored, reviewer, time and reason recorded', async () => {
    const { admin, alice, recs } = await seedWorld();
    const res = await request(app)
      .put(rejectUrl(recs.pendingA.id))
      .set(await authHeader(admin))
      .send({ rejectionReason: '  Please disclose the brand relationship.  ', isSponsored: true, expectedUpdatedAt: await versionOf(recs.pendingA.id) });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'Rejected',
      isSponsored: false,
      declaresSponsored: true,
      rejectionReason: 'Please disclose the brand relationship.',
      reviewedBy: { id: admin.id },
    });
    expect(res.body.reviewedAt).toEqual(expect.any(String));

    const stored = await snapshot(recs.pendingA.id);
    expect(stored).toMatchObject({ status: 'Rejected', isSponsored: false, reviewedByUserId: admin.id });
    expect(stored.reviewedAt).toBeInstanceOf(Date);

    expect((await request(app).get(`/api/recommendations/${recs.pendingA.id}`)).status).toBe(404);
    const list = await request(app).get('/api/recommendations');
    expect(list.body.items.map((r: { id: number }) => r.id)).not.toContain(recs.pendingA.id);

    const mine = await request(app).get('/api/recommendations/mine').set(await authHeader(alice));
    expect(mine.body.items.find((r: { id: number }) => r.id === recs.pendingA.id)).toMatchObject({
      status: 'Rejected',
      rejectionReason: 'Please disclose the brand relationship.',
    });
    expect(reviewLogs()).toEqual([expect.objectContaining({ decision: 'reject', hasRejectionReason: true, newStatus: 'Rejected' })]);
    expect(JSON.stringify(reviewLogs())).not.toContain('brand relationship');
  });

  it.each([
    ['omitted', {}],
    ['null', { rejectionReason: null }],
    ['blank', { rejectionReason: '   ' }],
  ])('accepts a %s reason (optional per spec) and stores null', async (_label, body) => {
    const { admin, recs } = await seedWorld();
    const res = await request(app).put(rejectUrl(recs.pendingA.id)).set(await authHeader(admin)).send({ ...body, expectedUpdatedAt: await versionOf(recs.pendingA.id) });
    expect(res.status).toBe(200);
    expect(res.body.rejectionReason).toBeNull();
    expect((await snapshot(recs.pendingA.id)).status).toBe('Rejected');
  });

  it.each([
    ['a reason over 1000 characters', { rejectionReason: 'x'.repeat(1001) }, 'rejectionReason'],
    ['a non-text reason', { rejectionReason: 42 }, 'rejectionReason'],
    ['an invalid expectedUpdatedAt', { expectedUpdatedAt: 'yesterday' }, 'expectedUpdatedAt'],
  ])('rejects %s with 400 and changes nothing', async (_label, body, field) => {
    const { admin, recs } = await seedWorld();
    const before = await snapshot(recs.pendingA.id);
    // A valid version is sent unless the case itself overrides it.
    const res = await request(app).put(rejectUrl(recs.pendingA.id)).set(await authHeader(admin)).send({ expectedUpdatedAt: await versionOf(recs.pendingA.id), ...body });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
    expect(await snapshot(recs.pendingA.id)).toEqual(before);
  });

  it('accepts a reason of exactly 1000 characters', async () => {
    const { admin, recs } = await seedWorld();
    const res = await request(app).put(rejectUrl(recs.pendingA.id)).set(await authHeader(admin)).send({ rejectionReason: 'x'.repeat(1000), expectedUpdatedAt: await versionOf(recs.pendingA.id) });
    expect(res.status).toBe(200);
  });

  it('supports the full owner cycle afterwards: resubmit, then approve', async () => {
    const { admin, alice, recs } = await seedWorld();
    await request(app).put(rejectUrl(recs.pendingA.id)).set(await authHeader(admin)).send({ rejectionReason: 'Needs work', expectedUpdatedAt: await versionOf(recs.pendingA.id) });

    const resubmit = await request(app)
      .post(`/api/recommendations/${recs.pendingA.id}/request-sponsored`)
      .set(await authHeader(alice))
      .send({ sponsorName: 'Acme Tools', productName: 'Acme Drill X', sponsorshipType: 'FreeProduct' });
    expect(resubmit.body).toMatchObject({ status: 'PendingSponsoredApproval', rejectionReason: null, reviewedAt: null });

    const approved = await request(app).put(approveUrl(recs.pendingA.id)).set(await authHeader(admin)).send({ expectedUpdatedAt: resubmit.body.updatedAt });
    expect(approved.body).toMatchObject({ status: 'Published', isSponsored: true });
  });
});

// ====================================================================== state transitions

describe('invalid state transitions and missing recommendations', () => {
  it.each([['published'], ['sponsored'], ['rejected']] as const)(
    'refuses to approve or reject a %s recommendation with 409 and changes nothing',
    async (state) => {
      const { admin, recs } = await seedWorld();
      const rec = recs[state];
      const before = await snapshot(rec.id);
      const auth = await authHeader(admin);
      for (const url of [approveUrl(rec.id), rejectUrl(rec.id)]) {
        const res = await request(app).put(url).set(auth).send({ expectedUpdatedAt: await versionOf(rec.id) });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
        expect(res.body.error.message).toMatch(/pending sponsored approval/);
      }
      expect(await snapshot(rec.id)).toEqual(before);
      expect(reviewLogs()).toHaveLength(0);
    },
  );

  it('returns 404 for removed and unknown recommendations, 400 for invalid ids', async () => {
    const { admin, recs } = await seedWorld();
    const auth = await authHeader(admin);
    for (const id of [recs.removed.id, 999999]) {
      const expectedUpdatedAt = id === recs.removed.id ? await versionOf(id) : new Date().toISOString();
      expect((await request(app).put(approveUrl(id)).set(auth).send({ expectedUpdatedAt })).status).toBe(404);
      expect((await request(app).put(rejectUrl(id)).set(auth).send({ expectedUpdatedAt })).status).toBe(404);
    }
    expect((await request(app).put(`${BASE}/abc/approve-sponsored`).set(auth).send({ expectedUpdatedAt: new Date().toISOString() })).status).toBe(400);
    expect((await snapshot(recs.removed.id)).status).toBe('Removed');
  });
});

// ====================================================================== double / concurrent / stale

describe('double, concurrent and stale reviews', () => {
  it.each([
    ['approve', 'approve'],
    ['approve', 'reject'],
    ['reject', 'approve'],
    ['reject', 'reject'],
  ] as const)('refuses a second review (%s then %s) with 409, keeping the first result', async (first, second) => {
    const { admin, admin2, recs } = await seedWorld();
    const url = (d: 'approve' | 'reject') => (d === 'approve' ? approveUrl(recs.pendingA.id) : rejectUrl(recs.pendingA.id));

    // Both admins reviewed the same version.
    const expectedUpdatedAt = await versionOf(recs.pendingA.id);
    expect((await request(app).put(url(first)).set(await authHeader(admin)).send({ rejectionReason: 'first', expectedUpdatedAt })).status).toBe(200);
    const afterFirst = await snapshot(recs.pendingA.id);

    const res = await request(app).put(url(second)).set(await authHeader(admin2)).send({ rejectionReason: 'second', expectedUpdatedAt });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await snapshot(recs.pendingA.id)).toEqual(afterFirst);
    expect(afterFirst.reviewedByUserId).toBe(admin.id);
  });

  it('lets exactly one of several simultaneous reviews win, with a consistent final state', async () => {
    const { admin, admin2, recs } = await seedWorld();
    const a1 = await authHeader(admin);
    const a2 = await authHeader(admin2);
    // All four decisions are based on the same reviewed version.
    const expectedUpdatedAt = await versionOf(recs.pendingA.id);
    const results = await Promise.all([
      request(app).put(approveUrl(recs.pendingA.id)).set(a1).send({ expectedUpdatedAt }),
      request(app).put(rejectUrl(recs.pendingA.id)).set(a2).send({ rejectionReason: 'no', expectedUpdatedAt }),
      request(app).put(approveUrl(recs.pendingA.id)).set(a2).send({ expectedUpdatedAt }),
      request(app).put(rejectUrl(recs.pendingA.id)).set(a1).send({ expectedUpdatedAt }),
    ]);
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);

    const winner = ok[0]!.body;
    const stored = await snapshot(recs.pendingA.id);
    expect(stored.status).toBe(winner.status);
    expect(stored.reviewedByUserId).toBe(winner.reviewedBy.id);
    expect(stored.isSponsored).toBe(winner.status === 'Published');
    expect(reviewLogs()).toHaveLength(1);
  });

  it('refuses a review based on a stale version (owner edited after the admin loaded it) with 409 CONFLICT', async () => {
    const { admin, alice, cooking, recs } = await seedWorld();
    const auth = await authHeader(admin);
    const queue = await request(app).get(`${BASE}/pending-sponsored`).set(auth);
    const seen = queue.body.items.find((r: { id: number }) => r.id === recs.pendingA.id);

    // Owner edits the pending request after the admin looked at it.
    const edit = await request(app)
      .put(`/api/recommendations/${recs.pendingA.id}`)
      .set(await authHeader(alice))
      .send({ title: 'Changed after review started', description: 'New content', categoryId: cooking.id });
    expect(edit.status).toBe(200);
    const afterEdit = await snapshot(recs.pendingA.id);

    for (const url of [approveUrl(recs.pendingA.id), rejectUrl(recs.pendingA.id)]) {
      const res = await request(app).put(url).set(auth).send({ expectedUpdatedAt: seen.updatedAt });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    }
    expect(await snapshot(recs.pendingA.id)).toEqual(afterEdit);

    // With the current version, the review goes through.
    const current = await request(app).put(approveUrl(recs.pendingA.id)).set(auth).send({ expectedUpdatedAt: afterEdit.updatedAt.toISOString() });
    expect(current.status).toBe(200);
    expect(current.body.title).toBe('Changed after review started');
  });

  it('puts an approved recommendation back in the queue when its owner edits it (Phase D rule)', async () => {
    const { admin, alice, cooking, recs } = await seedWorld();
    const auth = await authHeader(admin);
    await request(app).put(approveUrl(recs.pendingA.id)).set(auth).send({ expectedUpdatedAt: await versionOf(recs.pendingA.id) });
    await request(app)
      .put(`/api/recommendations/${recs.pendingA.id}`)
      .set(await authHeader(alice))
      .send({ title: 'Edited after approval', description: 'x', categoryId: cooking.id });

    const queue = await request(app).get(`${BASE}/pending-sponsored`).set(auth);
    const item = queue.body.items.find((r: { id: number }) => r.id === recs.pendingA.id);
    expect(item).toMatchObject({ status: 'PendingSponsoredApproval', isSponsored: false, reviewedBy: null });
    expect((await request(app).put(approveUrl(recs.pendingA.id)).set(auth).send({ expectedUpdatedAt: item.updatedAt })).status).toBe(200);
  });
});

// ====================================================================== Fix B: expectedUpdatedAt is required

describe('expectedUpdatedAt (the reviewed version) is required', () => {
  const decisions = [
    ['approve', approveUrl],
    ['reject', rejectUrl],
  ] as const;

  it.each(decisions)('%s: a missing value returns 400 and changes nothing', async (_d, url) => {
    const { admin, recs } = await seedWorld();
    const before = await snapshot(recs.pendingA.id);
    for (const body of [{}, { rejectionReason: 'no' }, { expectedUpdatedAt: null }]) {
      const res = await request(app).put(url(recs.pendingA.id)).set(await authHeader(admin)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain('expectedUpdatedAt');
    }
    expect(await snapshot(recs.pendingA.id)).toEqual(before);
    expect(reviewLogs()).toHaveLength(0);
  });

  it.each(decisions)('%s: invalid formats return 400 and change nothing', async (_d, url) => {
    const { admin, recs } = await seedWorld();
    const before = await snapshot(recs.pendingA.id);
    for (const expectedUpdatedAt of ['yesterday', '2026-13-01T00:00:00Z', '2026-10-11', 1760000000000, '']) {
      const res = await request(app).put(url(recs.pendingA.id)).set(await authHeader(admin)).send({ expectedUpdatedAt });
      expect(res.status, String(expectedUpdatedAt)).toBe(400);
      expect(res.body.error.details[0]).toMatchObject({
        path: 'expectedUpdatedAt',
        message: 'expectedUpdatedAt must be an ISO 8601 timestamp.',
      });
    }
    expect(await snapshot(recs.pendingA.id)).toEqual(before);
  });

  it.each(decisions)('%s: an older or newer timestamp is stale (409 CONFLICT) and changes nothing', async (_d, url) => {
    const { admin, recs } = await seedWorld();
    const before = await snapshot(recs.pendingA.id);
    const t = before.updatedAt.getTime();
    for (const offset of [-1, 1, -60_000]) {
      const res = await request(app)
        .put(url(recs.pendingA.id))
        .set(await authHeader(admin))
        .send({ expectedUpdatedAt: new Date(t + offset).toISOString() });
      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({
        code: 'CONFLICT',
        message: 'The recommendation was changed after you loaded it. Reload it and review the current version.',
      });
    }
    expect(await snapshot(recs.pendingA.id)).toEqual(before);
    expect(reviewLogs()).toHaveLength(0);
  });

  it('compares instants, not strings: the same time in another UTC offset is accepted', async () => {
    const { admin, recs } = await seedWorld();
    const utc = (await snapshot(recs.pendingA.id)).updatedAt;
    // Same instant, written as local time at +03:00.
    const shifted = new Date(utc.getTime() + 3 * 3600_000).toISOString().replace('Z', '+03:00');
    const res = await request(app).put(approveUrl(recs.pendingA.id)).set(await authHeader(admin)).send({ expectedUpdatedAt: shifted });
    expect(res.status).toBe(200);
  });

  it('never publishes an owner edit made concurrently with an approval of the previous version', async () => {
    for (let round = 0; round < 5; round++) {
      await resetDatabase(prisma);
      const { admin, alice, cooking, recs } = await seedWorld();
      const reviewed = await versionOf(recs.pendingA.id);
      const [approval, edit] = await Promise.all([
        request(app).put(approveUrl(recs.pendingA.id)).set(await authHeader(admin)).send({ expectedUpdatedAt: reviewed }),
        request(app)
          .put(`/api/recommendations/${recs.pendingA.id}`)
          .set(await authHeader(alice))
          .send({ title: 'Unreviewed edit', description: 'x', categoryId: cooking.id }),
      ]);
      expect(edit.status).toBe(200);
      expect([200, 409]).toContain(approval.status);
      const stored = await snapshot(recs.pendingA.id);
      // Whatever the order, the edited (unreviewed) content is never public as sponsored:
      // either the approval lost (409), or it won and the edit then revoked it.
      expect(stored.title).toBe('Unreviewed edit');
      expect(stored).toMatchObject({ status: 'PendingSponsoredApproval', isSponsored: false });
    }
  });
});

// ====================================================================== Fix C: category must be active to approve

describe('approval requires an active category', () => {
  it('approves when the category is active', async () => {
    const { admin, recs } = await seedWorld();
    const res = await request(app)
      .put(approveUrl(recs.pendingA.id))
      .set(await authHeader(admin))
      .send({ expectedUpdatedAt: await versionOf(recs.pendingA.id) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'Published', isSponsored: true, category: { id: recs.pendingA.categoryId } });
  });

  it('refuses (409) when the category is disabled, leaving the recommendation and category unchanged', async () => {
    const { admin, cooking, recs } = await seedWorld();
    await prisma.category.update({ where: { id: cooking.id }, data: { isActive: false } });
    const before = await snapshot(recs.pendingA.id);

    const res = await request(app)
      .put(approveUrl(recs.pendingA.id))
      .set(await authHeader(admin))
      .send({ expectedUpdatedAt: before.updatedAt.toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toMatch(/category is disabled/);

    expect(await snapshot(recs.pendingA.id)).toEqual(before); // no partial update
    expect((await prisma.category.findUniqueOrThrow({ where: { id: cooking.id } })).isActive).toBe(false); // not re-activated
    expect((await request(app).get(`/api/recommendations/${recs.pendingA.id}`)).status).toBe(404); // not published
    expect(reviewLogs()).toHaveLength(0);
  });

  it('still allows rejecting, and approving once the category is re-enabled', async () => {
    const { admin, cooking, recs } = await seedWorld();
    const auth = await authHeader(admin);
    await prisma.category.update({ where: { id: cooking.id }, data: { isActive: false } });

    const rejected = await request(app).put(rejectUrl(recs.pendingB.id)).set(auth).send({ expectedUpdatedAt: await versionOf(recs.pendingB.id) });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('Rejected');

    await prisma.category.update({ where: { id: cooking.id }, data: { isActive: true } });
    const approved = await request(app).put(approveUrl(recs.pendingA.id)).set(auth).send({ expectedUpdatedAt: await versionOf(recs.pendingA.id) });
    expect(approved.status).toBe(200);
  });

  it('waits for a concurrent, uncommitted category deactivation and then refuses the approval', async () => {
    const { admin, cooking, recs } = await seedWorld();
    const before = await snapshot(recs.pendingA.id);

    // A separate connection deactivates the category but does not commit yet.
    let commit!: () => void;
    let deactivated!: () => void;
    const commitGate = new Promise<void>((resolve) => (commit = resolve));
    const deactivatedGate = new Promise<void>((resolve) => (deactivated = resolve));
    const deactivation = prisma.$transaction(
      async (tx) => {
        await tx.category.update({ where: { id: cooking.id }, data: { isActive: false } });
        deactivated();
        await commitGate;
      },
      { timeout: 20_000 },
    );
    await deactivatedGate;

    let settled = false;
    let res: request.Response;
    try {
      const approval = request(app)
        .put(approveUrl(recs.pendingA.id))
        .set(await authHeader(admin))
        .send({ expectedUpdatedAt: before.updatedAt.toISOString() })
        .then((r) => {
          settled = true;
          return r;
        });

      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(settled, 'the approval must wait for the category row lock').toBe(false);

      commit();
      await deactivation;
      res = await approval;
    } finally {
      // Always release the open transaction, even if an assertion above failed,
      // so its row lock cannot block later tests.
      commit();
      await deactivation.catch(() => undefined);
    }
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/category is disabled/);
    expect(await snapshot(recs.pendingA.id)).toEqual(before);
  });

  it('an approval racing a deactivation ends in one of the two valid outcomes', async () => {
    for (let round = 0; round < 5; round++) {
      await resetDatabase(prisma);
      const { admin, cooking, recs } = await seedWorld();
      const auth = await authHeader(admin);
      const reviewed = await versionOf(recs.pendingA.id);
      const [approval, disable] = await Promise.all([
        request(app).put(approveUrl(recs.pendingA.id)).set(auth).send({ expectedUpdatedAt: reviewed }),
        request(app).patch(`/api/admin/categories/${cooking.id}/status`).set(auth).send({ isActive: false }),
      ]);
      expect(disable.status).toBe(200);
      const stored = await snapshot(recs.pendingA.id);
      if (approval.status === 200) {
        // Approval committed first; disabling afterwards keeps existing published items (Phase D rule).
        expect(stored).toMatchObject({ status: 'Published', isSponsored: true });
      } else {
        expect(approval.status).toBe(409);
        expect(approval.body.error.message).toMatch(/category is disabled/);
        expect(stored).toMatchObject({ status: 'PendingSponsoredApproval', isSponsored: false, reviewedByUserId: null });
      }
    }
  });
});
