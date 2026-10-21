import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { assertSafeTestDatabaseUrl } from './tests/setup/testDatabase.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

// Tests always use TEST_DATABASE_URL, never the development DATABASE_URL.
const testDatabaseUrl = assertSafeTestDatabaseUrl(
  process.env.TEST_DATABASE_URL,
  process.env.DATABASE_URL,
);
process.env.DATABASE_URL = testDatabaseUrl;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/globalSetup.ts'],
    // Test files share one database, so run them one at a time.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      // Fresh random signing secret per run; never the development secret.
      JWT_SECRET: randomBytes(48).toString('base64url'),
      JWT_EXPIRES_IN: '1h',
    },
  },
});
