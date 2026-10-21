import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env automatically. Existing environment variables
// take precedence over values in .env.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // `prisma generate` (run on npm install) needs no database, so allow a
    // missing DATABASE_URL here. Commands that connect will fail clearly.
    url: process.env.DATABASE_URL ?? '',
  },
});
