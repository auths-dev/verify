# Default: list available recipes
default:
    @just --list

# Run tests
test:
    npm test

# Build dist/ (committed to repo so the action works without npm install)
build:
    npm run build

# Verify dist/ matches source — same check CI runs
check-dist:
    @git diff --exit-code dist/ || (echo "dist/ is out of date. Run: just build" && exit 1)

# Run the full CI suite locally: test + build + verify dist
ci: test build check-dist

# Sign the dist/index.js artifact locally (creates dist/index.js.auths.json)
sign-dist:
    auths artifact sign dist/index.js

# Cut a release: bump version, commit, then tag+push via release script
# The release workflow handles build verification, artifact signing, and GitHub release creation.
# Usage: just release 1.0.3
release VERSION: test build
    npm version {{VERSION}} --no-git-tag-version
    git add package.json package-lock.json dist/ src/ .github/ justfile
    git commit -m "build: bump version to {{VERSION}}"
    python scripts/release.py --push
