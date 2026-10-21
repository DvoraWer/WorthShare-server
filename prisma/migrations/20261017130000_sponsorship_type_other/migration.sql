-- AlterEnum
ALTER TYPE "SponsorshipType" ADD VALUE 'Other';

-- Hand-written CHECK constraint: "Other" says nothing by itself, so the
-- relationship must be explained in the details. Compared as text because a
-- new enum value cannot be used in the transaction that adds it.
ALTER TABLE "recommendations"
    ADD CONSTRAINT "recommendations_other_requires_details" CHECK (
        "sponsorshipType" IS NULL OR "sponsorshipType"::text <> 'Other' OR length(btrim(coalesce("disclosureDetails", ''))) > 0
    );
