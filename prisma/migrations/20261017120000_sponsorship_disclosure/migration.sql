-- CreateEnum
CREATE TYPE "SponsorshipType" AS ENUM ('PaidPromotion', 'FreeProduct', 'AffiliateLink', 'OwnBusiness');

-- AlterTable
ALTER TABLE "recommendations" ADD COLUMN     "disclosureDetails" VARCHAR(1000),
ADD COLUMN     "productName" VARCHAR(120),
ADD COLUMN     "sponsorName" VARCHAR(120),
ADD COLUMN     "sponsorshipType" "SponsorshipType";

-- Hand-written: backfill. Rows declared sponsored before disclosure details
-- existed get placeholder details so the constraint below can be added.
-- Development data only: `prisma migrate reset` re-seeds with real details.
UPDATE "recommendations"
SET "sponsorName" = 'Not specified',
    "productName" = left("title", 120),
    "sponsorshipType" = 'PaidPromotion'
WHERE "declaresSponsored";

-- Hand-written CHECK constraints (sponsorship disclosure details).
ALTER TABLE "recommendations"
    -- A declaration always carries its details; without a declaration there are none.
    ADD CONSTRAINT "recommendations_disclosure_details" CHECK (
        ("declaresSponsored" AND "sponsorName" IS NOT NULL AND "productName" IS NOT NULL AND "sponsorshipType" IS NOT NULL)
        OR (NOT "declaresSponsored" AND "sponsorName" IS NULL AND "productName" IS NULL AND "sponsorshipType" IS NULL AND "disclosureDetails" IS NULL)
    ),
    ADD CONSTRAINT "recommendations_sponsorName_not_blank" CHECK ("sponsorName" IS NULL OR length(btrim("sponsorName")) > 0),
    ADD CONSTRAINT "recommendations_productName_not_blank" CHECK ("productName" IS NULL OR length(btrim("productName")) > 0);
