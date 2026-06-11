#!/usr/bin/env bash
# check-aide-drift.sh — verifies that the aide-synced scripts in .aide/ match
# the pinned aide core commit recorded in their `synced-from:` header.
#
# Usage: scripts/check-aide-drift.sh [--skip-if-absent]
#
# Behaviour:
#   1. Reads the `# synced-from: aide@<SHA>` header from each .aide/*.sh
#      that carries the marker.
#   2. Resolves the aide repo at ~/projects/aide (or AIDE_DIR_OVERRIDE).
#      If the repo is absent:
#        - With --skip-if-absent: emits a warning and exits 0.
#        - Without: exits 0 with a prominent warning (single-repo must work
#          standalone; absence of aide is not a failure in isolation).
#   3. Checks out the pinned SHA (using git show, not checkout — read-only).
#   4. Diffs each synced section against the corresponding aide/release/*.sh
#      at that SHA.
#   5. Exits 1 with "run the convergence update" if any drift is detected.
#
# Limitations:
#   - Only the CORE BODY of each script is compared (lines after the provenance
#     header block). homeranger-specific wrapper sections (project.env source,
#     extra data-layer checks, tRPC gate) are excluded from the diff.
#   - If the pinned SHAs across scripts differ, each is checked against its own
#     pin (allows incremental updates).
#
# Designed to be shellcheck-clean (SC2206 suppressed for intentional IFS split).

set -euo pipefail

SKIP_IF_ABSENT=false
for arg in "$@"; do
  [[ "$arg" == "--skip-if-absent" ]] && SKIP_IF_ABSENT=true
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AIDE_DIR="${AIDE_DIR_OVERRIDE:-${HOME}/projects/aide}"

warn()  { printf '[drift-check] WARNING: %s\n' "$*" >&2; }
info()  { printf '[drift-check] %s\n' "$*"; }
fail()  { printf '[drift-check] DRIFT DETECTED: %s\n' "$*" >&2; exit 1; }

# ── Locate aide repo ──────────────────────────────────────────────────────────
if [[ ! -d "$AIDE_DIR/.git" ]] && [[ ! -d "$AIDE_DIR/release" ]]; then
  warn "aide repo not found at $AIDE_DIR (set AIDE_DIR_OVERRIDE to override)."
  warn "Drift check skipped — this is a standalone single-repo. Re-run after"
  warn "cloning aide or setting AIDE_DIR_OVERRIDE."
  if [[ "$SKIP_IF_ABSENT" == "true" ]]; then
    exit 0
  fi
  # Not an error when aide is absent — homeranger is self-contained.
  exit 0
fi

info "aide repo: $AIDE_DIR"

# ── Helper: extract pinned SHA from a script header ──────────────────────────
pinned_sha() {  # $1=script_path -> prints SHA or ""
  grep -m1 '^# synced-from: aide@' "$1" 2>/dev/null \
    | sed 's/^# synced-from: aide@//' || true
}

# ── Helper: extract the CORE body from a local homeranger script ─────────────
# The local scripts have a wrapper preamble (provenance header + project.env
# sourcing block) before the actual synced core body begins. The core body
# starts at the required-var guard for MERGE_SHA, which is present in both the
# local and aide copies. Everything before that line is homeranger-specific
# wrapper code and is excluded from the diff.
core_body_local() {  # $1=script_path -> prints core body to stdout
  awk '/MERGE_SHA.*is required/{found=1} found{print}' "$1"
}

# ── Helper: get core body from aide at a given SHA ───────────────────────────
core_body_aide() {  # $1=aide_file (relative to aide root)  $2=sha -> prints to stdout
  local rel_path="$1" sha="$2"
  git -C "$AIDE_DIR" show "${sha}:${rel_path}" 2>/dev/null \
    | awk '/MERGE_SHA.*is required/{found=1} found{print}' || true
}

# ── Script → core aide path mapping ──────────────────────────────────────────
# Maps local .aide/ scripts to their corresponding aide/release/ source.
declare -A AIDE_SOURCE_MAP
AIDE_SOURCE_MAP["$REPO_ROOT/.aide/release-tag-policy.sh"]="release/release-tag-policy.sh"
AIDE_SOURCE_MAP["$REPO_ROOT/.aide/post-release-verify.sh"]="release/post-release-verify.sh"

# ── Check each mapped script ──────────────────────────────────────────────────
drift_found=false

for local_script in "${!AIDE_SOURCE_MAP[@]}"; do
  aide_rel="${AIDE_SOURCE_MAP[$local_script]}"
  basename_script="$(basename "$local_script")"

  if [[ ! -f "$local_script" ]]; then
    warn "$basename_script not found at $local_script — skipping"
    continue
  fi

  pinned="$(pinned_sha "$local_script")"
  if [[ -z "$pinned" ]]; then
    warn "$basename_script has no '# synced-from: aide@<SHA>' header — skipping drift check"
    continue
  fi

  info "checking $basename_script pinned at aide@${pinned:0:12} against $aide_rel …"

  # Verify the pinned SHA exists in the aide repo.
  if ! git -C "$AIDE_DIR" cat-file -e "${pinned}^{commit}" 2>/dev/null; then
    warn "pinned SHA $pinned not found in aide repo — cannot diff (fetch aide or update pin)"
    continue
  fi

  local_body="$(core_body_local "$local_script")"
  aide_body="$(core_body_aide "$aide_rel" "$pinned")"

  if [[ -z "$aide_body" ]]; then
    warn "aide@$pinned:$aide_rel produced empty body — path may have changed"
    continue
  fi

  # For post-release-verify.sh the local copy contains homeranger-specific
  # extras beyond the core body. We compare only the CORE gates: lines up to
  # (but not including) the first homeranger-specific section marker.
  # The marker is "── 2. Data-layer rollouts (homeranger-specific)" or
  # "── 6. tRPC routing gate (homeranger-specific)".
  # For release-tag-policy.sh the full body matches (after the wrapper preamble).
  if [[ "$basename_script" == "post-release-verify.sh" ]]; then
    # post-release-verify.sh: compare only the core gates (sections 1 through
    # the Flux gate). The homeranger-specific extras begin at section 2
    # "Data-layer rollouts". Stop diffing before that marker locally; on the
    # aide side stop before the first "VERIFY_MODE == infra" early-exit block
    # (which maps to the same boundary in the core's infra-only path).
    # Both sides start from the MERGE_SHA guard (via core_body_local/aide).
    local_body="$(core_body_local "$local_script" \
      | awk '/^# ── 2\. Data-layer rollouts/{exit} {print}')"

    aide_body="$(core_body_aide "$aide_rel" "$pinned" \
      | awk '/^\# ── 2\. App deployment rollout/{exit} /^if \[\[.*VERIFY_MODE.*==.*infra/{exit} {print}')"
  fi

  if diff_out="$(diff <(printf '%s\n' "$aide_body") <(printf '%s\n' "$local_body") 2>&1)"; then
    info "$basename_script core body matches aide@${pinned:0:12} ✓"
  else
    printf '[drift-check] DRIFT in %s vs aide@%s:%s\n' \
      "$basename_script" "${pinned:0:12}" "$aide_rel" >&2
    printf '%s\n' "$diff_out" >&2
    drift_found=true
  fi
done

# ── Current aide HEAD vs pinned SHA check ────────────────────────────────────
# Warn (not fail) when aide has advanced beyond the pinned SHA — this signals
# an available update, not a blocking drift.
aide_head="$(git -C "$AIDE_DIR" rev-parse HEAD 2>/dev/null || true)"
for local_script in "${!AIDE_SOURCE_MAP[@]}"; do
  [[ ! -f "$local_script" ]] && continue
  pinned="$(pinned_sha "$local_script")"
  [[ -z "$pinned" ]] && continue
  if [[ -n "$aide_head" ]] && [[ "$aide_head" != "$pinned" ]]; then
    warn "$(basename "$local_script") is pinned at ${pinned:0:12} but aide HEAD is ${aide_head:0:12} — an update is available. Re-run the convergence update to sync."
    break  # one warning is enough (all scripts share the same aide repo)
  fi
done

if [[ "$drift_found" == "true" ]]; then
  fail "one or more scripts have drifted from their pinned aide source. Run the convergence update (Phase B4) to re-sync."
fi

info "all synced scripts match their pinned aide core ✓"
