---
decision_id: 2026-06-01-embedding-model
status: accepted
date: 2026-06-01
gate: M0 — embedding-model (sets vector(N))
supersedes: none
---

# Decision: Embeddings = Voyage `voyage-3.5` at `vector(1024)`

## Context

homeranger vectorises (a) each listing's extracted text and (b) the user's free-text preference profile, for a pgvector cosine **top-K** retrieval, after which Claude **re-scores only the top-K** to produce the final ranking. The chosen model fixes the `vector(N)` dimension in the Prisma migration, and changing it later requires a migration **plus a full re-embed of the corpus** — so the choice is locked deliberately now.

This is a single-user, low-volume workload. The two-stage design (cheap vector recall → LLM precision re-rank) means the embedding only has to get the right candidates into the top-K bucket; it does not have to be the final arbiter of rank. That lowers the quality bar and lets cost/ops/residency drive the decision.

## Options evaluated (June 2026 research)

| Option | Dim | Quality | Residency | Cost @ single-user | Ops |
|---|---|---|---|---|---|
| Self-host `bge-base-en-v1.5` (fastembed/ONNX) | 768 | Solid (MTEB ~62–64) | **UK-resident** | £0 | +1 container, ~1GB RAM |
| Self-host `bge-small-en-v1.5` | 384 | Lower (MTEB ~56–58) | UK-resident | £0 | +1 container |
| **Voyage `voyage-3.5`** | **1024** (Matryoshka 256/512/1024/2048) | **Top of current retrieval benchmarks** | US (MongoDB-owned) | ~£0 (free tier covers a single-user corpus) | Zero infra — API call |
| Voyage `voyage-3.5-lite` | 1024 | Strong (beats OpenAI 3-large) | US | ~£0 | Zero infra |
| OpenAI `text-embedding-3-small` | 1536 | Good | US | per-token | SDK already a dep |

Anthropic has **no embeddings endpoint**, so "use Anthropic" was not an option for this layer.

## Decision

**Voyage `voyage-3.5`, output dimension 1024 → `vector(1024)`**, behind an `EmbeddingProvider` interface (keeps it swappable). Read/write via `$queryRaw`/`$executeRaw`; index `USING hnsw ("embedding" vector_cosine_ops)`.

### Why `voyage-3.5` (not -lite)
User has prior Voyage experience and chose the higher-quality tier. At single-user volume both fit inside Voyage's free token allowance, so the quality upgrade is effectively free.

### Why 1024 and **not** 2048
- **pgvector's HNSW index caps at 2000 dimensions for the `vector` type.** 2048 lands just over the line — `CREATE INDEX ... USING hnsw` on a `vector(2048)` column fails. 2048 would force either `halfvec(2048)` (half-precision, indexable to 4000) or an index-less brute-force scan. 1024 keeps the clean standard `vector` + HNSW design.
- **Embedding price is per input token, independent of output dimension** — 1024 costs the same as 2048 to generate, so larger isn't "more for the same money" in any meaningful way.
- `voyage-3.5` is Matryoshka-trained: 1024 is already near the model's peak; 1024→2048 is a ~1–2% retrieval bump that the top-K LLM re-rank stage largely erases.
- **Escape hatch:** if that last ~1–2% is ever wanted, Matryoshka lets us re-request 2048 from the *same model* and store as `halfvec(2048)` — a migration, not a model change.

### Residency
`voyage-3.5` is US-resident (Voyage is MongoDB-owned). Listing/agent text is processed in the US. **The residency waiver from the email decision is consciously extended to the data layer.** Accepted for this single-user personal tool; recorded here explicitly. If data-layer residency becomes a hard line, self-hosted `bge-base-en-v1.5` at `vector(768)` is the documented UK-resident fallback (one container, fastembed/ONNX, £0) — but it requires a re-embed + `vector(768)` migration.

## Consequences

- Add secret: `VOYAGE_API_KEY`.
- Migration declares `embedding Unsupported("vector(1024)")?` + raw `CREATE EXTENSION vector` + `vector(1024)` column + HNSW cosine index (M2).
- All embedding calls go through `EmbeddingProvider` — no direct Voyage SDK calls outside the adapter — so the model/residency choice stays reversible.
- `fastembed`/ONNX is **not** a dependency in v1 (only re-introduced if the residency fallback is taken).
