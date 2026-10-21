import { z } from 'zod';
import { paginationQueryShape } from './common.js';

// ------------------------------------------------------------- shared

/** `{ "isActive": true | false }` for category and user status endpoints. Other keys are ignored. */
export const statusBodySchema = z.object({
  isActive: z.boolean({ error: 'isActive must be true or false.' }),
});
export type StatusInput = z.infer<typeof statusBodySchema>;

const searchParam = z
  .string({ error: 'search must be a single value.' })
  .trim()
  .max(100, 'search must be at most 100 characters.')
  .optional();

// ------------------------------------------------------------- categories

export const listAdminCategoriesQuerySchema = z.object({ ...paginationQueryShape, search: searchParam });
export type ListAdminCategoriesQuery = z.infer<typeof listAdminCategoriesQuerySchema>;

// `isActive` is not accepted here (stripped): status changes go through PATCH /:id/status.
export const categoryBodySchema = z.object({
  name: z
    .string({ error: 'Name is required.' })
    .trim()
    .min(1, 'Name is required.')
    .max(100, 'Name must be at most 100 characters.'),
  description: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z
      .string({ error: 'Description must be text.' })
      .trim()
      .max(500, 'Description must be at most 500 characters.')
      .nullable()
      .optional(),
  ),
});
export type CategoryInput = z.infer<typeof categoryBodySchema>;

// ------------------------------------------------------------- users

export const listUsersQuerySchema = z.object({ ...paginationQueryShape, search: searchParam });
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** `{ "role": "User" | "Admin" }`. Other keys (e.g. isActive) are ignored. */
export const roleBodySchema = z.object({
  role: z.enum(['User', 'Admin'], { error: 'role must be "User" or "Admin".' }),
});
export type RoleInput = z.infer<typeof roleBodySchema>;
