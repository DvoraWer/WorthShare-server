// Read-only database preflight. Run with `npm run db:check`.
//
// Connects directly with `pg` (not Prisma, whose `migrate deploy` would create
// a missing database) and reports whether each configured database exists,
// whether the credentials work, and whether the role is suitable.
// Never prints connection strings, user names or passwords.

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export type DatabaseCheck =
  | { ok: true; database: string; isSuperuser: boolean; canCreateInDatabase: boolean; citextAvailable: boolean; migrationsTable: boolean; serverVersion: string }
  | { ok: false; database: string; problem: string; code?: string };

const problems: Record<string, string> = {
  ECONNREFUSED: 'PostgreSQL is not reachable at the configured host/port.',
  ENOTFOUND: 'The configured database host could not be resolved.',
  '28P01': 'Authentication failed: the user name or password in the URL is wrong.',
  '28000': 'Login rejected: the role does not exist or is not allowed to connect.',
  '3D000': 'The database does not exist.',
};

function databaseName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || '(none)';
  } catch {
    return '(invalid URL)';
  }
}

export async function checkDatabase(url: string): Promise<DatabaseCheck> {
  const database = databaseName(url);
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
  } catch (error) {
    const code = (error as { code?: string }).code;
    return {
      ok: false,
      database,
      code,
      problem: (code && problems[code]) ?? `Connection failed (${code ?? 'unknown error'}).`,
    };
  }

  try {
    const { rows } = await client.query<{
      is_superuser: boolean;
      can_create: boolean;
      citext_available: boolean;
      migrations_table: boolean;
      server_version: string;
    }>(`
      SELECT
        r.rolsuper AS is_superuser,
        has_database_privilege(current_database(), 'CREATE') AS can_create,
        EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'citext') AS citext_available,
        to_regclass('public._prisma_migrations') IS NOT NULL AS migrations_table,
        current_setting('server_version') AS server_version
      FROM pg_roles r
      WHERE r.rolname = current_user
    `);
    const row = rows[0]!;
    return {
      ok: true,
      database,
      isSuperuser: row.is_superuser,
      canCreateInDatabase: row.can_create,
      citextAvailable: row.citext_available,
      migrationsTable: row.migrations_table,
      serverVersion: row.server_version,
    };
  } finally {
    await client.end();
  }
}

/** True when the check passed and the role is a non-superuser able to run migrations. */
export function isUsable(check: DatabaseCheck): boolean {
  return check.ok && !check.isSuperuser && check.canCreateInDatabase && check.citextAvailable;
}

function describe(label: string, check: DatabaseCheck): string {
  if (!check.ok) {
    return `${label} (${check.database}): FAIL - ${check.problem}${check.code ? ` [${check.code}]` : ''}`;
  }
  const notes = [
    `exists, PostgreSQL ${check.serverVersion}`,
    check.isSuperuser ? 'FAIL - role is a superuser (use a dedicated application role)' : 'role is not a superuser',
    check.canCreateInDatabase ? 'role can create objects' : 'FAIL - role lacks CREATE privilege on the database',
    check.citextAvailable ? 'citext available' : 'FAIL - citext extension not available',
    check.migrationsTable ? 'migrations table present' : 'no migrations applied yet',
  ];
  return `${label} (${check.database}): ${notes.join('; ')}`;
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');

  const targets = [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['TEST_DATABASE_URL', process.env.TEST_DATABASE_URL],
  ] as const;

  let failed = false;
  for (const [label, url] of targets) {
    if (!url) {
      console.log(`${label}: FAIL - not set`);
      failed = true;
      continue;
    }
    const check = await checkDatabase(url);
    console.log(describe(label, check));
    if (!isUsable(check)) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error('Database check crashed:', error instanceof Error ? error.name : error);
    process.exit(1);
  });
}
