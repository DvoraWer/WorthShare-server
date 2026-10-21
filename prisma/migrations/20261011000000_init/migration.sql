-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Hand-written: case-insensitive text type for category names.
-- citext is a trusted extension (PostgreSQL 13+); the database owner can create it.
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('User', 'Admin');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('Published', 'PendingSponsoredApproval', 'Rejected', 'Removed');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "fullName" VARCHAR(100) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'User',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "name" CITEXT NOT NULL,
    "description" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(3000) NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "url" VARCHAR(2048),
    "imageUrl" VARCHAR(2048),
    "createdByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "isSponsored" BOOLEAN NOT NULL DEFAULT false,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'Published',
    "reviewedByUserId" INTEGER,
    "reviewedAt" TIMESTAMPTZ(3),
    "rejectionReason" VARCHAR(1000),

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_isActive_idx" ON "users"("role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE INDEX "recommendations_status_createdAt_idx" ON "recommendations"("status", "createdAt");

-- CreateIndex
CREATE INDEX "recommendations_status_title_idx" ON "recommendations"("status", "title");

-- CreateIndex
CREATE INDEX "recommendations_categoryId_status_createdAt_idx" ON "recommendations"("categoryId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "recommendations_createdByUserId_createdAt_idx" ON "recommendations"("createdByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "recommendations_reviewedByUserId_idx" ON "recommendations"("reviewedByUserId");

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written CHECK constraints (not expressible in the Prisma schema).
-- Prisma does not track CHECK constraints, so later migrations will not drop them.

ALTER TABLE "users"
    ADD CONSTRAINT "users_fullName_not_blank" CHECK (length(btrim("fullName")) > 0),
    ADD CONSTRAINT "users_email_normalized" CHECK ("email" = lower(btrim("email")) AND length("email") > 0);

ALTER TABLE "categories"
    ADD CONSTRAINT "categories_name_not_blank" CHECK (length(btrim("name")) > 0);

ALTER TABLE "recommendations"
    ADD CONSTRAINT "recommendations_title_not_blank" CHECK (length(btrim("title")) > 0),
    ADD CONSTRAINT "recommendations_description_not_blank" CHECK (length(btrim("description")) > 0),
    ADD CONSTRAINT "recommendations_url_http" CHECK ("url" IS NULL OR "url" ~* '^https?://'),
    ADD CONSTRAINT "recommendations_imageUrl_http" CHECK ("imageUrl" IS NULL OR "imageUrl" ~* '^https?://'),
    -- Only approved (published) or later-removed recommendations may carry the sponsored flag.
    ADD CONSTRAINT "recommendations_sponsored_status" CHECK (NOT "isSponsored" OR "status" IN ('Published', 'Removed')),
    -- Reviewer and review time are recorded together.
    ADD CONSTRAINT "recommendations_review_pair" CHECK (("reviewedByUserId" IS NULL) = ("reviewedAt" IS NULL));
