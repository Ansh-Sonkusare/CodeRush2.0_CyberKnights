#!/usr/bin/env bash
set -euo pipefail

# Remove .env (and any committed secret files) from the ENTIRE git history.
# Rewrites every commit, so all collaborators must re-clone / force-push after.
#
# Usage:
#   ./scripts/remove-env-from-history.sh              # default: .env
#   ./scripts/remove-env-from-history.sh --all        # also .env.* and *.env
#
# IMPORTANT: run from repo root. Do NOT run on a dirty tree.

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PATTERNS=()
if [[ "${1:-}" == "--all" ]]; then
  PATTERNS=('.env' '*.env' '.env.*')
else
  PATTERNS=('.env')
fi

# 1. Preflight ----------------------------------------------------------------
if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "git-filter-repo not found. Installing..."
  if command -v brew >/dev/null 2>&1; then
    brew install git-filter-repo
  elif command -v pip3 >/dev/null 2>&1; then
    pip3 install --user git-filter-repo
  else
    echo "Cannot install git-filter-repo. Install it manually (https://github.com/newren/git-filter-repo)." >&2
    exit 1
  fi
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is NOT clean. Stash or commit first." >&2
  exit 1
fi

echo "Files that will be removed from history:"
for p in "${PATTERNS[@]}"; do
  echo "  - $p"
done
read -r -p "This rewrites every commit and invalidates all clones. Continue? [y/N] " answer
if [[ ! "$answer" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

# 2. Backup current working copies -------------------------------------------
BACKUP_DIR="$(mktemp -d)"
for p in "${PATTERNS[@]}"; do
  # only back up exact .env; globs are matched below
  if [[ "$p" != *\* ]] && [[ -f "$p" ]]; then
    cp "$p" "$BACKUP_DIR/$(basename "$p")"
    echo "Backed up $p to $BACKUP_DIR/"
  fi
done

# 3. Rewrite history (removes the paths from every commit) ---------------------
#    --invert-paths keeps everything EXCEPT the matched paths.
git-filter-repo --force --invert-paths \
  $(printf -- '--path %q ' "${PATTERNS[@]}")

# 4. Clean up the present ------------------------------------------------------
for p in "${PATTERNS[@]}"; do
  git rm -r --cached --quiet "$p" 2>/dev/null || true
done

# 5. Make sure gitignore covers them going forward ----------------------------
if ! grep -q '^\.env' .gitignore 2>/dev/null; then
  printf '\n# local secrets\n.env\n.env.*\n*.env\n' >> .gitignore
  git add .gitignore
  echo "Appended secret patterns to .gitignore."
fi

git commit -m "chore: remove tracked .env files from history" --allow-empty

echo ""
echo "Done. History has been rewritten."
echo "  - Backup of working copies (if any): $BACKUP_DIR"
echo "  - Force-push to update the remote:  git push --force --all origin"
echo "  - After force-pushing, every collaborator must re-clone or run:"
echo "      git fetch origin && git reset --hard origin/<branch>"
echo "  - Rotate any credentials that were in the removed .env files."
