#!/usr/bin/env bash
# deploy-docs.sh — publish docs/.vitepress/dist to the gh-pages branch and
# (optionally) update the GitHub repo's description / homepage to point at
# the published docs site.
#
# Two ways to deploy docs:
#   (A) Automatic — push to main triggers .github/workflows/docs.yml which
#       builds and deploys through GitHub's official Pages infrastructure
#       (recommended). Just `git push` and let CI handle it.
#   (B) Manual — run this script locally when you want to ship docs
#       without waiting for / triggering CI (e.g. one-off tweaks, branch
#       previews, force-rebuild after Pages source was re-pointed).
#
# Requires:
#   - `node` + `npm` on PATH (already true if you're running this from
#     the project; `vitepress` and `gh-pages` come from devDeps)
#   - clean working tree on main (uncommitted changes confuse the build)
#   - For --update-meta: the `gh` CLI (https://cli.github.com) logged in
#     with `repo` scope on this repository
#
# Usage:
#   ./scripts/deploy-docs.sh                  # build + push to gh-pages
#   ./scripts/deploy-docs.sh --dry-run        # build only, no push
#   ./scripts/deploy-docs.sh --update-meta    # also gh repo edit description + homepage
#   ./scripts/deploy-docs.sh --dry-run --update-meta   # both flags compose
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ── constants — tune here for other projects ──────────────────────────
# Keep these short; GitHub's `description` field is single-line, and the
# repo's "About" sidebar truncates around ~155 chars on most themes.
REPO_DESCRIPTION="AceCrush Swing-Analysis — automated tennis swing detection + segmentation. Codebase private; full docs published to GitHub Pages."
REPO_HOMEPAGE=""   # filled in dynamically from REMOTE_URL below

# ── UI helpers ────────────────────────────────────────────────────────
log()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── arg parse ─────────────────────────────────────────────────────────
DRY_RUN=0
UPDATE_META=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --update-meta)  UPDATE_META=1 ;;
    -h|--help)
      sed -n '3,32p' "$0"
      exit 0
      ;;
    *) die "unknown flag: $arg (try --help)" ;;
  esac
done

# ── 1. preflight ───────────────────────────────────────────────────────
log "Preflight checks"

command -v node >/dev/null 2>&1 || die "node not found on PATH"
command -v npm  >/dev/null 2>&1 || die "npm not found on PATH"
command -v git  >/dev/null 2>&1 || die "git not found on PATH"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || die "must be on main (currently on '$BRANCH'); docs deploys are the canonical main artifact"

if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "working tree has uncommitted changes:"
  git status --short
  die "commit or stash them first (CI/deploy see only committed files)"
fi

REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
[[ -n "$REMOTE_URL" ]] || die "no git remote 'origin' configured"
log "remote: $REMOTE_URL"

# Derive the GitHub Pages URL from the git remote. Works for both
# https://github.com/<owner>/<repo>.git and git@github.com:<owner>/<repo>.git.
PAGES_URL="$(
  echo "$REMOTE_URL" \
    | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##' \
    | awk -F/ '{print "https://" $4 ".github.io/" $5}'
)"
log "pages URL: $PAGES_URL"
REPO_HOMEPAGE="$PAGES_URL"

# ── 2. ensure deps + tools ────────────────────────────────────────────
log "Checking dependencies"

if [[ ! -d node_modules/vitepress ]] || [[ ! -d node_modules/gh-pages ]]; then
  log "Installing missing devDependencies (vitepress, gh-pages)…"
  npm install --no-audit --no-fund
fi

# ── 3. build ──────────────────────────────────────────────────────────
log "Building docs (vitepress build docs)"
npm run docs:build

[[ -d docs/.vitepress/dist ]] || die "build produced no docs/.vitepress/dist"

# ── 4. publish ────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == 1 ]]; then
  log "dry-run mode: skipping push. dist/ is at docs/.vitepress/dist/"
  log "to deploy manually:  git subtree push --prefix docs/.vitepress/dist origin gh-pages"
else
  MSG="docs: deploy $(date -u +'%Y-%m-%dT%H:%M:%SZ') @ $(git rev-parse --short HEAD)"
  log "Publishing to branch 'gh-pages' with message: $MSG"
  log "(this rewrites gh-pages to a single commit containing only docs/.vitepress/dist)"

  npx --yes gh-pages \
      --dist docs/.vitepress/dist \
      --branch gh-pages \
      --commit-message "$MSG" \
      --no-history \
      --user "github-actions[bot] <github-actions[bot]@users.noreply.github.com>" \
      --email "github-actions[bot]@users.noreply.github.com"

  log "Done. The site propagates in ~30s at $PAGES_URL"
fi

log "If the page 404s, repo Settings → Pages → Source must be set to 'Deploy from a branch: gh-pages / (root)'."

# ── 5. repo description / homepage (optional) ─────────────────────────
if [[ "$UPDATE_META" == 1 ]]; then
  if [[ "$DRY_RUN" == 1 ]]; then
    log "[--update-meta dry-run] would run:"
    printf '    gh repo edit --description %q --homepage %q\n' "$REPO_DESCRIPTION" "$REPO_HOMEPAGE"
  else
    command -v gh >/dev/null 2>&1 || die "gh CLI not found on PATH; install https://cli.github.com"
    gh auth status >/dev/null 2>&1 || die "gh CLI not authenticated — run \`gh auth login\`"

    log "Updating repo description + homepage via gh repo edit"
    gh repo edit \
      --description "$REPO_DESCRIPTION" \
      --homepage   "$REPO_HOMEPAGE"

    log "Repo metadata updated. Verify:"
    printf '    gh repo view --json description,homepage\n'
  fi
fi
