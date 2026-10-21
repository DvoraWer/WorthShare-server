import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { checkDatabase } from '../../scripts/check-db.js';
import { assertSafeTestDatabaseUrl } from './testDatabase.js';

// Applies all migrations to the test database once before the suite runs.
export default async function setup() {
  const testUrl = assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

  // `prisma migrate deploy` would silently create a missing database, so
  // verify it exists (and that we are not using a superuser) first.
  const check = await checkDatabase(testUrl);
  if (!check.ok) {
    throw new Error(`Test database "${check.database}" is not usable: ${check.problem}`);
  }
  if (check.isSuperuser) {
    throw new Error('Refusing to run tests with a PostgreSQL superuser role.');
  }

  // Run the Prisma CLI with the current Node binary (no shell involved).
  const prismaCli = resolve('node_modules', 'prisma', 'build', 'index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'inherit',
  });
}
