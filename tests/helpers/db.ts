import { createPrismaClient } from '../../src/db/prisma.js';
import { assertSafeTestDatabaseUrl } from '../setup/testDatabase.js';

export function createTestPrisma() {
  return createPrismaClient(assertSafeTestDatabaseUrl(process.env.DATABASE_URL));
}

type TestPrisma = ReturnType<typeof createTestPrisma>;

// Empties all tables in the test database. Guarded against non-test databases.
export async function resetDatabase(prisma: TestPrisma) {
  assertSafeTestDatabaseUrl(process.env.DATABASE_URL);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "favorites", "recommendations", "categories", "users" RESTART IDENTITY CASCADE',
  );
}
