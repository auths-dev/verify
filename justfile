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

# Sign the dist/index.js artifact (creates dist/index.js.auths.json)
sign-dist:
    auths artifact sign dist/index.js

# Cut a release: test, build, sign artifact, commit dist, tag, push
# Usage: just release 1.0.3
release VERSION: test build sign-dist
    npm version {{VERSION}} --no-git-tag-version
    git add package.json dist/ src/ .github/ justfile
    git commit -m "Release v{{VERSION}}"
    git tag "v{{VERSION}}"
    git push && git push origin "v{{VERSION}}"
