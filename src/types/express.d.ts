import type { Role } from '../generated/prisma/client.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware from the database, never from client input. */
      user?: {
        id: number;
        fullName: string;
        email: string;
        role: Role;
      };
    }
  }
}

export {};
