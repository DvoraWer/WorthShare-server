import { z } from 'zod';
import { normalizeEmail, passwordSchema } from '../utils/password.js';

export const emailSchema = z
  .string({ error: 'Email is required.' })
  .transform(normalizeEmail)
  .pipe(z.email('Email must be a valid email address.').max(254, 'Email is too long.'));

// Unknown keys (e.g. role, isActive) are stripped: registration never accepts them.
export const registerSchema = z.object({
  fullName: z
    .string({ error: 'Full name is required.' })
    .trim()
    .min(1, 'Full name is required.')
    .max(100, 'Full name must be at most 100 characters.'),
  email: emailSchema,
  password: z.string({ error: 'Password is required.' }).pipe(passwordSchema),
});

// Login does not re-check the password rule, so the response never hints at it.
export const loginSchema = z.object({
  email: emailSchema,
  password: z
    .string({ error: 'Password is required.' })
    .min(1, 'Password is required.')
    .max(1024, 'Password is too long.'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
