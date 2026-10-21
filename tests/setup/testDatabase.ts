// Safety guard: destructive test setup may only run against a dedicated test
// database (spec.md §16). Throws unless the URL is clearly a test database.
export function assertSafeTestDatabaseUrl(testUrl: string | undefined, devUrl?: string): string {
  if (!testUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Add it to server/.env (see .env.example). ' +
        'Tests never run against DATABASE_URL.',
    );
  }

  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid URL.');
  }

  if (!/_test$/i.test(dbName)) {
    throw new Error(
      `Refusing to use database "${dbName}" for tests: the database name must end with "_test".`,
    );
  }
  if (devUrl && sameDatabase(testUrl, devUrl)) {
    throw new Error('TEST_DATABASE_URL must point to a different database than DATABASE_URL.');
  }
  return testUrl;
}

function sameDatabase(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.hostname === ub.hostname && ua.port === ub.port && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}
