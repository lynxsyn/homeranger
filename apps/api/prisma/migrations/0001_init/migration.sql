-- CreateEnum
CREATE TYPE "Tenure" AS ENUM ('freehold', 'leasehold', 'share_of_freehold', 'commonhold', 'unknown');

-- CreateEnum
CREATE TYPE "PropertyType" AS ENUM ('detached', 'semi_detached', 'terraced', 'flat', 'maisonette', 'bungalow', 'cottage', 'land', 'other', 'unknown');

-- CreateEnum
CREATE TYPE "EpcRating" AS ENUM ('a', 'b', 'c', 'd', 'e', 'f', 'g', 'unknown');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('pre_market', 'live', 'under_offer', 'sold', 'withdrawn');

-- CreateEnum
CREATE TYPE "ListingSource" AS ENUM ('agent_email', 'manual');

-- CreateEnum
CREATE TYPE "EmailAuthVerdict" AS ENUM ('pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'unknown');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "MailboxType" AS ENUM ('corporate_subscriber', 'individual', 'unknown');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('unsubscribe', 'hard_bounce', 'spam_complaint', 'manual');

-- CreateEnum
CREATE TYPE "EmailEventType" AS ENUM ('delivered', 'bounced', 'complained', 'opened', 'clicked', 'deferred', 'failed');

-- CreateTable
CREATE TABLE "Listing" (
    "id" UUID NOT NULL,
    "addressNormalized" TEXT NOT NULL,
    "addressRaw" TEXT,
    "postcode" TEXT,
    "outcode" TEXT,
    "pricePence" INTEGER,
    "bedrooms" INTEGER,
    "bathrooms" INTEGER,
    "tenure" "Tenure",
    "propertyType" "PropertyType",
    "epcRating" "EpcRating",
    "listingStatus" "ListingStatus" NOT NULL DEFAULT 'pre_market',
    "isPreMarket" BOOLEAN NOT NULL DEFAULT false,
    "listingUrl" TEXT,
    "primarySource" "ListingSource" NOT NULL DEFAULT 'agent_email',
    -- "embedding" vector(1024) is added by 0002_pgvector (needs CREATE EXTENSION
    -- first). Prisma maps it as Unsupported("vector(1024)") and ignores it for
    -- drift detection, so omitting it here keeps `migrate diff` clean.
    "firstSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingSourceRecord" (
    "id" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "sourceType" "ListingSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "rawPayload" JSONB,
    "observedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ListingSourceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhotoAnalysis" (
    "id" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "imageHash" TEXT NOT NULL,
    "imageUrl" TEXT,
    "tasteScore" INTEGER,
    "featuresJson" JSONB NOT NULL DEFAULT '{}',
    "model" TEXT NOT NULL,
    "costPence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PhotoAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingScore" (
    "id" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "vectorScore" DOUBLE PRECISION NOT NULL,
    "llmScore" DOUBLE PRECISION,
    "combinedScore" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT,
    "scoredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ListingScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchProfile" (
    "id" UUID NOT NULL,
    "freeTextPreferences" TEXT NOT NULL DEFAULT '',
    "minBedrooms" INTEGER,
    "maxPricePence" INTEGER,
    "outcodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredTenure" "Tenure",
    -- "preferenceEmbedding" vector(1024) is added by 0002_pgvector (Unsupported;
    -- ignored for drift detection).
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SearchProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "agencyName" TEXT,
    "contactName" TEXT,
    "mailboxType" "MailboxType" NOT NULL DEFAULT 'unknown',
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "coveredOutcodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastContactedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachThread" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "subject" TEXT,
    "lastMessageAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OutreachThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachMessage" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "spfVerdict" "EmailAuthVerdict" NOT NULL DEFAULT 'unknown',
    "dkimVerdict" "EmailAuthVerdict" NOT NULL DEFAULT 'unknown',
    "parsedListingIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "sentAt" TIMESTAMPTZ(6),
    "receivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OutreachMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionEntry" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SuppressionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" UUID NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "messageId" TEXT,
    "email" TEXT NOT NULL,
    "eventType" "EmailEventType" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupState" (
    "id" UUID NOT NULL,
    "dailyCap" INTEGER NOT NULL DEFAULT 20,
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "windowDate" DATE NOT NULL,
    "rampStartedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WarmupState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Listing_addressNormalized_key" ON "Listing"("addressNormalized");

-- CreateIndex
CREATE INDEX "Listing_outcode_idx" ON "Listing"("outcode");

-- CreateIndex
CREATE INDEX "Listing_postcode_idx" ON "Listing"("postcode");

-- CreateIndex
CREATE INDEX "Listing_listingStatus_lastSeenAt_idx" ON "Listing"("listingStatus", "lastSeenAt" DESC);

-- CreateIndex
CREATE INDEX "Listing_pricePence_idx" ON "Listing"("pricePence");

-- CreateIndex
CREATE INDEX "ListingSourceRecord_listingId_idx" ON "ListingSourceRecord"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingSourceRecord_sourceType_externalId_key" ON "ListingSourceRecord"("sourceType", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "PhotoAnalysis_imageHash_key" ON "PhotoAnalysis"("imageHash");

-- CreateIndex
CREATE INDEX "PhotoAnalysis_listingId_idx" ON "PhotoAnalysis"("listingId");

-- CreateIndex
CREATE INDEX "ListingScore_combinedScore_idx" ON "ListingScore"("combinedScore" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ListingScore_listingId_key" ON "ListingScore"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_email_key" ON "Agent"("email");

-- CreateIndex
CREATE INDEX "Agent_optedOut_idx" ON "Agent"("optedOut");

-- CreateIndex
CREATE INDEX "OutreachThread_agentId_idx" ON "OutreachThread"("agentId");

-- CreateIndex
CREATE INDEX "OutreachThread_lastMessageAt_idx" ON "OutreachThread"("lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "OutreachMessage_threadId_idx" ON "OutreachMessage"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachMessage_providerMessageId_key" ON "OutreachMessage"("providerMessageId");

-- CreateIndex
CREATE INDEX "SuppressionEntry_email_idx" ON "SuppressionEntry"("email");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressionEntry_email_reason_key" ON "SuppressionEntry"("email", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "EmailEvent_providerEventId_key" ON "EmailEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "EmailEvent_email_idx" ON "EmailEvent"("email");

-- CreateIndex
CREATE INDEX "EmailEvent_eventType_occurredAt_idx" ON "EmailEvent"("eventType", "occurredAt" DESC);

-- AddForeignKey
ALTER TABLE "ListingSourceRecord" ADD CONSTRAINT "ListingSourceRecord_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoAnalysis" ADD CONSTRAINT "PhotoAnalysis_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingScore" ADD CONSTRAINT "ListingScore_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachThread" ADD CONSTRAINT "OutreachThread_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "OutreachThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
