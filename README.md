# Auths Verify Action

[![Verified with Auths](https://img.shields.io/badge/Verified%20with-Auths-4B9CD3?logo=github&logoColor=white)](https://github.com/auths-dev/verify)
[![Verify Commits](https://github.com/auths-dev/verify/actions/workflows/verify-commits.yml/badge.svg)](https://github.com/auths-dev/verify/actions/workflows/verify-commits.yml?query=branch%3Amain+event%3Apush)
[![Sign Commits](https://github.com/auths-dev/verify/actions/workflows/sign-commits.yml/badge.svg)](https://github.com/auths-dev/verify/actions/workflows/sign-commits.yml?query=branch%3Amain)

Verify commit signatures using [Auths](https://github.com/auths-dev/auths) token keys. Ensures every commit in a PR or push is cryptographically signed by an authorized developer.

## Quickstart

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: auths-dev/verify@v1
```

That's it. The action auto-detects the commit range from the GitHub event (PR or push), downloads the `auths` CLI, and verifies each commit. Identity is auto-detected from the `token` input (defaults to `.auths/allowed_signers`).

## One-Liner Install

Add this file to your repo to start enforcing signed commits on every PR:

```yaml
# .github/workflows/verify.yml
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
          fail-on-unsigned: true
```

That's it. No token or configuration needed — the action reads `.auths/allowed_signers` automatically.

## Features

- Verifies SSH commit signatures against allowed signers or identity bundles
- Auto-detects commit range from pull request or push events
- Downloads and caches the `auths` CLI automatically (with SHA256 checksum verification)
- Skips merge commits by default
- Gracefully handles GPG-signed commits (skips rather than fails)
- Generates a GitHub Step Summary with per-commit results table and a **"How to fix"** section when verification fails
- Classifies failures (unsigned, unknown key, corrupted signature) with copy-pasteable fix commands
- Optionally posts results directly to the PR as a comment (`post-pr-comment: true`)
- Pre-flight checks: detects shallow clones and missing `ssh-keygen`

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `token` | Identity for verification. Accepts: CI token JSON, identity bundle JSON, file path to bundle, or path to allowed_signers file | No | `.auths/allowed_signers` (auto) |
| `commits` | Git commit range to verify (e.g. `HEAD~5..HEAD`) | No | Auto-detected from event |
| `auths-version` | Auths CLI version to use (e.g. `0.5.0`) | No | `''` (latest) |
| `fail-on-unsigned` | Whether to fail the action if unsigned commits are found | No | `true` |
| `skip-merge-commits` | Whether to skip merge commits during verification | No | `true` |
| `post-pr-comment` | Post a PR comment with results and fix instructions (requires `pull-requests: write`) | No | `false` |
| `github-token` | GitHub token for posting the PR comment (required when `post-pr-comment: true`) | No | `''` |
| `files` | Glob patterns for artifact files to verify, one per line | No | `''` |
| `artifact-attestation-dir` | Directory containing `.auths.json` attestation files | No | `''` |
| `fail-on-unattested` | Fail the action if any artifact lacks a valid attestation | No | `true` |

The `token` input auto-detects the format. When empty, it defaults to the `.auths/allowed_signers` file. When only `files` is set with an identity bundle, commit verification is skipped automatically.

## Outputs

| Output | Description |
|--------|-------------|
| `verified` | `true` if all commits passed verification |
| `results` | JSON array of per-commit verification results |
| `total` | Total number of commits checked |
| `passed` | Number of commits that passed verification |
| `failed` | Number of commits that failed verification |

## Verification Modes

The `token` input auto-detects the format:

### Allowed Signers File (default)

Commit the team's public keys to your repo. When `token` is empty, the action looks for `.auths/allowed_signers`:

```
# .auths/allowed_signers
alice@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
bob@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
```

```yaml
- uses: auths-dev/verify@v1
```

Or pass a custom path:

```yaml
- uses: auths-dev/verify@v1
  with:
    token: 'path/to/allowed_signers'
```

### Identity Bundle (stateless CI)

Export your identity bundle locally and store it as a GitHub secret:

```bash
auths id export-bundle --alias mykey --output bundle.json
gh secret set AUTHS_IDENTITY_BUNDLE < bundle.json
```

Then pass the secret directly — the action detects the JSON format automatically:

```yaml
- uses: auths-dev/verify@v1
  with:
    token: ${{ secrets.AUTHS_IDENTITY_BUNDLE }}
```

Or commit the bundle (it contains only public data) and reference the file:

```yaml
- uses: auths-dev/verify@v1
  with:
    token: '.auths/token-bundle.json'
```

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
          token: ${{ secrets.AUTHS_IDENTITY_BUNDLE }}
```

### Non-blocking (Warn Only)

```yaml
- uses: auths-dev/verify@v1
  with:
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
          post-pr-comment: 'true'
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Using Outputs

```yaml
- name: Verify commits
  id: verify
  uses: auths-dev/verify@v1
  with:
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
          token: ${{ secrets.AUTHS_IDENTITY_BUNDLE }}
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
- Commits must be SSH-signed (the action downloads `auths` CLI automatically)
- OpenSSH 8.0+ on the runner (pre-installed on GitHub-hosted runners)

## How It Works

1. Runs pre-flight checks (shallow clone detection, ssh-keygen availability)
2. Downloads and caches the `auths` CLI binary (with SHA256 checksum verification)
3. Determines the commit range from the GitHub event context
4. Runs `auths verify-commit` with `--json` output
5. Parses results, skipping merge commits and GPG-signed commits
6. Writes a Markdown summary table to GitHub Step Summary
7. Sets outputs and fails the workflow if unsigned commits are found (configurable)

## License

Apache-2.0. See [LICENSE](LICENSE).

## Links

- [Auths](https://github.com/auths-dev/auths) - Decentralized token for developers
- [Auths CLI](https://github.com/auths-dev/auths/tree/main/crates/auths-cli) - Command-line tool
- [Signing commits with Auths](https://github.com/auths-dev/auths#readme) - Setup guide
