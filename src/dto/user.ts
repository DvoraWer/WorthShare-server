import type { Role } from '../generated/prisma/client.js';

// Explicit response mapping: never serialize user records directly.
export interface SafeUserDto {
  id: number;
  fullName: string;
  email: string;
  role: Role;
}

export function toSafeUser(user: SafeUserDto): SafeUserDto {
  return { id: user.id, fullName: user.fullName, email: user.email, role: user.role };
}

/** Prisma `select` for the fields a SafeUserDto needs (no password hash). */
export const safeUserSelect = {
  id: true,
  fullName: true,
  email: true,
  role: true,
} as const;
