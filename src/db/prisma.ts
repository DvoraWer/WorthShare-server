import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

export function createPrismaClient(connectionString: string = env.DATABASE_URL) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Shared client for the application. Connections are opened lazily.
export const prisma = createPrismaClient();
