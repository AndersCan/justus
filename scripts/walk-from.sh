#!/usr/bin/env bash
#
# walk-from.sh — builds the release before this commit, so the release walk can install
# this build over it. The last v* tag before HEAD is checked out beside the repo and built
# the same way as this build (release, debug-signed, same key).
#
#   bash scripts/walk-from.sh
#
# Prints JUSTUS_WALK_FROM=<dir> and JUSTUS_WALK_FROM_TAG=<tag>, and appends both to
# $GITHUB_ENV when that is set.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${JUSTUS_WALK_FROM:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/justus-walk-from}"

if ! TAG="$(git -C "$REPO_ROOT" describe --tags --abbrev=0 --match 'v[0-9]*' HEAD^ 2>/dev/null)"; then
  echo "walk-from: no v* tag before this commit. The update walk starts from the last release: fetch tags (actions/checkout fetch-depth: 0)." >&2
  exit 1
fi

START="$(date +%s)"
git -C "$REPO_ROOT" worktree remove --force "$DIR" 2>/dev/null || true
rm -rf "$DIR"
git -C "$REPO_ROOT" worktree add --detach "$DIR" "refs/tags/$TAG"

if ! ( cd "$DIR" && pnpm install --frozen-lockfile \
    && cd apps/android \
    && JUSTUS_VERSION_NAME="${TAG#v}" ./gradlew :app:assembleRelease -Pjustus.deviceCheck ); then
  echo "walk-from: $TAG no longer builds with today's toolchain (output above). Fix the build, or tag a newer release." >&2
  exit 1
fi

APK="$DIR/apps/android/app/build/outputs/apk/release/app-release.apk"
if [[ ! -f "$APK" ]]; then
  echo "walk-from: $TAG built but $APK is missing" >&2
  exit 1
fi

echo "walk-from: $TAG built in $(( $(date +%s) - START )) s ($APK)"
echo "JUSTUS_WALK_FROM=$DIR"
echo "JUSTUS_WALK_FROM_TAG=$TAG"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  { echo "JUSTUS_WALK_FROM=$DIR"; echo "JUSTUS_WALK_FROM_TAG=$TAG"; } >> "$GITHUB_ENV"
fi
