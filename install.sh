#!/usr/bin/env bash
#
# AegisX-Worker installer.
#
#   curl -fsSL https://raw.githubusercontent.com/aegisxresearch/AegisX-Worker/main/install.sh | bash
#
# What it does, in order: checks the toolchain, fetches the source (git, or the
# release tarball when git is missing), installs the workspace dependencies,
# builds the browser bundle, and makes `aegisxworker` available on PATH. It never
# uses sudo, never writes outside the install folder (and, for the PATH wrapper,
# ~/.local/bin), and re-running it updates an existing install in place.
#
# Read it before piping it to a shell — that is what the `--dry-run` flag is for.
#
set -Eeuo pipefail

REPO_SLUG="aegisxresearch/AegisX-Worker"
REPO_URL="https://github.com/${REPO_SLUG}.git"
TARBALL_URL="https://codeload.github.com/${REPO_SLUG}/tar.gz"
DEFAULT_REF="main"
DEFAULT_DIR="${AEGISX_HOME:-$HOME/.aegisx-worker}"
MARKER=".aegisx-install"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=6

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$BOLD" "$*" "$RESET"; }
warn() { printf '%s! %s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
die()  { printf '%serror: %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# Only real command failures reach this trap; `die` exits on its own message.
trap 'status=$?; printf "\n%sinstall failed (exit %s) at line %s.%s\n" "$RED" "$status" "$LINENO" "$RESET" >&2' ERR

usage() {
  cat <<EOF
${BOLD}AegisX-Worker installer${RESET}

Usage:
  install.sh [options]

Options:
  --dir <path>     Install folder (default: \$AEGISX_HOME or ~/.aegisx-worker)
  --ref <ref>      Branch or tag to install (default: ${DEFAULT_REF})
  --tarball        Download the source archive instead of using git
  --no-build       Skip the client build (the CLI builds it on first run)
  --no-link        Do not install the \`aegisxworker\` command
  --dry-run        Print what would happen and exit
  -h, --help       Show this help

Environment:
  AEGISX_HOME      Default install folder
  NO_COLOR         Disable colour output

Examples:
  curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh | bash
  ./install.sh --dir ~/src/aegisx --ref v0.1.0
  ./install.sh --no-link --dry-run
EOF
}

DIR="$DEFAULT_DIR"
REF="$DEFAULT_REF"
DO_BUILD=1
DO_LINK=1
DRY_RUN=0
FETCH="auto"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)      [ $# -ge 2 ] || die "--dir needs a path"; DIR="$2"; shift 2 ;;
    --dir=*)    DIR="${1#*=}"; shift ;;
    --ref)      [ $# -ge 2 ] || die "--ref needs a branch or tag"; REF="$2"; shift 2 ;;
    --ref=*)    REF="${1#*=}"; shift ;;
    --tarball)  FETCH="tarball"; shift ;;
    --no-build) DO_BUILD=0; shift ;;
    --no-link)  DO_LINK=0; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          die "unknown option: $1 (try --help)" ;;
  esac
done

case "$DIR" in
  "~"|"~/"*) DIR="$HOME${DIR#\~}" ;;
esac
[ -n "$DIR" ] || die "the install folder resolved to an empty path"

step "Checking the toolchain"
command -v node >/dev/null 2>&1 || die "Node.js is required: https://nodejs.org (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR})"
command -v npm  >/dev/null 2>&1 || die "npm is required and ships with Node.js"
command -v tar  >/dev/null 2>&1 || die "tar is required"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  die "Node.js $(node -v) is too old — ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer is required (this project runs TypeScript natively)."
fi

if [ "$FETCH" = "auto" ]; then
  if command -v git >/dev/null 2>&1; then FETCH="git"; else FETCH="tarball"; fi
fi
if [ "$FETCH" = "tarball" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required to download the source archive"
fi

case "$(uname -s)" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="macos" ;;
  *)      PLATFORM="other"; warn "this installer is tested on Linux and macOS; continuing on $(uname -s)" ;;
esac
if [ "$PLATFORM" = "other" ] && printf '%s' "$(uname -s)" | grep -qi 'mingw\|msys\|cygwin'; then
  warn "Windows needs WSL2: the sandboxed shell tools rely on Linux (bwrap)."
fi

# Resolve the parent now, so the plan below prints a real absolute path.
mkdir -p "$(dirname "$DIR")"
PARENT="$(cd "$(dirname "$DIR")" && pwd)"
DIR="$PARENT/$(basename "$DIR")"

MODE="fresh"
if [ -d "$DIR" ]; then
  if [ -f "$DIR/$MARKER" ]; then
    MODE="update"
  elif [ -z "$(ls -A "$DIR" 2>/dev/null)" ]; then
    MODE="fresh"
  else
    die "$DIR is not empty and was not created by this installer. Pick another folder with --dir, or empty it yourself."
  fi
fi

say "  node $(node -v) · npm $(npm -v) · $( [ "$FETCH" = "git" ] && printf 'git' || printf 'curl' )"
say "  install folder: $DIR"
say "  source: $REPO_SLUG @ $REF ($MODE)"

if [ "$DRY_RUN" = "1" ]; then
  step "Dry run"
  say "  would fetch $REPO_SLUG@$REF via $FETCH into $DIR"
  say "  would install dependencies with npm ($([ -d "$DIR/node_modules" ] && printf 'install' || printf 'ci'))"
  [ "$DO_BUILD" = "1" ] && say "  would build the client (npm run build)"
  [ "$DO_LINK" = "1" ] && say "  would link the aegisxworker command (npm link, wrapper fallback)"
  say "  would verify: node $DIR/bin/aegisxworker.mjs --version"
  exit 0
fi

ref_hint() {
  die "could not fetch '$REF' from $REPO_SLUG — check --ref: branches and tags both work, 'main' is the default"
}

fetch_git() {
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch --depth 1 origin "$REF" || ref_hint
    # A detached FETCH_HEAD covers branches and tags without guessing which one
    # the ref is; the next run fetches again, so there is nothing to pull.
    git -C "$DIR" checkout -q --force --detach FETCH_HEAD || ref_hint
  else
    # A failed clone leaves a half-written folder; MODE=fresh proved it is ours
    # to remove, and a retry then starts from nothing instead of from debris.
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$DIR" || { rm -rf "$DIR"; ref_hint; }
  fi
}

fetch_tarball() {
  local tmp src
  tmp="$(mktemp -d)"
  if ! curl -fsSL "$TARBALL_URL/$REF" -o "$tmp/src.tar.gz"; then
    rm -rf "$tmp"
    die "could not download $TARBALL_URL/$REF — check the ref name and your connection"
  fi
  tar -xzf "$tmp/src.tar.gz" -C "$tmp"
  src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$src" ] || { rm -rf "$tmp"; die "the archive did not contain a source folder"; }
  if [ -d "$DIR" ]; then
    # Only a folder carrying our marker gets emptied: it is the folder we made.
    find "$DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  fi
  mkdir -p "$DIR"
  cp -a "$src"/. "$DIR"/
  rm -rf "$tmp"
}

step "Fetching the source"
if [ "$FETCH" = "git" ]; then
  fetch_git
else
  fetch_tarball
fi
printf 'repo=%s\nref=%s\ninstalled_at=%s\n' "$REPO_SLUG" "$REF" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/$MARKER"

cd "$DIR"

step "Installing dependencies"
if [ -d node_modules ]; then
  npm install --no-audit --no-fund
else
  # The lockfile is the contract; fall back only when it cannot be honoured.
  npm ci --no-audit --no-fund || { warn "npm ci failed — retrying with npm install"; npm install --no-audit --no-fund; }
fi

if [ "$DO_BUILD" = "1" ]; then
  step "Building the browser bundle"
  npm run build
else
  warn "skipping the build — the CLI builds the client on first run"
fi

LINK_KIND="none"
if [ "$DO_LINK" = "1" ]; then
  step "Linking the aegisxworker command"
  if npm link --silent >/dev/null 2>&1; then
    LINK_KIND="npm"
    command -v aegisxworker >/dev/null 2>&1 || warn "linked, but the npm global bin is not on PATH — add \`npm prefix -g\`/bin to PATH"
  else
    # A global npm prefix is often root-owned; a per-user wrapper needs no sudo.
    warn "npm link failed (the global npm prefix may not be writable) — writing a wrapper instead"
    mkdir -p "$HOME/.local/bin"
    cat > "$HOME/.local/bin/aegisxworker" <<WRAPPER
#!/usr/bin/env bash
exec node "$DIR/bin/aegisxworker.mjs" "\$@"
WRAPPER
    chmod +x "$HOME/.local/bin/aegisxworker"
    LINK_KIND="wrapper"
  fi
fi

step "Verifying the install"
VERSION="$(node "$DIR/bin/aegisxworker.mjs" --version 2>&1 | head -n 1)"
[ -n "$VERSION" ] || die "the CLI did not run — check the output above"
say "  $VERSION"

case "$LINK_KIND" in
  npm)     COMMAND="aegisxworker" ;;
  wrapper) COMMAND="$HOME/.local/bin/aegisxworker" ;;
  *)       COMMAND="node $DIR/bin/aegisxworker.mjs" ;;
esac

say ""
say "${GREEN}${BOLD}Installed.${RESET} $DIR"
say "  command:   $COMMAND --help"
if [ "$LINK_KIND" = "wrapper" ]; then
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) : ;;
    *) say "  ${YELLOW}add it to PATH:${RESET} export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi
say "  key:       export OFFICE_API_KEY=...   (or cp .env.example .env in $DIR)"
say "  first run: cd ~/your-project && $COMMAND \"build a landing page\""
say "  update:    re-run this installer"
say "  remove:    npm unlink -g agent-office 2>/dev/null; rm -rf \"$DIR\""
say "  docs:      https://github.com/${REPO_SLUG}#readme"
