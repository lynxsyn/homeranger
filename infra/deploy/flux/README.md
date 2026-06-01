# homescout Flux bootstrap

homescout runs on the SAME shared k3s (PVE1) cluster as Doxus but shares ZERO
runtime: its own namespace (`homescout`), Postgres, Redis, secrets, GHCR images,
and a SEPARATE Flux GitRepository + Kustomization. Doxus's Flux config
(`doxus-app/doxus-infra` `GitRepository/flux-system`) is never touched.

## What lives here

- `homescout-source.yaml` — the `GitRepository/homescout` + `Kustomization/homescout`
  registered in the `flux-system` namespace, pointing at
  `ssh://git@github.com/lynxsyn/homescout` path `./infra/deploy/overlays/pve1`,
  decrypting with `sops-age-homescout`.
- `bootstrap-secrets.enc.yaml` — the recovery source for the two preconditions
  Flux needs before it can reconcile homescout (Git deploy key + age key). This
  file is intentionally EXCLUDED from every `kustomization.yaml` resources list;
  it is applied imperatively only during bootstrap or break-glass.

## Why these two secrets are not self-managed by Flux

Same reasoning as Doxus (`doxus-infra/deploy/flux-system/README.md`):

- `homescout-git-deploy-key` is required before `GitRepository/homescout` can
  read the private repo over SSH.
- `sops-age-homescout` is required before `Kustomization/homescout` can decrypt
  `*.enc.yaml` under `./infra/deploy`.

Both are prerequisites for Flux itself, so they cannot be reconciled from git.
The SOPS-encrypted backup here is the recovery source of truth.

## One-time bootstrap (operator)

Pre-reqs: `kubectl` context for the PVE1 cluster, `~/.homescout-age-key.txt`
(homescout's age PRIVATE key), `sops`, `flux`, `kubectl` on PATH. Flux
components are ALREADY installed on the cluster by Doxus — do NOT re-run
`flux install` / re-apply gotk-components. homescout only adds its own source.

```bash
# 0. (Once) Create a read-only deploy key for the private repo and add the
#    PUBLIC half to lynxsyn/homescout > Settings > Deploy keys (read-only):
#      ssh-keygen -t ed25519 -C homescout-flux -f /tmp/homescout-deploy -N ''
#      gh repo deploy-key add /tmp/homescout-deploy.pub \
#        --repo lynxsyn/homescout --title homescout-flux --read-only
#    Capture known_hosts:  ssh-keyscan github.com
#    Put identity / identity.pub / known_hosts + the age key into
#    infra/deploy/flux/bootstrap-secrets.enc.yaml and encrypt it (sops -e -i).

# 1. Decrypt + apply the two bootstrap secrets into flux-system.
SOPS_AGE_KEY_FILE="$HOME/.homescout-age-key.txt" \
  sops -d infra/deploy/flux/bootstrap-secrets.enc.yaml \
  | kubectl apply -f -

# 2. Register the homescout source + reconciler.
kubectl apply -f infra/deploy/flux/homescout-source.yaml

# 3. Reconcile.
flux reconcile source git homescout -n flux-system
flux reconcile kustomization homescout -n flux-system --with-source
```

## Break-glass restore

```bash
SOPS_AGE_KEY_FILE="$HOME/.homescout-age-key.txt" \
  sops -d infra/deploy/flux/bootstrap-secrets.enc.yaml | kubectl apply -f -
flux reconcile source git homescout -n flux-system
flux reconcile kustomization homescout -n flux-system --with-source
```

## Verification

```bash
kubectl get gitrepository homescout -n flux-system        # Ready=True
kubectl get kustomization  homescout -n flux-system        # Ready=True
kubectl get all -n homescout
```

Doxus's `GitRepository/flux-system` and `Kustomization/flux-system` must remain
untouched and Ready throughout.
