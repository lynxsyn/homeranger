---
spec_id: M1-infra-scaffold
status: queued
bump: minor
risk_class: tier-3
---

# Spec: M1 — Repo + standalone-tenant infra scaffold

## Why now

INFRA-FIRST HARD-GATE: no integration or E2E test in any later milestone can run until homescout has a **standalone tenant** on the k3s hardware — its own Postgres (with `vector`), Redis, namespace, secrets, and email domain. homescout shares **no Doxus runtime**; every Doxus manifest is copied as a pattern, never imported or shared. This milestone is infra-only (no TDD per `aide/rules/infra.md`) but is gated on a concrete connectivity proof.

## Goal

A reproducible, FluxCD-managed standalone deployment target plus the pnpm/TS monorepo skeleton, such that `homescout-postgres` and `homescout-redis` are reachable from in-namespace workloads and the `vector` extension exists.

## Non-goals

- Any application logic, schema, or routers (M2+).
- Sharing any Doxus DB / Redis / namespace / secret / domain / image / CI.
- Production cold-email sending (warmup tightening happens in M6).

## Acceptance criteria

1. Monorepo skeleton mirrors `doxus-web`: root `pnpm-workspace.yaml` (`apps/*` + `packages/*`), `tsconfig.base.json` (TS strict, no `any`), `package.json` with the homescout dependency set; empty `apps/{api,processor,scheduler,web}` + `packages/{backend-core,shared}` placeholders that typecheck.
2. `infra/deploy/` contains a dedicated Flux `GitRepository` + `Kustomization` pointing at homescout's own path (Doxus's Flux config untouched).
3. Dedicated `homescout` namespace with a **default-deny** ingress/egress NetworkPolicy, then explicit allows for: intra-namespace, the Cloudflare tunnel, and egress to Resend + Voyage + Anthropic only. It cannot reach the Doxus `web` namespace.
4. `homescout-postgres` Deployment using `pgvector/pgvector:pg17` (image referenced as a pattern from `doxus-infra/deploy/base/postgres.yaml:51` — NOT the `doxus-postgres` instance), own Longhorn PVC, own `homescout` + `homescout_migrator` roles, probes, resource limits.
5. `homescout-redis` Deployment (BullMQ + warmup token bucket), own PVC/limits/probes.
6. Secrets via SOPS + **homescout's own age key/recipient** (Doxus's key must not decrypt homescout secrets): `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `RESEND_INBOUND_WEBHOOK_SECRET`, `RESEND_WEBHOOK_SECRET`, `VOYAGE_API_KEY`, `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_PASSWORD`, R2 attachment-bucket creds. Encrypted per `doxus-ops/claude/rules/sops.md` before commit.
7. `infra/terraform/cloudflare/` provisions a **dedicated email domain/zone** (not a Doxus subdomain) with Resend DKIM CNAME(s), Return-Path/MAIL FROM CNAME, SPF TXT, DMARC TXT (`p=none` for warmup), plus the tunnel/ingress hostname. Mirrors the shape of `doxus-infra/terraform/cloudflare/dns.tf`.
8. Own GHCR namespace `ghcr.io/lynxsyn/homescout-*`, a release workflow with semver tags independent of Doxus, and a `.aide/` overlay (`release-tag-policy.sh` + `post-release-verify.sh` shims with homescout's env contract) + `docs/specs/BUILD_ORDER.md` (this repo's own).
9. **Gate proof:** a one-shot job/script connects to `homescout-postgres`, runs `SELECT '[1,2,3]'::vector;` successfully, and connects to `homescout-redis` (PING). Recorded in the PR.

## Allowed edit surface

- `pnpm-workspace.yaml`, `tsconfig.base.json`, root `package.json`, `apps/*/package.json`, `packages/*/package.json` (skeletons).
- `infra/deploy/**` (Flux source/kustomization, namespace, NetworkPolicy, postgres, redis, sealed secrets).
- `infra/terraform/cloudflare/**` (zone + Resend DNS + tunnel hostname).
- `.aide/**`, `.github/workflows/**` (release + image build).

## Test plan

| Layer | Coverage |
|---|---|
| Infra gate | `homescout-postgres` reachable from in-namespace; `SELECT '…'::vector` succeeds (extension present). |
| Infra gate | `homescout-redis` reachable (PING) from in-namespace; unreachable from Doxus `web` namespace (NetworkPolicy proof). |
| Infra gate | `flux reconcile` brings the homescout Kustomization to Ready without touching Doxus resources. |
| Manual | DNS records resolve; Resend domain verification passes (DKIM/SPF/DMARC green). |

No unit/E2E — infra-only per `infra.md`. Later milestones depend on this gate passing.

## Definition of Done

Flux reconciles homescout green · gate proof recorded · secrets SOPS-encrypted with the homescout age key · release tag (MINOR) cut · post-release verify (`/api/health` once api exists is M2+; for M1, the DB/Redis/Flux gate is the verify).
