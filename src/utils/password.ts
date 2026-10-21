import bcrypt from 'bcryptjs';
import { z } from 'zod';

// Password rule (spec.md §12): 8–72 characters. bcrypt only uses the first
// 72 bytes, so longer input is rejected rather than silently truncated.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES, {
    message: `Password must be at most ${PASSWORD_MAX_BYTES} bytes.`,
  });

// Lower cost in tests keeps the suite fast; never used outside NODE_ENV=test.
const BCRYPT_ROUNDS = process.env.NODE_ENV === 'test' ? 4 : 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
