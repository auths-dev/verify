#!/usr/bin/env bash
set -euo pipefail

# Sync verify-action from the auths monorepo to the dedicated repo.
#
# Usage:
#   ./sync-to-dedicated-repo.sh /path/to/verify
#
# This copies source files and builds dist/index.js in the target repo.
# Run this before tagging a new release in the dedicated repo.

TARGET="${1:?Usage: $0 /path/to/verify}"
SOURCE="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$TARGET/.git" ]; then
  echo "Error: $TARGET is not a git repository"
  exit 1
fi

echo "Syncing from: $SOURCE"
echo "Syncing to:   $TARGET"

# Copy action definition and source
cp "$SOURCE/action.yml"     "$TARGET/action.yml"
cp "$SOURCE/package.json"   "$TARGET/package.json"
cp "$SOURCE/package-lock.json" "$TARGET/package-lock.json"
cp "$SOURCE/tsconfig.json"  "$TARGET/tsconfig.json"
cp "$SOURCE/jest.config.js" "$TARGET/jest.config.js"
cp "$SOURCE/README.md"      "$TARGET/README.md"

# Copy source tree
rm -rf "$TARGET/src"
cp -r "$SOURCE/src" "$TARGET/src"

# Copy template workflows into place
if [ -d "$SOURCE/.github-template/workflows" ]; then
  mkdir -p "$TARGET/.github/workflows"
  cp "$SOURCE/.github-template/workflows/"*.yml "$TARGET/.github/workflows/"
fi

# Build in target
echo "Installing dependencies..."
(cd "$TARGET" && npm ci)

echo "Running tests..."
(cd "$TARGET" && npm test)

echo "Building dist/index.js..."
(cd "$TARGET" && npm run build)

# Copy dist
rm -rf "$TARGET/dist"
cp -r "$SOURCE/dist" "$TARGET/dist"

echo ""
echo "Sync complete. Next steps:"
echo "  cd $TARGET"
echo "  git add -A"
echo "  git commit -m 'sync from auths monorepo'"
echo "  git tag v1.x.y"
echo "  git push origin main --tags"
