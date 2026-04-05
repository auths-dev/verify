#!/usr/bin/env python3
"""
Tag and push a GitHub release from the version in package.json.

Usage:
    python docs/release.py          # dry-run (shows what would happen)
    python docs/release.py --push   # create tag and push to trigger release workflow

What it does:
    1. Reads the version from package.json
    2. Checks that the npm package version has been bumped (if published)
    3. Checks that the git tag doesn't already exist on GitHub
    4. Ensures dist/ is built and committed
    5. Creates a git tag v{version} and pushes it to origin
    6. The release workflow creates a GitHub Release and updates the floating v1 tag

Requires:
    - python3 (no external dependencies)
    - git on PATH
    - network access to npmjs.org
"""

import json
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JSON = REPO_ROOT / "package.json"
NPM_PACKAGE = "@auths/verify-action"
GITHUB_REPO = "auths-dev/verify"


def get_package_version() -> str:
    data = json.loads(PACKAGE_JSON.read_text())
    version = data.get("version")
    if not version:
        print("ERROR: No version field in package.json", file=sys.stderr)
        sys.exit(1)
    return version


def get_npm_version() -> str | None:
    url = f"https://registry.npmjs.org/{NPM_PACKAGE}/latest"
    req = urllib.request.Request(url, headers={"User-Agent": "auths-release-script/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("version")
    except Exception:
        return None


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        print(f"ERROR: git {' '.join(args)} failed:\n{result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def local_tag_exists(tag: str) -> bool:
    result = subprocess.run(
        ["git", "tag", "-l", tag],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    return bool(result.stdout.strip())


def remote_tag_exists(tag: str) -> bool:
    result = subprocess.run(
        ["git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}"],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    return bool(result.stdout.strip())


def delete_local_tag(tag: str) -> None:
    subprocess.run(
        ["git", "tag", "-d", tag],
        capture_output=True,
        cwd=REPO_ROOT,
    )


def main() -> None:
    push = "--push" in sys.argv

    version = get_package_version()
    tag = f"v{version}"
    print(f"package.json version: {version}")
    print(f"Git tag:              {tag}")

    # Check npm for version collision (this action isn't published to npm,
    # but check anyway in case it ever is)
    published = get_npm_version()
    if published:
        print(f"npm version:          {published}")
        if published == version:
            print(f"\nWARNING: Version {version} matches npm. Consider bumping.", file=sys.stderr)
    else:
        print("npm version:          (not published)")

    # GitHub is the source of truth for tags.
    if remote_tag_exists(tag):
        print(f"\nERROR: Git tag {tag} already exists on origin.", file=sys.stderr)
        print("Bump the version in package.json or delete the remote tag/release first.", file=sys.stderr)
        sys.exit(1)

    if local_tag_exists(tag):
        print(f"Local tag {tag} exists but not on origin — deleting stale local tag.")
        delete_local_tag(tag)

    # Check we're on a clean working tree
    status = git("status", "--porcelain")
    if status:
        print(f"\nERROR: Working tree is not clean:\n{status}", file=sys.stderr)
        print("Commit or stash changes before releasing.", file=sys.stderr)
        sys.exit(1)

    # Check dist/ is committed (the release workflow validates this too)
    diff = subprocess.run(
        ["git", "diff", "--name-only", "--", "dist/"],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    if diff.stdout.strip():
        print(f"\nERROR: dist/ has uncommitted changes:\n{diff.stdout.strip()}", file=sys.stderr)
        print("Run `npm run build` and commit dist/ before releasing.", file=sys.stderr)
        sys.exit(1)

    if not push:
        print(f"\nDry run: would create and push tag {tag}")
        print("Run with --push to execute.")
        return

    print(f"\nCreating tag {tag}...", flush=True)
    result = subprocess.run(
        ["git", "tag", "-a", tag, "-m", f"release: {version}"],
        cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        print(f"\nERROR: git tag failed (exit {result.returncode})", file=sys.stderr)
        sys.exit(1)

    print(f"Pushing tag {tag} to origin...", flush=True)
    result = subprocess.run(
        ["git", "push", "origin", tag],
        cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        print(f"\nERROR: git push failed (exit {result.returncode})", file=sys.stderr)
        sys.exit(1)

    print(f"\nDone. Release workflow will run at:")
    print(f"  https://github.com/{GITHUB_REPO}/actions")
    print(f"\nThe workflow will also update the floating v1 tag.")


if __name__ == "__main__":
    main()
