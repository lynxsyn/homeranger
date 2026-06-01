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

export class SearchProfileRepository {
  /** Fetch the singleton profile, creating an empty one on first access. */
  async getOrCreate(
    _tx?: Prisma.TransactionClient,
  ): Promise<SearchProfileRecord> {
    throw new Error("not implemented");
  }

  async update(
    _input: UpdateSearchProfileInput,
    _tx?: Prisma.TransactionClient,
  ): Promise<SearchProfileRecord> {
    throw new Error("not implemented");
  }

  /**
   * Write the preference embedding (raw — Unsupported vector column). Bound as
   * a single `::vector` parameter; the singleton id is bound and cast `::uuid`.
   */
  async writePreferenceEmbedding(
    _embedding: number[],
    _tx?: Prisma.TransactionClient,
  ): Promise<number> {
    throw new Error("not implemented");
  }

  /**
   * Read the preference embedding back as a JS number[] (or null if unset).
   * pgvector renders the column as its text literal `'[a,b,c]'`; we cast to
   * text in SQL and parse here so the Unsupported column never leaks the raw
   * vector type across the repo boundary.
   */
  async readPreferenceEmbedding(
    _tx?: Prisma.TransactionClient,
  ): Promise<number[] | null> {
    throw new Error("not implemented");
  }
}

void PROFILE_SELECT;
void toVectorLiteral;

const defaultSearchProfileRepository = new SearchProfileRepository();

export let searchProfileRepository = defaultSearchProfileRepository;

export function _setSearchProfileRepositoryForTesting(
  repository: SearchProfileRepository | null,
): void {
  searchProfileRepository = repository ?? defaultSearchProfileRepository;
}
