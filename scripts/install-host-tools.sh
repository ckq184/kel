#!/usr/bin/env bash
# install-host-tools.sh — Install external tools required by host-mode agents.
#
# This script brings the host environment closer to what the Docker container
# provides (feishu-cli, agent-browser, uv, builtin MCP servers).  It is safe
# to re-run — it skips tools that are already installed and updates the
# builtin-skills cache.
#
# Usage:
#   ./scripts/install-host-tools.sh          # install everything
#   ./scripts/install-host-tools.sh skills   # only refresh builtin-skills cache
#   ./scripts/install-host-tools.sh mcp      # only install builtin MCP servers

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/data"
BUILTIN_SKILLS_DIR="$DATA_DIR/builtin-skills"
BUILTIN_MCP_DIR="$DATA_DIR/builtin-mcp"
FEISHU_CLI_VERSION="v1.35.0"
FEISHU_CLI_SOURCE_SHA256="91b5575833f003527c7b60a26f08703ebfdb348098deecfa9ceed1dcf230f253"

# ── Helpers ──────────────────────────────────────────────────

info()  { echo "  [INFO]  $*"; }
ok()    { echo "  [OK]    $*"; }
skip()  { echo "  [SKIP]  $*"; }
warn()  { echo "  [WARN]  $*" >&2; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }
verify_sha256() {
  local expected="$1"
  local file="$2"
  if has_cmd sha256sum; then
    echo "$expected  $file" | sha256sum -c -
  else
    echo "$expected  $file" | shasum -a 256 -c -
  fi
}

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH_GO="amd64" ;;
  aarch64|arm64) ARCH_GO="arm64" ;;
  *) warn "Unsupported architecture: $ARCH"; exit 1 ;;
esac
case "$OS" in
  Darwin) OS_GO="Darwin" ;;
  Linux)  OS_GO="linux" ;;
  *) warn "Unsupported OS: $OS"; exit 1 ;;
esac

# ── feishu-cli ───────────────────────────────────────────────

install_feishu_cli() {
  CURRENT_VERSION="$(feishu-cli --version 2>/dev/null || true)"
  if has_cmd feishu-cli && [[ "$CURRENT_VERSION" == *"$FEISHU_CLI_VERSION"* || "$CURRENT_VERSION" == *"${FEISHU_CLI_VERSION#v}"* ]]; then
    skip "feishu-cli already installed ($CURRENT_VERSION)"
  else
    info "Installing feishu-cli $FEISHU_CLI_VERSION..."
    VERSION="$FEISHU_CLI_VERSION"
    curl -fsSL "https://github.com/riba2534/feishu-cli/releases/download/${VERSION}/feishu-cli_${VERSION}_${OS_GO}-${ARCH_GO}.tar.gz" \
      | tar -xz --strip-components=1 -C /usr/local/bin 2>/dev/null \
      || tar -xzf <(curl -fsSL "https://github.com/riba2534/feishu-cli/releases/download/${VERSION}/feishu-cli_${VERSION}_${OS_GO}-${ARCH_GO}.tar.gz") -C /usr/local/bin
    ok "feishu-cli $VERSION installed"
  fi
}

# ── feishu-cli builtin skills cache ──────────────────────────

refresh_builtin_skills() {
  info "Refreshing builtin-skills cache in $BUILTIN_SKILLS_DIR ..."
  VERSION="$FEISHU_CLI_VERSION"

  TMP=$(mktemp -d)
  mkdir -p "$DATA_DIR"
  STAGING=$(mktemp -d "$DATA_DIR/.builtin-skills-staging.XXXXXX")
  PREVIOUS="$DATA_DIR/.builtin-skills-previous.$$"
  trap 'rm -rf "$TMP" "$STAGING" "$PREVIOUS"' RETURN
  curl -fsSL \
    -o "$TMP/feishu-cli-source.tar.gz" \
    "https://github.com/riba2534/feishu-cli/archive/refs/tags/${VERSION}.tar.gz"
  verify_sha256 "$FEISHU_CLI_SOURCE_SHA256" "$TMP/feishu-cli-source.tar.gz"
  tar -xzf "$TMP/feishu-cli-source.tar.gz" -C "$TMP"

  cp -r "$TMP"/*/skills/. "$STAGING"/
  node "$PROJECT_ROOT/scripts/builtin-skill-catalog.mjs" write "$STAGING"

  # Build completely in a same-filesystem staging directory, then swap. If
  # publication fails, restore the previous valid catalog.
  if [ -e "$BUILTIN_SKILLS_DIR" ]; then
    mv "$BUILTIN_SKILLS_DIR" "$PREVIOUS"
  fi
  if ! mv "$STAGING" "$BUILTIN_SKILLS_DIR"; then
    if [ -e "$PREVIOUS" ]; then mv "$PREVIOUS" "$BUILTIN_SKILLS_DIR"; fi
    return 1
  fi
  rm -rf "$PREVIOUS"
  ok "Cached $(find "$BUILTIN_SKILLS_DIR" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ') builtin skills (feishu-cli $VERSION)"
}

# ── agent-browser ────────────────────────────────────────────

install_agent_browser() {
  if has_cmd agent-browser; then
    skip "agent-browser already installed"
  else
    info "Installing agent-browser..."
    npm install -g agent-browser
    ok "agent-browser installed"
  fi
}

# ── uv ───────────────────────────────────────────────────────

install_uv() {
  if has_cmd uv; then
    skip "uv already installed ($(uv --version 2>/dev/null || echo 'unknown'))"
  else
    info "Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    ok "uv installed"
  fi
}

# ── builtin MCP servers (versions & hashes: scripts/builtin-mcp-catalog.mjs) ──

catalog_query() {
  node "$PROJECT_ROOT/scripts/builtin-mcp-catalog.mjs" "$@"
}

# component_field <id> <json-key> — single field from the catalog entry.
component_field() {
  catalog_query component "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=JSON.parse(d)[process.argv[1]];console.log(v===null||v===undefined?'':String(v))})" "$2"
}

install_builtin_mcp_npm() {
  local id="$1" bin_name="$2"
  if has_cmd "$bin_name"; then
    skip "$id already installed ($(command -v "$bin_name"))"
    return
  fi
  local url tarball
  url="$(component_field "$id" tarballUrl)"
  tarball="$TMP_MCP_DIR/$(basename "$url")"
  info "Installing $id from verified tarball..."
  curl -fsSL --retry 3 -o "$tarball" "$url"
  catalog_query verify "$id" "$tarball"
  npm install -g "$tarball"
  ok "$id installed"
}

install_builtin_mcp_uv_tool() {
  local id="$1" bin_name="$2"
  if has_cmd "$bin_name" && uv tool list 2>/dev/null | grep -q "^$id "; then
    skip "$id already installed"
    return
  fi
  local spec filename
  spec="$(component_field "$id" pypiPackage)==$(component_field "$id" version)"
  filename="$(component_field "$id" artifactFilename)"
  info "Installing $id from verified wheel..."
  if has_cmd pip; then
    pip download --no-deps -q -d "$TMP_MCP_DIR" "$spec"
    local wheel
    wheel="$(find "$TMP_MCP_DIR" -name "$filename" | head -n1)"
    if [ -z "$wheel" ]; then
      warn "$id wheel $filename not found after pip download"; exit 1
    fi
    catalog_query verify "$id" "$wheel"
    uv tool install "$wheel"
  else
    warn "pip not found — falling back to direct index install (artifact hash not verified)"
    uv tool install "$spec"
  fi
  ok "$id installed"
}

install_builtin_mcp() {
  if ! has_cmd node; then
    warn "node not found — cannot install builtin MCP servers"; return 1
  fi
  mkdir -p "$DATA_DIR"
  install_builtin_mcp_npm "playwright-mcp" "playwright-mcp"
  install_builtin_mcp_npm "mcp-searxng" "mcp-searxng"
  if has_cmd uv; then
    install_builtin_mcp_uv_tool "mcp-server-fetch" "mcp-server-fetch"
  else
    warn "uv not found — skipping mcp-server-fetch (run install_uv first)"
  fi
  catalog_query write "$BUILTIN_MCP_DIR"
  ok "builtin MCP catalog marker written to $BUILTIN_MCP_DIR"
}

# ── mem0ai (host-owned auto-memory sidecar library) ──────────

install_mem0ai() {
  # The auto-memory sidecar is host-owned (src/auto-memory-sidecar-manager.ts):
  # host-mode workspaces need mem0ai importable by the host python. Docker
  # images preinstall it; the version and wheel hash are pinned in
  # scripts/builtin-mcp-catalog.mjs. A missing mem0ai is not fatal — auto
  # memory degrades to an explicit "unavailable" tool result.
  local py
  if has_cmd python3; then
    py=python3
  elif has_cmd python; then
    py=python
  else
    warn "python not found — skipping mem0ai (auto memory stays unavailable)"
    return 0
  fi
  if "$py" -c "import mem0" 2>/dev/null; then
    skip "mem0ai already installed"
    return 0
  fi
  if ! "$py" -m pip --version >/dev/null 2>&1; then
    warn "pip unavailable for $py — skipping mem0ai"
    return 0
  fi
  local version filename wheel
  version="$(component_field mem0ai version)"
  filename="$(component_field mem0ai artifactFilename)"
  info "Installing mem0ai==$version from verified wheel..."
  if ! "$py" -m pip download --no-deps -q -d "$TMP_MCP_DIR" "mem0ai==$version"; then
    warn "pip download failed for mem0ai==$version"; return 0
  fi
  wheel="$(find "$TMP_MCP_DIR" -name "$filename" | head -n1)"
  if [ -z "$wheel" ]; then
    warn "mem0ai wheel $filename not found after pip download"; return 0
  fi
  catalog_query verify mem0ai "$wheel"
  "$py" -m pip install "$wheel"
  ok "mem0ai $version installed"
}

# ── Main ─────────────────────────────────────────────────────

echo "=== CKQClaw Host Tools Installer ==="
echo "    OS=$OS  ARCH=$ARCH"
echo ""

TMP_MCP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_MCP_DIR"' EXIT

if [ "${1:-}" = "skills" ]; then
  refresh_builtin_skills
  exit 0
fi

if [ "${1:-}" = "mcp" ]; then
  install_uv
  install_builtin_mcp
  exit 0
fi

install_feishu_cli
refresh_builtin_skills
install_agent_browser
install_uv
install_builtin_mcp
install_mem0ai

echo ""
echo "=== Done ==="
echo "Restart CKQClaw to pick up the new tools."
