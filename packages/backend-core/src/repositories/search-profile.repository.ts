/**
 * SearchProfile repository — owns all Prisma access for the single-row search
 * profile (the one user's buying preferences). Like the Listing embedding, the
 * `preferenceEmbedding` column is `Unsupported("vector(1024)")` and so is
 * read/written only via raw SQL. The profile is keyed on a stable singleton id
 * so `getOrCreate` always converges on one row.
 */
import { Prisma, type Tenure } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { EMBEDDING_DIMENSIONS } from "./listing.repository.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

/**
 * Deterministic singleton id for the one SearchProfile row. Using a fixed UUID
 * (rather than "first row") makes getOrCreate race-safe via upsert and keeps
 * the single-row invariant explicit in the schema's default.
 */
export const SEARCH_PROFILE_SINGLETON_ID =
  "00000000-0000-0000-0000-000000000001";

const PROFILE_SELECT = Prisma.validator<Prisma.SearchProfileSelect>()({
  id: true,
  freeTextPreferences: true,
  minBedrooms: true,
  maxPricePence: true,
  outcodes: true,
  requiredTenure: true,
  // Buyer identity — signs + paces outreach (Settings "Your details").
  firstName: true,
  lastName: true,
  phone: true,
  urgency: true,
  createdAt: true,
  updatedAt: true,
  // preferenceEmbedding is Unsupported("vector(1024)") — raw access only.
});

export type SearchProfileRecord = Prisma.SearchProfileGetPayload<{
  select: typeof PROFILE_SELECT;
}>;

export interface UpdateSearchProfileInput {
  freeTextPreferences?: string | null;
  minBedrooms?: number | null;
  maxPricePence?: number | null;
  outcodes?: string[];
  requiredTenure?: Tenure | null;
  // Buyer identity (Settings "Your details"). Stored NOT NULL with "" defaults,
  // so a null/undefined clears to "" rather than NULL.
  firstName?: string;
  lastName?: string;
  phone?: string;
  urgency?: string;
}

function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding must have ${EMBEDDING_DIMENSIONS} dimensions, received ${embedding.length}`,
    );
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error("Embedding contains a non-finite value");
    }
  }
  return `[${embedding.join(",")}]`;
}

/**
 * Parse a pgvector text literal `[a,b,c]` back into a validated number[].
 * Mirrors the write-path guarantees (exactly EMBEDDING_DIMENSIONS, all finite)
 * so a malformed/wrong-dimension stored vector surfaces as a clear error rather
 * than a silent bad array (e.g. an empty literal parsing to [NaN]).
 */
function fromVectorLiteral(raw: string): number[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (inner === "") {
    throw new Error("Stored preference embedding is empty");
  }
  const values = inner.split(",").map((value) => Number(value));
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Stored embedding must have ${EMBEDDING_DIMENSIONS} dimensions, read ${values.length}`,
    );
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error("Stored embedding contains a non-finite value");
    }
  }
  return values;
}

export class SearchProfileRepository {
  /** Fetch the singleton profile, creating an empty one on first access. */
  async getOrCreate(tx?: Prisma.TransactionClient): Promise<SearchProfileRecord> {
    const db: PrismaLike = tx ?? prisma;
    return db.searchProfile.upsert({
      where: { id: SEARCH_PROFILE_SINGLETON_ID },
      create: { id: SEARCH_PROFILE_SINGLETON_ID, outcodes: [] },
      update: {},
      select: PROFILE_SELECT,
    });
  }

  async update(
    input: UpdateSearchProfileInput,
    tx?: Prisma.TransactionClient,
  ): Promise<SearchProfileRecord> {
    const db: PrismaLike = tx ?? prisma;
    // Ensure the singleton exists, then apply the partial update so callers do
    // not have to seed it first.
    await this.getOrCreate(tx);
    return db.searchProfile.update({
      where: { id: SEARCH_PROFILE_SINGLETON_ID },
      data: {
        ...(input.freeTextPreferences !== undefined
          ? { freeTextPreferences: input.freeTextPreferences ?? "" }
          : {}),
        ...(input.minBedrooms !== undefined
          ? { minBedrooms: input.minBedrooms }
          : {}),
        ...(input.maxPricePence !== undefined
          ? { maxPricePence: input.maxPricePence }
          : {}),
        ...(input.outcodes !== undefined ? { outcodes: input.outcodes } : {}),
        ...(input.requiredTenure !== undefined
          ? { requiredTenure: input.requiredTenure }
          : {}),
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.urgency !== undefined ? { urgency: input.urgency } : {}),
      },
      select: PROFILE_SELECT,
    });
  }

  /**
   * Write the preference embedding (raw — Unsupported vector column). Bound as
   * a single `::vector` parameter; the singleton id is bound and cast `::uuid`.
   */
  async writePreferenceEmbedding(
    embedding: number[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const db: PrismaLike = tx ?? prisma;
    const literal = toVectorLiteral(embedding);
    return db.$executeRaw`
      UPDATE "SearchProfile"
      SET "preferenceEmbedding" = ${literal}::vector,
          "updatedAt" = NOW()
      WHERE "id" = ${SEARCH_PROFILE_SINGLETON_ID}::uuid
    `;
  }

  /**
   * Read the preference embedding back as a JS number[] (or null if unset).
   * pgvector renders the column as its text literal `'[a,b,c]'`; we cast to
   * text in SQL and parse here so the Unsupported column never leaks the raw
   * vector type across the repo boundary.
   */
  async readPreferenceEmbedding(
    tx?: Prisma.TransactionClient,
  ): Promise<number[] | null> {
    const db: PrismaLike = tx ?? prisma;
    const rows = await db.$queryRaw<Array<{ embedding: string | null }>>`
      SELECT "preferenceEmbedding"::text AS "embedding"
      FROM "SearchProfile"
      WHERE "id" = ${SEARCH_PROFILE_SINGLETON_ID}::uuid
    `;
    const raw = rows[0]?.embedding;
    if (!raw) {
      return null;
    }
    return fromVectorLiteral(raw);
  }
}

const defaultSearchProfileRepository = new SearchProfileRepository();

export let searchProfileRepository = defaultSearchProfileRepository;

export function _setSearchProfileRepositoryForTesting(
  repository: SearchProfileRepository | null,
): void {
  searchProfileRepository = repository ?? defaultSearchProfileRepository;
}
