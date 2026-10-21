import type { Prisma, RecommendationStatus, SponsorshipType } from '../generated/prisma/client.js';

/** Relations loaded for every recommendation response. Author email is never selected. */
export const recommendationInclude = {
  category: { select: { id: true, name: true } },
  createdBy: { select: { id: true, fullName: true } },
} as const satisfies Prisma.RecommendationInclude;

type RecommendationRecord = Prisma.RecommendationGetPayload<{ include: typeof recommendationInclude }>;

/**
 * The owner's sponsorship disclosure, reviewed by admins. Owner/admin views
 * only: the public sees just the sponsored label (isSponsored).
 */
export interface DisclosureDto {
  sponsorName: string;
  productName: string;
  sponsorshipType: SponsorshipType;
  disclosureDetails: string | null;
}

export interface PublicRecommendationDto {
  id: number;
  title: string;
  description: string;
  url: string | null;
  imageUrl: string | null;
  /** True only for admin-approved sponsored recommendations; drives the sponsored label. */
  isSponsored: boolean;
  category: { id: number; name: string };
  author: { id: number; fullName: string };
  createdAt: string;
  updatedAt: string;
}

/** Owner/admin view: adds workflow fields that are never shown publicly. */
export interface OwnerRecommendationDto extends PublicRecommendationDto {
  status: RecommendationStatus;
  declaresSponsored: boolean;
  /** Set exactly when declaresSponsored, in every status (pending and rejected too). */
  disclosure: DisclosureDto | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
}

/** Admin review view: the record plus the reviewer's display name (loaded separately). */
type AdminRecommendationRecord = RecommendationRecord & { reviewedBy: { id: number; fullName: string } | null };

export interface AdminRecommendationDto extends OwnerRecommendationDto {
  reviewedBy: { id: number; fullName: string } | null;
}

function toDisclosure(r: RecommendationRecord): DisclosureDto | null {
  // The DB guarantees all required details are present whenever the owner declared.
  if (!r.declaresSponsored || !r.sponsorName || !r.productName || !r.sponsorshipType) return null;
  return {
    sponsorName: r.sponsorName,
    productName: r.productName,
    sponsorshipType: r.sponsorshipType,
    disclosureDetails: r.disclosureDetails,
  };
}

export function toPublicRecommendation(r: RecommendationRecord): PublicRecommendationDto {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    url: r.url,
    imageUrl: r.imageUrl,
    isSponsored: r.isSponsored,
    category: { id: r.category.id, name: r.category.name },
    author: { id: r.createdBy.id, fullName: r.createdBy.fullName },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toOwnerRecommendation(r: RecommendationRecord): OwnerRecommendationDto {
  return {
    ...toPublicRecommendation(r),
    status: r.status,
    declaresSponsored: r.declaresSponsored,
    disclosure: toDisclosure(r),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    rejectionReason: r.rejectionReason,
  };
}

export function toAdminRecommendation(r: AdminRecommendationRecord): AdminRecommendationDto {
  return {
    ...toOwnerRecommendation(r),
    reviewedBy: r.reviewedBy ? { id: r.reviewedBy.id, fullName: r.reviewedBy.fullName } : null,
  };
}
