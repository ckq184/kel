#!/usr/bin/env bash
# Copy canonical shared types to all sub-projects.
# Called by `make build` and `make sync-types`.
# Only copies when content differs, to avoid unnecessary timestamp changes
# that would trigger redundant incremental builds.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Copy file only if content differs
sync_file() {
  local src="$1" target="$2"
  if [ ! -f "$target" ] || ! cmp -s "$src" "$target"; then
    cp "$src" "$target"
  fi
}

# --- StreamEvent types (3 targets) ---
SRC_SE="$ROOT/shared/stream-event.ts"
for target in \
  "$ROOT/container/agent-runner/src/stream-event.types.ts" \
  "$ROOT/src/stream-event.types.ts" \
  "$ROOT/web/src/stream-event.types.ts" \
; do
  sync_file "$SRC_SE" "$target"
done

# --- Image detector (2 targets: backend + agent-runner; not needed by web) ---
SRC_ID="$ROOT/shared/image-detector.ts"
for target in \
  "$ROOT/src/image-detector.ts" \
  "$ROOT/container/agent-runner/src/image-detector.ts" \
; do
  sync_file "$SRC_ID" "$target"
done

# --- Channel prefixes (backend only; agent-runner copy was an unused orphan,
# removed in ISSUE-10) ---
SRC_CP="$ROOT/shared/channel-prefixes.ts"
sync_file "$SRC_CP" "$ROOT/src/channel-prefixes.ts"

# --- Canonical JSON (2 targets: backend + agent-runner; HMAC-signature red line) ---
SRC_CJ="$ROOT/shared/canonical-json.ts"
for target in \
  "$ROOT/src/canonical-json.ts" \
  "$ROOT/container/agent-runner/src/canonical-json.ts" \
; do
  sync_file "$SRC_CJ" "$target"
done

# --- Model suffix (2 targets: backend + agent-runner) ---
SRC_MS="$ROOT/shared/model-suffix.ts"
for target in \
  "$ROOT/src/model-suffix.ts" \
  "$ROOT/container/agent-runner/src/model-suffix.ts" \
; do
  sync_file "$SRC_MS" "$target"
done
