#!/usr/bin/env bash
# homescout release-tag policy. SELF-CONTAINED (no doxus-ops delegation).
#
# Doxus's .aide/release-tag-policy.sh is a thin shim that execs the canonical
# at doxus-ops/scripts/release/release-tag-policy.sh. homescout is a SINGLE
# repo with its OWN overlay independent of doxus-ops, so the canonical logic
# is inlined here verbatim (doxus-ops PR #531 body).
#
# Called by /aide:compound Step 4.5 with env: MERGE_SHA, SPEC_ID, SPEC_NAME,
# optional BUMP_HINT (fix => PATCH). Emits the new vX.Y.Z tag on stdout, pushes
# it to origin (which triggers .github/workflows/release.yml). Bump rules:
#   MINOR  per spec merge (default)
#   PATCH  for fix/chore follow-ups (BUMP_HINT=fix, or fix:/chore: subject)
#   MAJOR  for breaking merges (feat!:/fix!: subject or BREAKING CHANGE: footer)

set -euo pipefail

: "${MERGE_SHA:?MERGE_SHA is required}"
: "${SPEC_ID:?SPEC_ID is required}"
: "${SPEC_NAME:?SPEC_NAME is required}"

# Globally-highest semver tag — never `git describe` (it walks HEAD ancestry
# and can pick an older tag when a parallel merge took the newer one).
git fetch --tags --quiet origin 2>/dev/null || true
LAST="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)"
# Seed at v0.0.0 so the FIRST milestone (M1) becomes v0.1.0 — homescout is a
# pre-1.0 greenfield tool (matches the v0.1.0 / range >=0.1.0 image-automation seed).
[ -z "$LAST" ] && LAST="v0.0.0"

if [[ ! "$LAST" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "release-tag-policy: cannot parse latest tag '$LAST' as vX.Y.Z" >&2
  exit 1
fi

MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"

COMMIT_SUBJECT="$(git log -1 --format=%s "$MERGE_SHA" 2>/dev/null || echo '')"
COMMIT_BODY="$(git log -1 --format=%b "$MERGE_SHA" 2>/dev/null || echo '')"
BUMP_KIND="minor"

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
