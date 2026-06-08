# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING:** Renamed the `token` action input to `identity-bundle`. It carries
  *public* identity-bundle data (not a secret), so the old name was misleading and
  collided with the `GITHUB_TOKEN` mental model. Update workflows by changing the
  `with:` key `token:` → `identity-bundle:`. The separate `github-token` input
  (used for posting PR comments) is unchanged.
- Commit verification is now **KEL-native**: the signer is read from each commit's
  `Auths-Id`/`Auths-Device` trailers and checked against its key history (KEL),
  replacing the static `.auths/allowed_signers` probe.

### Added

- **Supply-chain hardening of the `auths` CLI download.** `auths-version` must be
  pinned to a released version — the action never resolves `releases/latest`, which
  could let an upstream release silently change the binary a verification action
  runs. The downloaded binary's SHA256 checksum is verified **fail-closed**: a
  release without a fetchable `.sha256` is refused rather than run unverified. A
  pre-installed `auths` on `PATH` is exempt. Every README example now pins
  `auths-version` so it runs on a clean runner.

### Fixed

- Corrected the package license metadata to `Apache-2.0` (matching `LICENSE` and the
  README); `package.json` previously declared `MIT`.

## Released

Releases through **v1.3.0** predate this changelog. See the
[GitHub releases](https://github.com/auths-dev/verify/releases) and
[commit history](https://github.com/auths-dev/verify/commits) for details —
highlights include KEL-native commit verification, artifact attestation
verification, identity-bundle support for stateless CI, optional PR-comment
results with fix instructions, and zero-config Marketplace metadata.

[Unreleased]: https://github.com/auths-dev/verify/compare/v1.3.0...HEAD
