-- AlterTable
ALTER TABLE "recommendations" ADD COLUMN     "declaresSponsored" BOOLEAN NOT NULL DEFAULT false;

-- Hand-written: backfill. Rows already in the sponsored workflow (approved,
-- pending or rejected) were declared sponsored by their owner. Only the new
-- column is set; no other data changes.
UPDATE "recommendations"
SET "declaresSponsored" = true
WHERE "isSponsored" OR "status" IN ('PendingSponsoredApproval', 'Rejected');

-- Hand-written CHECK constraints (sponsorship disclosure).
ALTER TABLE "recommendations"
    -- Approval implies the owner declared sponsorship.
    ADD CONSTRAINT "recommendations_approved_implies_declared" CHECK (NOT "isSponsored" OR "declaresSponsored"),
    -- Pending and rejected recommendations are always declared-sponsored requests.
    ADD CONSTRAINT "recommendations_review_states_declared" CHECK ("status" NOT IN ('PendingSponsoredApproval', 'Rejected') OR "declaresSponsored"),
    -- Public recommendations disclose exactly what was declared: a declared-sponsored
    -- recommendation can only be public with an approved sponsored label.
    ADD CONSTRAINT "recommendations_published_disclosure" CHECK ("status" <> 'Published' OR "declaresSponsored" = "isSponsored");
