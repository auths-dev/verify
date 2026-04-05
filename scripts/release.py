#!/usr/bin/env python3
"""
Tag and push a GitHub release from the version in package.json.

Usage:
    python scripts/release.py          # dry-run (shows what would happen)
    python scripts/release.py --push   # create tag and push to trigger release workflow

What it does:
    1. Reads the version from package.json
    2. Checks that the git tag doesn't already exist on GitHub
    3. Creates a git tag v{version} and pushes it to origin
    4. Updates the floating major tag (e.g. v1) to point to the new release

Requires:
    - python3 (no external dependencies)
    - git on PATH
"""

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JSON = REPO_ROOT / "package.json"


def get_version() -> str:
    data = json.loads(PACKAGE_JSON.read_text())
    version = data.get("version")
    if not version:
        print("ERROR: No version found in package.json", file=sys.stderr)
        sys.exit(1)
    return version


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

    version = get_version()
    tag = f"v{version}"
    major_tag = tag.split(".")[0]  # e.g. "v1"
    print(f"package.json version: {version}")
    print(f"Git tag:              {tag}")
    print(f"Floating major tag:   {major_tag}")

    # GitHub is the source of truth for tags.
    if remote_tag_exists(tag):
        print(f"\nERROR: Git tag {tag} already exists on origin.", file=sys.stderr)
        print("Bump the version in package.json before releasing.", file=sys.stderr)
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

    if not push:
        print(f"\nDry run: would create and push tag {tag}")
        print("Run with --push to execute.")
        return

    # Create and push the version tag
    print(f"\nCreating tag {tag}...", flush=True)
    result = subprocess.run(
        ["git", "tag", "-a", tag, "-m", f"release: {version}"],
        cwd=REPO_ROOT,
        env={**__import__("os").environ, "GIT_EDITOR": "true"},
    )
    if result.returncode != 0:
        print(f"\nERROR: git tag failed (exit {result.returncode})", file=sys.stderr)
        sys.exit(1)

    print(f"Pushing tag {tag} to origin...", flush=True)
    result = subprocess.run(
        ["git", "push", "--no-verify", "origin", tag],
        cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        print(f"\nERROR: git push failed (exit {result.returncode})", file=sys.stderr)
        sys.exit(1)

    print(f"\nDone. Release workflow will run at:")
    print(f"  https://github.com/auths-dev/verify/actions")
    print(f"  (the workflow also updates the floating {major_tag} tag automatically)")


if __name__ == "__main__":
    main()
