import { z } from 'zod';
import { SponsorshipType } from '../generated/prisma/enums.js';
import { paginationQueryShape } from './common.js';

// ---------------------------------------------------------------- owner: disclosure

export const SPONSORSHIP_TYPES = Object.values(SponsorshipType) as [SponsorshipType, ...SponsorshipType[]];

const requiredName = (field: string, label: string) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(120, `${field} must be at most 120 characters.`);

/**
 * The disclosure an owner gives when requesting sponsored approval (or when
 * updating a pending request). Unknown keys (status, isSponsored, ...) are stripped.
 */
export const requestSponsoredBodySchema = z.object({
  sponsorName: requiredName('sponsorName', 'Sponsor (manufacturer or brand) name'),
  productName: requiredName('productName', 'Product name'),
  sponsorshipType: z.enum(SPONSORSHIP_TYPES, {
    error: `sponsorshipType must be one of: ${SPONSORSHIP_TYPES.join(', ')}.`,
  }),
  // Optional (required for Other); blank means "no details".
  disclosureDetails: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z
      .string({ error: 'disclosureDetails must be text.' })
      .trim()
      .max(1000, 'disclosureDetails must be at most 1000 characters.')
      .nullable()
      .optional(),
  ),
}).superRefine((input, ctx) => {
  // "Other" says nothing by itself: the admin needs the relationship explained.
  if (input.sponsorshipType === 'Other' && !input.disclosureDetails) {
    ctx.addIssue({
      code: 'custom',
      path: ['disclosureDetails'],
      message: 'disclosureDetails is required when sponsorshipType is Other: describe the relationship.',
    });
  }
});
export type RequestSponsoredInput = z.infer<typeof requestSponsoredBodySchema>;

// ---------------------------------------------------------------- admin: review

export const listPendingQuerySchema = z.object(paginationQueryShape);
export type ListPendingQuery = z.infer<typeof listPendingQuerySchema>;

/**
 * Required optimistic-concurrency guard: the `updatedAt` value of the version
 * the admin actually reviewed (from the pending list). If the recommendation
 * changed since then (e.g. the owner edited it), the review is refused with
 * 409 instead of approving or rejecting content the admin has not seen.
 */
const expectedUpdatedAt = z.iso
  .datetime({
    offset: true,
    error: (issue) =>
      issue.input === undefined
        ? 'expectedUpdatedAt is required: send the updatedAt of the version you reviewed.'
        : 'expectedUpdatedAt must be an ISO 8601 timestamp.',
  })
  .transform((value) => new Date(value));

// Unknown keys (isSponsored, status, reviewedByUserId, ...) are stripped:
// the outcome and reviewer are always decided by the server.
export const approveSponsoredBodySchema = z.object({ expectedUpdatedAt });
export type ApproveSponsoredInput = z.infer<typeof approveSponsoredBodySchema>;

export const rejectSponsoredBodySchema = z.object({
  expectedUpdatedAt,
  // Optional per spec §6; blank means "no reason".
  rejectionReason: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z
      .string({ error: 'rejectionReason must be text.' })
      .trim()
      .max(1000, 'rejectionReason must be at most 1000 characters.')
      .nullable()
      .optional(),
  ),
});
export type RejectSponsoredInput = z.infer<typeof rejectSponsoredBodySchema>;
