import SwaggerParser from '@apidevtools/swagger-parser';
import type { Router } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openApiDocument } from '../src/docs/openapi.js';
import { adminCategoriesRouter } from '../src/routes/adminCategories.js';
import { adminRecommendationsRouter } from '../src/routes/adminRecommendations.js';
import { adminUsersRouter } from '../src/routes/adminUsers.js';
import { authRouter } from '../src/routes/auth.js';
import { categoriesRouter } from '../src/routes/categories.js';
import { healthRouter } from '../src/routes/health.js';
import { recommendationsRouter } from '../src/routes/recommendations.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';
import { authHeader, createCategory, createRecommendation, createUser } from './helpers/fixtures.js';

const prisma = createTestPrisma();
const app = createApp();

type MediaType = { schema: Schema; example?: unknown };
type Operation = {
  security?: unknown[];
  'x-required-role'?: string;
  requestBody?: { required?: boolean; content: Record<string, MediaType> };
  responses: Record<string, { $ref?: string; content?: Record<string, MediaType> }>;
};
type Schema = {
  $ref?: string;
  type?: string;
  nullable?: boolean;
  enum?: unknown[];
  format?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};
const doc = openApiDocument as unknown as {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Record<string, unknown>>;
    responses: Record<string, { content?: Record<string, MediaType> }>;
  };
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const documentedOps = Object.entries(doc.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((method) => ({ method, path, op: item[method]! })),
);

// Mirrors the mounts in src/app.ts. The reachability test below fails if a
// prefix here is wrong, because the documented path would then hit the 404 handler.
const MOUNTS: Array<[string, Router]> = [
  ['/api/health', healthRouter],
  ['/api/auth', authRouter],
  ['/api/categories', categoriesRouter],
  ['/api/recommendations', recommendationsRouter],
  ['/api/admin/recommendations', adminRecommendationsRouter],
  ['/api/admin/categories', adminCategoriesRouter],
  ['/api/admin/users', adminUsersRouter],
];

function expressRoutes(): string[] {
  const routes: string[] = [];
  for (const [prefix, router] of MOUNTS) {
    for (const layer of (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack) {
      if (!layer.route) continue;
      const path = (prefix + (layer.route.path === '/' ? '' : layer.route.path)).replace(/:(\w+)/g, '{$1}');
      for (const method of Object.keys(layer.route.methods)) routes.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes.sort();
}

/** Property names of a component schema, following allOf. */
function schemaKeys(name: string): string[] {
  const schema = doc.components.schemas[name] as { properties?: Record<string, unknown>; allOf?: Array<{ $ref?: string; properties?: Record<string, unknown> }> };
  const keys = new Set(Object.keys(schema.properties ?? {}));
  for (const part of schema.allOf ?? []) {
    if (part.$ref) for (const k of schemaKeys(part.$ref.split('/').pop()!)) keys.add(k);
    for (const k of Object.keys(part.properties ?? {})) keys.add(k);
  }
  return [...keys].sort();
}

const keysOf = (value: object) => Object.keys(value).sort();

let world: Awaited<ReturnType<typeof seedWorld>>;

async function seedWorld() {
  const user = await createUser(prisma, { fullName: 'Ursula User', email: 'ursula@example.com' });
  const admin = await createUser(prisma, { fullName: 'Ada Admin', email: 'ada@example.com', role: 'Admin' });
  const category = await createCategory(prisma, { name: 'Cooking' });
  const rec = await createRecommendation(prisma, { author: user, category });
  const pending = await createRecommendation(prisma, { author: user, category, state: 'pending' });
  return { user, admin, category, rec, pending, userAuth: await authHeader(user), adminAuth: await authHeader(admin) };
}

beforeAll(async () => {
  await resetDatabase(prisma);
  world = await seedWorld();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

/** Fills {id} with an id of the right kind so the call reaches the handler. */
function concretePath(path: string) {
  const id = path.startsWith('/api/admin/users')
    ? world.user.id
    : path.startsWith('/api/admin/categories')
      ? world.category.id
      : path.startsWith('/api/admin/recommendations')
        ? world.pending.id
        : world.rec.id;
  return path.replace('{id}', String(id));
}

function send(method: string, path: string, headers: Record<string, string> = {}) {
  const req = (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(concretePath(path));
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return method === 'get' || method === 'delete' ? req : req.send({});
}

// ====================================================================== serving

describe('documentation endpoints', () => {
  it('serves the OpenAPI document as JSON', async () => {
    const res = await request(app).get('/api/docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(openApiDocument)));
  });

  it('serves Swagger UI at /api/docs', async () => {
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
    expect(res.text).toContain('<title>WorthShare API</title>');
    const bare = await request(app).get('/api/docs');
    expect([200, 301, 302]).toContain(bare.status);
  });
});

// ====================================================================== the document

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3.0 document with resolvable references', async () => {
    await expect(SwaggerParser.validate(structuredClone(openApiDocument) as never)).resolves.toBeDefined();
  });

  it('documents exactly the routes registered in Express', () => {
    const documented = documentedOps
      .filter(({ path }) => !path.startsWith('/api/docs'))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
      .sort();
    expect(documented).toEqual(expressRoutes());
    expect(documented).toHaveLength(27); // 26 API operations + health
  });

  it('marks every /api/admin operation as Admin-only with Bearer auth, and nothing else', () => {
    for (const { path, op } of documentedOps) {
      const isAdmin = path.startsWith('/api/admin/');
      expect(op['x-required-role'] === 'Admin', path).toBe(isAdmin);
      if (isAdmin) expect(op.security, path).toEqual([{ bearerAuth: [] }]);
    }
  });

  it('declares security explicitly on every operation and documents 401 wherever a token is required', () => {
    for (const { method, path, op } of documentedOps) {
      expect(op.security, `${method} ${path}`).toBeDefined();
      const needsToken = op.security!.length > 0;
      expect(Object.keys(op.responses).includes('401'), `${method} ${path}`).toBe(needsToken || path === '/api/auth/login');
      if (op['x-required-role']) expect(op.responses).toHaveProperty('403');
    }
  });
});

// ====================================================================== behaviour matches the document

describe('documented behaviour matches the running API', () => {
  it.each(documentedOps.map((o) => [`${o.method.toUpperCase()} ${o.path}`, o] as const))(
    '%s: reachable, auth as documented, and every observed status is documented',
    async (_label, { method, path, op }) => {
      const documentedStatuses = Object.keys(op.responses);
      const needsToken = (op.security ?? []).length > 0;

      const anonymous = await send(method, path);
      expect(anonymous.body?.error?.message, 'route must exist').not.toBe('Route not found.');
      expect(documentedStatuses).toContain(String(anonymous.status));
      if (needsToken) expect(anonymous.status).toBe(401);
      else expect(anonymous.status).not.toBe(401);

      if (!needsToken) return;
      const asUser = await send(method, path, world.userAuth);
      expect(documentedStatuses).toContain(String(asUser.status));
      if (op['x-required-role'] === 'Admin') expect(asUser.status).toBe(403);
      else expect(asUser.status).not.toBe(401);

      if (op['x-required-role'] === 'Admin') {
        const asAdmin = await send(method, path, world.adminAuth);
        expect(documentedStatuses).toContain(String(asAdmin.status));
        expect([401, 403]).not.toContain(asAdmin.status);
      }
    },
  );
});

// ====================================================================== response shapes

describe('response bodies have exactly the documented fields', () => {
  // The behaviour tests above call every endpoint (including deletes and
  // reviews), so start from fresh data here.
  beforeAll(async () => {
    await resetDatabase(prisma);
    world = await seedWorld();
  });

  it('auth responses', async () => {
    const reg = await request(app).post('/api/auth/register').send({ fullName: 'New', email: 'new@example.com', password: 'long-enough-1' });
    expect(keysOf(reg.body)).toEqual(schemaKeys('AuthResponse'));
    expect(keysOf(reg.body.user)).toEqual(schemaKeys('SafeUser'));

    const me = await request(app).get('/api/auth/me').set(world.userAuth);
    expect(keysOf(me.body)).toEqual(schemaKeys('MeResponse'));
    expect(keysOf(me.body.user)).toEqual(schemaKeys('SafeUser'));
  });

  it('public lists and items', async () => {
    const cats = await request(app).get('/api/categories');
    expect(keysOf(cats.body)).toEqual(['items', 'pagination']);
    expect(keysOf(cats.body.pagination)).toEqual(schemaKeys('Pagination'));
    expect(keysOf(cats.body.items[0])).toEqual(schemaKeys('PublicCategory'));

    const recs = await request(app).get('/api/recommendations');
    const item = recs.body.items[0];
    expect(keysOf(item)).toEqual(schemaKeys('PublicRecommendation'));
    expect(keysOf(item.category)).toEqual(schemaKeys('CategoryRef'));
    expect(keysOf(item.author)).toEqual(schemaKeys('PersonRef'));

    const one = await request(app).get(`/api/recommendations/${world.rec.id}`);
    expect(keysOf(one.body)).toEqual(schemaKeys('PublicRecommendation'));
  });

  it('owner and admin recommendation views', async () => {
    const mine = await request(app).get('/api/recommendations/mine').set(world.userAuth);
    expect(keysOf(mine.body.items[0])).toEqual(schemaKeys('OwnerRecommendation'));

    const pending = await request(app).get('/api/admin/recommendations/pending-sponsored').set(world.adminAuth);
    expect(keysOf(pending.body.items[0])).toEqual(schemaKeys('AdminRecommendation'));

    const all = await request(app).get('/api/admin/recommendations').set(world.adminAuth);
    expect(all.body.items.length).toBeGreaterThan(0);
    for (const item of all.body.items) expect(keysOf(item)).toEqual(schemaKeys('AdminRecommendation'));
  });

  it('admin categories and users', async () => {
    const cats = await request(app).get('/api/admin/categories').set(world.adminAuth);
    expect(keysOf(cats.body.items[0])).toEqual(schemaKeys('AdminCategory'));
    const users = await request(app).get('/api/admin/users').set(world.adminAuth);
    expect(keysOf(users.body.items[0])).toEqual(schemaKeys('AdminUser'));
  });

  it('errors and health', async () => {
    const health = await request(app).get('/api/health');
    expect(keysOf(health.body)).toEqual(schemaKeys('Health'));

    const notFound = await request(app).get('/api/recommendations/999999');
    expect(keysOf(notFound.body)).toEqual(['error']);
    expect(keysOf(notFound.body.error)).toEqual(['code', 'message']);

    const invalid = await request(app).get('/api/recommendations?pageSize=99');
    expect(keysOf(invalid.body.error)).toEqual(['code', 'details', 'message']);
    expect(keysOf(invalid.body.error.details[0])).toEqual(['message', 'path']);
  });
});

// ====================================================================== examples and completeness

/** Minimal JSON-schema check for OpenAPI 3.0 schemas used in this document. Returns problems found. */
function check(schema: Schema, value: unknown, path = '$'): string[] {
  if (schema.$ref) return check(doc.components.schemas[schema.$ref.split('/').pop()!] as Schema, value, path);
  if (schema.allOf) {
    // Merge object parts (properties + required) so extra-key checks see the whole shape.
    const merged: Schema = { type: 'object', properties: {}, required: [], nullable: schema.nullable };
    const visit = (s: Schema) => {
      if (s.$ref) return visit(doc.components.schemas[s.$ref.split('/').pop()!] as Schema);
      if (s.allOf) s.allOf.forEach(visit);
      if (s.allOf && !s.properties) return;
      Object.assign(merged.properties!, s.properties ?? {});
      merged.required!.push(...(s.required ?? []));
      if (s.type && s.type !== 'object') merged.type = s.type;
    };
    schema.allOf.forEach(visit);
    if (merged.type !== 'object') return check({ ...merged, properties: undefined, required: undefined }, value, path);
    return check(merged, value, path);
  }
  if (value === null) return schema.nullable ? [] : [`${path}: null but not nullable`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} not in enum`];
  const problems: string[] = [];
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return [`${path}: not an object`];
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!(key in obj)) problems.push(`${path}.${key}: required but missing`);
      for (const [key, v] of Object.entries(obj)) {
        const prop = schema.properties?.[key];
        if (!prop) problems.push(`${path}.${key}: not in schema`);
        else problems.push(...check(prop, v, `${path}.${key}`));
      }
      return problems;
    }
    case 'array':
      if (!Array.isArray(value)) return [`${path}: not an array`];
      return value.flatMap((v, i) => check(schema.items!, v, `${path}[${i}]`));
    case 'string':
      if (typeof value !== 'string') return [`${path}: not a string`];
      if (schema.format === 'date-time' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) problems.push(`${path}: not date-time`);
      if (schema.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) problems.push(`${path}: not an email`);
      if (schema.format === 'uri' && !/^https?:\/\//.test(value)) problems.push(`${path}: not an http(s) URI`);
      if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path}: too short`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path}: too long`);
      return problems;
    case 'integer':
      if (!Number.isInteger(value)) return [`${path}: not an integer`];
      if (schema.minimum !== undefined && (value as number) < schema.minimum) problems.push(`${path}: below minimum`);
      if (schema.maximum !== undefined && (value as number) > schema.maximum) problems.push(`${path}: above maximum`);
      return problems;
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: not a boolean`];
    default:
      return [];
  }
}

describe('OpenAPI examples and completeness', () => {
  const examples: Array<[string, Schema, unknown]> = [];
  for (const { method, path, op } of documentedOps) {
    for (const [ct, media] of Object.entries(op.requestBody?.content ?? {})) {
      if (media.example !== undefined) examples.push([`${method.toUpperCase()} ${path} request (${ct})`, media.schema, media.example]);
    }
    for (const [code, resp] of Object.entries(op.responses)) {
      for (const media of Object.values(resp.content ?? {})) {
        if (media.example !== undefined) examples.push([`${method.toUpperCase()} ${path} ${code}`, media.schema, media.example]);
      }
    }
  }
  for (const [name, resp] of Object.entries(doc.components.responses)) {
    for (const media of Object.values(resp.content ?? {})) {
      if (media.example !== undefined) examples.push([`components.responses.${name}`, media.schema, media.example]);
    }
  }

  it('has examples to check', () => {
    expect(examples.length).toBeGreaterThan(40);
  });

  it.each(examples)('%s: example matches its schema', (_label, schema, example) => {
    expect(check(schema, example)).toEqual([]);
  });

  it('gives every success response with a body an example, and no body for 204', () => {
    const missing: string[] = [];
    for (const { method, path, op } of documentedOps) {
      for (const [code, resp] of Object.entries(op.responses)) {
        if (!code.startsWith('2')) continue;
        if (code === '204') {
          expect(resp.content, `${method} ${path} 204`).toBeUndefined();
          continue;
        }
        if (!Object.values(resp.content ?? {}).some((m) => m.example !== undefined)) missing.push(`${method.toUpperCase()} ${path} ${code}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('documents 413 on every operation that accepts a body, and only there', () => {
    for (const { method, path, op } of documentedOps) {
      expect('413' in op.responses, `${method} ${path}`).toBe(Boolean(op.requestBody));
    }
  });

  it('a JSON body over 100 KB really returns the documented 413 (before authentication)', async () => {
    const big = JSON.stringify({ title: 'x', description: 'y'.repeat(110_000), categoryId: 1 });
    for (const path of ['/api/auth/login', '/api/recommendations']) {
      const res = await request(app).post(path).set('Content-Type', 'application/json').send(big);
      expect(res.status).toBe(413);
      expect(res.body).toEqual(doc.components.responses.PayloadTooLarge!.content!['application/json']!.example);
    }
  });

  it('requires expectedUpdatedAt in the approve and reject request bodies', () => {
    for (const path of ['/api/admin/recommendations/{id}/approve-sponsored', '/api/admin/recommendations/{id}/reject-sponsored']) {
      const op = doc.paths[path]!.put!;
      expect(op.requestBody?.required).toBe(true);
      const schemaName = op.requestBody!.content['application/json']!.schema.$ref!.split('/').pop()!;
      expect((doc.components.schemas[schemaName] as Schema).required).toEqual(['expectedUpdatedAt']);
    }
  });

  it('documents the admin list status filter with exactly the database statuses', () => {
    const op = doc.paths['/api/admin/recommendations']!.get! as unknown as { parameters: Array<{ name?: string; schema?: Schema }> };
    const status = op.parameters.find((p) => p.name === 'status');
    expect(status?.schema?.enum).toEqual(['Published', 'PendingSponsoredApproval', 'Rejected', 'Removed']);
  });
});
