import { z } from 'zod';
import { RecommendationStatus } from '../generated/prisma/enums.js';
import { paginationQueryShape, positiveIntBody, positiveIntParam } from './common.js';

export const SORT_FIELDS = ['createdAt', 'title'] as const;
export const SORT_ORDERS = ['asc', 'desc'] as const;

export const listRecommendationsQuerySchema = z.object({
  ...paginationQueryShape,
  search: z.string({ error: 'search must be a single value.' }).trim().max(100, 'search must be at most 100 characters.').optional(),
  categoryId: positiveIntParam('categoryId').optional(),
  sortBy: z.enum(SORT_FIELDS, { error: `sortBy must be one of: ${SORT_FIELDS.join(', ')}.` }).optional(),
  sortOrder: z.enum(SORT_ORDERS, { error: `sortOrder must be one of: ${SORT_ORDERS.join(', ')}.` }).optional(),
});
export type ListRecommendationsQuery = z.infer<typeof listRecommendationsQuerySchema>;

const httpUrl = z
  .string()
  .trim()
  .max(2048, 'URL must be at most 2048 characters.')
  .pipe(z.url({ protocol: /^https?$/, error: 'Must be a valid http or https URL.' }));

// Optional URL: omitted, null or "" all mean "no URL".
const optionalHttpUrl = z.preprocess(
  (value) => (value === '' ? null : value),
  z.union([httpUrl, z.null()]).optional(),
);

// Unknown keys (status, isSponsored, declaresSponsored, createdByUserId, ...)
// are stripped: those fields are always controlled by the server.
export const recommendationBodySchema = z.object({
  title: z
    .string({ error: 'Title is required.' })
    .trim()
    .min(1, 'Title is required.')
    .max(120, 'Title must be at most 120 characters.'),
  description: z
    .string({ error: 'Description is required.' })
    .trim()
    .min(1, 'Description is required.')
    .max(3000, 'Description must be at most 3000 characters.'),
  categoryId: positiveIntBody('categoryId'),
  url: optionalHttpUrl,
  imageUrl: optionalHttpUrl,
});
export type RecommendationInput = z.infer<typeof recommendationBodySchema>;

export const updateRecommendationBodySchema = recommendationBodySchema.extend({
  /** Explicit owner choice for a Rejected recommendation: withdraw the sponsorship declaration and publish as regular. */
  publishAsRegular: z.boolean({ error: 'publishAsRegular must be true or false.' }).optional(),
});
export type UpdateRecommendationInput = z.infer<typeof updateRecommendationBodySchema>;

// Admin listing: the same filters as the public list plus an optional status
// filter. Allowed values come from the database enum; omitted = all statuses.
export const RECOMMENDATION_STATUSES = Object.values(RecommendationStatus) as [RecommendationStatus, ...RecommendationStatus[]];

export const adminListRecommendationsQuerySchema = listRecommendationsQuerySchema.extend({
  status: z.enum(RECOMMENDATION_STATUSES, { error: `status must be one of: ${RECOMMENDATION_STATUSES.join(', ')}.` }).optional(),
});
export type AdminListRecommendationsQuery = z.infer<typeof adminListRecommendationsQuerySchema>;
