#!/usr/bin/env bash
# synced-from: aide@f0452f88a2b90cb654b431ae75da3e026fc6ad43
# drift-check: scripts/check-aide-drift.sh
#
# homeranger release-tag policy. SELF-CONTAINED (no ops-repo delegation).
# Core body synced from aide release/release-tag-policy.sh; homeranger-specific
# defaults (TAG_SEED, project context) applied via .aide/project.env below.
#
# Called by /aide:compound Step 4.5 with env: MERGE_SHA, SPEC_ID, SPEC_NAME,
# optional BUMP_HINT (fix => PATCH). Emits the new vX.Y.Z tag on stdout,
# pushes it to origin (which triggers .github/workflows/release.yml).
#
# Bump rules (in priority order):
#   MAJOR  — feat!:, fix!:, refactor(scope)!:, or BREAKING CHANGE: footer
#   PATCH  — BUMP_HINT=fix, or fix:/chore: subject prefix
#   MINOR  — everything else (default)
#
# Exit codes:
#   0  — success; new tag printed on stdout
#   1  — cannot parse latest tag as vX.Y.Z, or invalid MERGE_SHA
#   2  — tag already exists (idempotent guard)

set -euo pipefail

# Source project.env for TAG_SEED and AIDE_PROJECT. Env vars already set in
# the caller's environment take precedence — project.env is defaults only.
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$_SCRIPT_DIR/project.env" ]]; then
  while IFS= read -r _line || [[ -n "$_line" ]]; do
    [[ "$_line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${_line// }" ]] && continue
    _var="${_line%%=*}"
    if [[ -n "$_var" ]] && [[ "${_var}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      if [[ -z "${!_var+x}" ]]; then
        # shellcheck disable=SC2163
        export "$_line"
      fi
    fi
  done < "$_SCRIPT_DIR/project.env"
fi

: "${MERGE_SHA:?MERGE_SHA is required}"
: "${SPEC_ID:?SPEC_ID is required}"
: "${SPEC_NAME:?SPEC_NAME is required}"

TAG_SEED="${TAG_SEED:-v0.0.0}"

# Fetch tags first so a stale local clone doesn't re-use a deployed tag.
git fetch --tags --quiet origin 2>/dev/null || true

LAST="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)"
[ -z "$LAST" ] && LAST="$TAG_SEED"

if [[ ! "$LAST" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "release-tag-policy: cannot parse latest tag '$LAST' as vX.Y.Z" >&2
  exit 1
fi

MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"

# Decide bump kind. MERGE_SHA must resolve to a real commit — otherwise the
# subject/body reads would silently come back empty and default to MINOR.
git rev-parse -q --verify "$MERGE_SHA^{commit}" >/dev/null || {
  echo "release-tag-policy: invalid MERGE_SHA '$MERGE_SHA' — not a commit in this repo" >&2
  exit 1
}
COMMIT_SUBJECT="$(git log -1 --format=%s "$MERGE_SHA")"
COMMIT_BODY="$(git log -1 --format=%b "$MERGE_SHA")"
BUMP_KIND="minor"

# Breaking change beats everything else. Conventional-commits signals.
# Matches: "feat!: ...", "feat(scope)!: ...", "fix!: ...", "refactor(api)!: ..."
CC_BREAKING_RE='^[a-zA-Z]+(\([^)]*\))?!:'
CC_FIX_CHORE_RE='^(fix|chore)(\([^)]*\))?:'

if printf '%s' "$COMMIT_SUBJECT" | grep -qE "$CC_BREAKING_RE"; then
  BUMP_KIND="major"
elif printf '%s' "$COMMIT_BODY" | grep -qE '^BREAKING CHANGE:'; then
  BUMP_KIND="major"
elif [[ "${BUMP_HINT:-}" == "fix" ]]; then
  BUMP_KIND="patch"
elif printf '%s' "$COMMIT_SUBJECT" | grep -qE "$CC_FIX_CHORE_RE"; then
  BUMP_KIND="patch"
fi

case "$BUMP_KIND" in
  major)
    NEW_MAJOR=$((MAJOR + 1))
    NEW_TAG="v${NEW_MAJOR}.0.0"
    ;;
  minor)
    NEW_MINOR=$((MINOR + 1))
    NEW_TAG="v${MAJOR}.${NEW_MINOR}.0"
    ;;
  patch)
    NEW_PATCH=$((PATCH + 1))
    NEW_TAG="v${MAJOR}.${MINOR}.${NEW_PATCH}"
    ;;
esac

if git rev-parse -q --verify "refs/tags/${NEW_TAG}" >/dev/null; then
  echo "release-tag-policy: tag ${NEW_TAG} already exists" >&2
  exit 2
fi

git tag -a "$NEW_TAG" "$MERGE_SHA" -m "${SPEC_ID}: ${SPEC_NAME}" >&2
git push origin "$NEW_TAG" >&2

echo "$NEW_TAG"
