# homeranger Flux bootstrap

homeranger runs on the SAME shared k3s (PVE1) cluster as Doxus but shares ZERO
runtime: its own namespace (`homeranger`), Postgres, Redis, secrets, GHCR images,
and a SEPARATE Flux GitRepository + Kustomization. Doxus's Flux config
(`doxus-app/doxus-infra` `GitRepository/flux-system`) is never touched.

## What lives here

- `homeranger-source.yaml` — the `GitRepository/homeranger` + `Kustomization/homeranger`
  registered in the `flux-system` namespace, pointing at
  `ssh://git@github.com/lynxsyn/homeranger` path `./infra/deploy/overlays/pve1`,
  decrypting with `sops-age-homeranger`.
- `bootstrap-secrets.enc.yaml` — the recovery source for the two preconditions
  Flux needs before it can reconcile homeranger (Git deploy key + age key). This
  file is intentionally EXCLUDED from every `kustomization.yaml` resources list;
  it is applied imperatively only during bootstrap or break-glass.

## Why these two secrets are not self-managed by Flux

Same reasoning as Doxus (`doxus-infra/deploy/flux-system/README.md`):

- `homeranger-git-deploy-key` is required before `GitRepository/homeranger` can
  read the private repo over SSH.
- `sops-age-homeranger` is required before `Kustomization/homeranger` can decrypt
  `*.enc.yaml` under `./infra/deploy`.

Both are prerequisites for Flux itself, so they cannot be reconciled from git.
The SOPS-encrypted backup here is the recovery source of truth.

## One-time bootstrap (operator)

Pre-reqs: `kubectl` context for the PVE1 cluster, `~/.homeranger-age-key.txt`
(homeranger's age PRIVATE key), `sops`, `flux`, `kubectl` on PATH. Flux
components are ALREADY installed on the cluster by Doxus — do NOT re-run
`flux install` / re-apply gotk-components. homeranger only adds its own source.

```bash
# 0. (Once) Create a read-only deploy key for the private repo and add the
#    PUBLIC half to lynxsyn/homeranger > Settings > Deploy keys (read-only):
#      ssh-keygen -t ed25519 -C homeranger-flux -f /tmp/homeranger-deploy -N ''
#      gh repo deploy-key add /tmp/homeranger-deploy.pub \
#        --repo lynxsyn/homeranger --title homeranger-flux --read-only
#    Capture known_hosts:  ssh-keyscan github.com
#    Put identity / identity.pub / known_hosts + the age key into
#    infra/deploy/flux/bootstrap-secrets.enc.yaml and encrypt it (sops -e -i).

# 1. Decrypt + apply the two bootstrap secrets into flux-system.
SOPS_AGE_KEY_FILE="$HOME/.homeranger-age-key.txt" \
  sops -d infra/deploy/flux/bootstrap-secrets.enc.yaml \
  | kubectl apply -f -

# 2. Register the homeranger source + reconciler.
kubectl apply -f infra/deploy/flux/homeranger-source.yaml

# 3. Reconcile.
flux reconcile source git homeranger -n flux-system
flux reconcile kustomization homeranger -n flux-system --with-source
```

## Break-glass restore

```bash
SOPS_AGE_KEY_FILE="$HOME/.homeranger-age-key.txt" \
  sops -d infra/deploy/flux/bootstrap-secrets.enc.yaml | kubectl apply -f -
flux reconcile source git homeranger -n flux-system
flux reconcile kustomization homeranger -n flux-system --with-source
```

## Verification

```bash
kubectl get gitrepository homeranger -n flux-system        # Ready=True
kubectl get kustomization  homeranger -n flux-system        # Ready=True
kubectl get all -n homeranger
```

Doxus's `GitRepository/flux-system` and `Kustomization/flux-system` must remain
untouched and Ready throughout.
