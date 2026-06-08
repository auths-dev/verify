# Auths Verify Action

[![Verified with Auths](https://img.shields.io/badge/Verified%20with-Auths-4B9CD3?logo=github&logoColor=white)](https://github.com/auths-dev/verify)
[![Verify Commits](https://github.com/auths-dev/verify/actions/workflows/verify-commits.yml/badge.svg)](https://github.com/auths-dev/verify/actions/workflows/verify-commits.yml?query=branch%3Amain+event%3Apush)
[![Sign Commits](https://github.com/auths-dev/verify/actions/workflows/sign-commits.yml/badge.svg)](https://github.com/auths-dev/verify/actions/workflows/sign-commits.yml?query=branch%3Amain)

Verify commit signatures using [Auths](https://github.com/auths-dev/auths) identity keys. Ensures every commit in a PR or push is cryptographically signed by an authorized developer.

## Quickstart

```yaml
permissions:
  contents: read            # verification needs nothing more
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  - uses: auths-dev/verify@v1
    with:
      auths-version: "0.0.1-rc.12"   # pin the CLI — the action never resolves `latest`
```

That's it. The action auto-detects the commit range from the GitHub event (PR or push), downloads the **pinned** `auths` CLI (SHA256-checksum verified — it **fails closed** if the release has no checksum), and verifies each commit with `auths verify`. Verification is **KEL-native**: the signer is read from each commit's `Auths-Id`/`Auths-Device` trailers and checked against its key history (KEL). For stateless CI, pass an identity bundle via the `identity-bundle` input.

## One-Liner Install

Add this file to your repo to start enforcing signed commits on every PR:

```yaml
# .github/workflows/verify.yml
name: Verify Commits
on: [pull_request]
permissions:
  contents: read              # least privilege — no id-token, no write
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: auths-dev/verify@v1
        with:
          auths-version: "0.0.1-rc.12"   # pin the CLI version (required)
          fail-on-unsigned: true
```

> **Pin the CLI.** `auths-version` must be set to a released version that publishes a `.sha256` (e.g. `0.0.1-rc.12`). The action refuses to resolve `latest` and fails closed if the binary cannot be checksum-verified — supply-chain hardening for a tool whose entire job is trust. (If `auths` is already on `PATH`, the version is not needed.)

That's it for verifying against the local identity store. For stateless CI (no `~/.auths` on the runner), commit an identity bundle and point the `identity-bundle` input at it — see [Identity Bundle](#identity-bundle-stateless-ci) below.

## Features

- KEL-native commit verification: reads the `Auths-Id`/`Auths-Device` trailers and checks the signature against the signer's key history (KEL)
- Stateless CI via identity bundles — no `~/.auths` or `ssh-keygen` needed on the runner
- Auto-detects commit range from pull request or push events
- Downloads and caches the `auths` CLI automatically (with SHA256 checksum verification)
- Skips merge commits by default
- Gracefully handles GPG-signed commits (skips rather than fails)
- Generates a GitHub Step Summary with per-commit results table and a **"How to fix"** section when verification fails
- Classifies failures (unsigned, unknown signer, corrupted signature) with copy-pasteable fix commands
- Optionally posts results directly to the PR as a comment (`post-pr-comment: true`)
- Pre-flight check: detects shallow clones

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `identity-bundle` | Identity bundle for stateless verification. Accepts: CI token JSON, identity bundle JSON, or a file path to a bundle. Empty → KEL-native verification against the local identity store | No | `''` (KEL-native) |
| `commits` | Git commit range to verify (e.g. `HEAD~5..HEAD`) | No | Auto-detected from event |
| `auths-version` | Auths CLI version to **pin** (e.g. `0.0.1-rc.12`). Required unless `auths` is on `PATH`; the action never resolves `latest` and fails closed without a verifiable `.sha256` | Yes (unless on PATH) | `''` |
| `fail-on-unsigned` | Whether to fail the action if unsigned commits are found | No | `true` |
| `skip-merge-commits` | Whether to skip merge commits during verification | No | `true` |
| `post-pr-comment` | Post a PR comment with results and fix instructions (requires `pull-requests: write`) | No | `false` |
| `github-token` | GitHub token for posting the PR comment (required when `post-pr-comment: true`) | No | `''` |
| `files` | Glob patterns for artifact files to verify, one per line | No | `''` |
| `artifact-attestation-dir` | Directory containing `.auths.json` attestation files | No | `''` |
| `fail-on-unattested` | Fail the action if any artifact lacks a valid attestation | No | `true` |

The `identity-bundle` input auto-detects the format (bundle JSON, CI token JSON, or a file path to a bundle). When empty, verification is KEL-native against the local identity store. When only `files` is set with an identity bundle, commit verification is skipped automatically.

## Outputs

| Output | Description |
|--------|-------------|
| `verified` | `true` if all commits passed verification |
| `results` | JSON array of per-commit verification results |
| `total` | Total number of commits checked |
| `passed` | Number of commits that passed verification |
| `failed` | Number of commits that failed verification |

## Verification Modes

### KEL-native (default)

With an empty `identity-bundle`, the action runs `auths verify` against the local identity store. Each commit's `Auths-Id`/`Auths-Device` trailers identify the signer, and the signature is checked against the signer's key history (KEL). This works on a developer machine or any runner that has `~/.auths`:

```yaml
- uses: auths-dev/verify@v1
  with:
    auths-version: "0.0.1-rc.12"   # pin the CLI (required on clean runners)
```

### Identity Bundle (stateless CI)

CI runners don't have `~/.auths`, so supply an identity bundle — a portable JSON file carrying the identity ID, public key, and authorization chain. Generate it once:

```bash
auths id export-bundle --alias main --output .auths/ci-bundle.json --max-age-secs 31536000
```

Commit the bundle (it contains only public data) and reference the file:

```yaml
- uses: auths-dev/verify@v1
  with:
    auths-version: "0.0.1-rc.12"
    identity-bundle: '.auths/ci-bundle.json'
```

Or store it as a GitHub secret and pass it inline — the action detects the JSON format automatically:

```bash
gh secret set AUTHS_IDENTITY_BUNDLE < .auths/ci-bundle.json
```

```yaml
- uses: auths-dev/verify@v1
  with:
    auths-version: "0.0.1-rc.12"
    identity-bundle: ${{ secrets.AUTHS_IDENTITY_BUNDLE }}
```

Bundles carry a freshness TTL (`--max-age-secs`); the action fails if a bundle is older than its TTL, so refresh it when it lapses or when keys rotate.

## Example Workflows

### Basic PR Verification

```yaml
name: Verify Commits
on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: auths-dev/verify@v1
        with:
          auths-version: "0.0.1-rc.12"
```

### Identity Bundle with Secret

```yaml
name: Verify Commits
on: [pull_request]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: auths-dev/verify@v1
        with:
          auths-version: "0.0.1-rc.12"
          identity-bundle: ${{ secrets.AUTHS_IDENTITY_BUNDLE }}
```

### Non-blocking (Warn Only)

```yaml
- uses: auths-dev/verify@v1
  with:
    auths-version: "0.0.1-rc.12"
    fail-on-unsigned: 'false'
```

### PR Comment with Fix Instructions

Post results (and a "How to fix" section) directly on the PR where contributors actually look:

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: auths-dev/verify@v1
        with:
          auths-version: "0.0.1-rc.12"
          post-pr-comment: 'true'
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Using Outputs

```yaml
- name: Verify commits
  id: verify
  uses: auths-dev/verify@v1
  with:
    auths-version: "0.0.1-rc.12"
    fail-on-unsigned: 'false'

- name: Gate a downstream step on verification
  if: steps.verify.outputs.verified == 'true'
  run: ./deploy.sh
```

### Org-Wide Reusable Workflow

Store in your org's `.github` repo at `.github/workflows/auths-verify.yml`:

```yaml
name: Auths Verify
on:
  workflow_call:
    inputs:
      mode:
        description: 'warn or enforce'
        type: string
        default: 'enforce'
    secrets:
      AUTHS_IDENTITY_BUNDLE:
        required: false

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: auths-dev/verify@v1
        with:
          auths-version: "0.0.1-rc.12"
          identity-bundle: ${{ secrets.AUTHS_IDENTITY_BUNDLE }}
          fail-on-unsigned: ${{ inputs.mode == 'enforce' && 'true' || 'false' }}
```

Then each repo opts in:

```yaml
name: Verify
on: [pull_request]
jobs:
  auths:
    uses: your-org/.github/.github/workflows/auths-verify.yml@main
    with:
      mode: enforce
    secrets: inherit
```

## Requirements

- **`fetch-depth: 0`** on `actions/checkout` (the action detects shallow clones and provides a fix message)
- Commits must be signed with `auths sign` (carry `Auths-Id`/`Auths-Device` trailers)
- For stateless CI, an identity bundle (see [Identity Bundle](#identity-bundle-stateless-ci))

## How It Works

1. Runs a pre-flight shallow-clone check
2. Downloads and caches the `auths` CLI binary (with SHA256 checksum verification)
3. Determines the commit range from the GitHub event context
4. Runs `auths verify --json` (KEL-native; adds `--identity-bundle` when a bundle is supplied)
5. Parses results, skipping merge commits and GPG-signed commits
6. Writes a Markdown summary table to GitHub Step Summary
7. Sets outputs and fails the workflow if unsigned commits are found (configurable)

## License

Apache-2.0. See [LICENSE](LICENSE).

## Links

- [Auths](https://github.com/auths-dev/auths) - Decentralized identity for developers
- [Auths CLI](https://github.com/auths-dev/auths/tree/main/crates/auths-cli) - Command-line tool
- [Signing commits with Auths](https://github.com/auths-dev/auths#readme) - Setup guide
