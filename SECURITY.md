# Security

homeranger is a self-hosted, single-tenant app. This documents how secrets are handled, the trust boundaries the code enforces, and what to do on exposure.

## Reporting

This is a personal/single-operator tool. Report suspected vulnerabilities privately to the operator (the email in the repo owner's profile) — do not open a public issue with exploit detail.

## Secrets

**Nothing secret is committed in plaintext.** Two stores:

- **Local dev** — a gitignored `.env` (the `.gitignore` blocks `.env` / `.env.*` but allows `.env.example`). Real keys live only here, only in the main checkout. A worktree copies it in (`cp ../../.env .env`) and it stays gitignored there too. Use [`.env.example`](.env.example) as the template.
- **Cluster** — SOPS-encrypted manifests (`infra/deploy/**/secret.enc.yaml`) and Terraform vars (`infra/terraform/**/*.enc.tfvars`), encrypted to homeranger's **own** age recipient (Doxus keys cannot decrypt them and vice-versa). `.sops.yaml` holds the creation rules.

### Editing an encrypted secret

```bash
sops infra/deploy/base/secret.enc.yaml          # decrypt-edit-reencrypt in place
# the age private key lives outside the repo (see infra/deploy/flux/README.md)
```

Never `git add -f` a plaintext `.env` or a decrypted `secret.yaml`. CI runs **gitleaks** (`.gitleaks.toml`, pinned) on the full history with an allowlist for `*.enc.yaml` / `*.enc.tfvars` / `.env.example`; a plaintext secret trips it and blocks merge.

### The Supabase service-role key

`SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and is **admin/seed-script only** — it is *not* used by the running api or web (verified: absent from all runtime code; the SPA ships only the publishable anon key). Keep it out of any deployed config.

## Trust boundaries the code enforces

- **Auth** — Supabase JWT verified against the project JWKS (jose, algorithms pinned to ES256/RS256 to block alg-confusion). `protectedProcedure` fails closed (UNAUTHORIZED) on a missing/invalid token; a JWKS infra fault rethrows (500), never silently authenticates. With `SUPABASE_URL` unset the api uses the dev operator bypass **only outside production** — in production it refuses to start (fail closed).
- **Per-user isolation** — `ownerKeyFor` scopes every per-user read and write at the repository layer; zod input schemas are `.strict()` (no `userId`/`id` mass-assignment).
- **Webhooks** — the Resend inbound + events routes verify a Svix HMAC over the **raw** body with a constant-time compare and a 300s replay window, **before** any parsing or side effect; unsubscribe uses an HMAC, email-bound token. Webhook secrets are required (fail closed at boot in production).
- **Inbound sender authenticity** — the `From` is only trusted when SPF/DKIM pass *and* align with the From domain (DMARC-style); unauthenticated mail cannot forge an agent reply. Opt-out is honoured regardless (over-suppression is safe; dropping a real STOP is not).
- **Outbound HTTP** — discovery uses a fixed operator-controlled base URL; extracted `listingUrl`s are stored, never server-side fetched. Attachment download is bounded (count + per-file + aggregate byte caps; object keys sanitized against path traversal).
- **SQL** — all dynamic queries use Prisma tagged templates / `Prisma.sql`; vectors are validated and bound as a single `::vector` param. No string-interpolated SQL in app code.
- **Infra** — `homeranger` namespace is PodSecurity `restricted`, default-deny NetworkPolicy (ingress + egress), non-root workloads, no privileged/hostPath. CI Actions are SHA-pinned with least-privilege `permissions`.

## On exposure / rotation

If a secret leaks (committed by mistake, logged, shared):

1. **Rotate it at the source immediately** (Anthropic / Voyage / Resend / Cloudflare R2 + API token / Supabase / Firecrawl consoles). Rotating is the only real fix — scrubbing git history does not un-expose a key.
2. Update the gitignored `.env` and the SOPS `secret.enc.yaml` (re-encrypt), then reconcile Flux so pods pick up the new value.
3. If it reached git history, also `git push --force` a cleaned history *after* rotation, and confirm gitleaks is clean.
4. For the Resend outreach key specifically, also flip the **kill-switch** (see [`docs/runbooks/outreach-safety.md`](docs/runbooks/outreach-safety.md)) until you've confirmed no unauthorized sending occurred.

## Hardening backlog (known, accepted)

Tracked low-severity items from the security audit: tighten DMARC `p=none → quarantine → reject` after the warm-up window; optional FQDN-aware egress policy (k8s NetworkPolicy can't match hostnames); a Content-Security-Policy header on the SPA; optional Cloudflare AI Gateway authentication. None are exploitable in the current single-operator, Access-fronted deployment.
