import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as tc from '@actions/tool-cache';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Repository that hosts the public auths CLI releases
const CLI_RELEASE_REPO = 'auths-dev/auths';

export type FailureType = 'unsigned' | 'unknown_signer' | 'invalid_signature' | 'no_attestation' | 'error';

export interface VerificationResult {
  commit: string;
  valid: boolean;
  signer?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
  failureType?: FailureType;
}

export interface ArtifactVerificationResult {
  file: string;
  valid: boolean;
  digestMatch?: boolean;
  chainValid?: boolean;
  capabilityValid?: boolean;
  issuer?: string;
  commitSha?: string;
  commitVerified?: boolean;
  error?: string;
  failureType?: FailureType;
}

/**
 * Classify a verification error string into a structured failure type.
 */
export function classifyError(error: string): FailureType {
  const e = error.toLowerCase();
  if (e.includes('no signature') || e.includes('not signed') || e.includes('unsigned'))
    return 'unsigned';
  if (e.includes('not in allowed') || e.includes('unknown signer') || e.includes('no matching'))
    return 'unknown_signer';
  if (e.includes('invalid') || e.includes('corrupt') || e.includes('bad signature'))
    return 'invalid_signature';
  return 'error';
}

export interface VerifyOptions {
  allowedSignersPath: string;
  identityBundlePath: string;
  skipMergeCommits: boolean;
}

/**
 * Run pre-flight checks before verification.
 * Detects common issues and provides actionable error messages.
 */
export async function runPreflightChecks(): Promise<void> {
  // Check for shallow clone
  let isShallow = '';
  try {
    await exec.exec('git', ['rev-parse', '--is-shallow-repository'], {
      listeners: {
        stdout: (data: Buffer) => { isShallow += data.toString(); }
      },
      ignoreReturnCode: true
    });
    if (isShallow.trim() === 'true') {
      throw new Error(
        'Shallow clone detected. Commit verification requires full git history.\n' +
        'Fix: Add `fetch-depth: 0` to your actions/checkout step:\n' +
        '  - uses: actions/checkout@v4\n' +
        '    with:\n' +
        '      fetch-depth: 0'
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('Shallow clone detected')) {
      throw e;
    }
    // git command failed, not necessarily a problem
  }

  // Check for ssh-keygen (required by auths verify)
  try {
    const sshKeygenPath = await io.which('ssh-keygen', false);
    if (!sshKeygenPath) {
      core.warning(
        'ssh-keygen not found in PATH. The auths verify command requires OpenSSH 8.0+.\n' +
        'GitHub-hosted runners include it by default. Self-hosted runners may need to install openssh-client.'
      );
    }
  } catch {
    // Ignore errors in the check itself
  }
}

/**
 * Verify commits in the given range using auths verify
 */
export async function verifyCommits(
  commitRange: string,
  options: VerifyOptions
): Promise<VerificationResult[]> {
  const { allowedSignersPath, identityBundlePath, skipMergeCommits } = options;

  // Determine verification mode
  const useIdentityBundle = identityBundlePath.length > 0;

  // Validate inputs
  if (!useIdentityBundle && !fs.existsSync(allowedSignersPath)) {
    core.warning(`Allowed signers file not found: ${allowedSignersPath}`);
    core.warning(
      'To set up commit verification:\n' +
      '  1. auths init                                          # create identity\n' +
      '  2. auths git allowed-signers -o .auths/allowed_signers # generate file\n' +
      '  3. git add .auths/allowed_signers && git commit        # commit it\n' +
      '\n' +
      'Or use an identity bundle for stateless CI (no file needed):\n' +
      '  auths id export-bundle --alias <ALIAS> --output bundle.json\n' +
      '\n' +
      'Docs: https://docs.auths.dev/cli/commands/advanced/#auths-git-allowed-signers'
    );

    const commits = await getCommitsInRange(commitRange, skipMergeCommits);
    return commits.map(commit => ({
      commit,
      valid: false,
      error: `Allowed signers file not found: ${allowedSignersPath}`,
      failureType: 'error' as FailureType
    }));
  }

  if (useIdentityBundle && !fs.existsSync(identityBundlePath)) {
    throw new Error(`Identity bundle file not found: ${identityBundlePath}`);
  }

  // Check if auths CLI is available
  const version = core.getInput('auths-version') || '';
  const authsPath = await ensureAuthsInstalled(version);
  if (!authsPath) {
    throw new Error('Failed to find or install auths CLI');
  }

  // Get commits, filtering merge commits if requested
  const commits = await getCommitsInRange(commitRange, skipMergeCommits);
  const mergeCommits = skipMergeCommits ? await getMergeCommits(commitRange) : [];

  // Build results for skipped merge commits
  const mergeResults: VerificationResult[] = mergeCommits.map(commit => ({
    commit,
    valid: true,
    skipped: true,
    skipReason: 'merge commit'
  }));

  if (commits.length === 0) {
    return mergeResults;
  }

  // Build CLI arguments
  const cliArgs = ['verify'];
  if (useIdentityBundle) {
    cliArgs.push('--identity-bundle', identityBundlePath);
  } else {
    cliArgs.push('--allowed-signers', allowedSignersPath);
  }
  cliArgs.push('--json', commitRange);

  // Run auths verify with --json flag
  let stdout = '';
  let stderr = '';

  try {
    await exec.exec(authsPath, cliArgs, {
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
        stderr: (data: Buffer) => {
          stderr += data.toString();
        }
      },
      ignoreReturnCode: true
    });
  } catch (error) {
    core.debug(`auths verify stderr: ${stderr}`);
    core.debug(`auths verify stdout: ${stdout}`);
  }

  // Parse JSON output
  let verifyResults: VerificationResult[] = [];
  if (stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout.trim());
      if (Array.isArray(parsed)) {
        verifyResults = processGpgResults(parsed);
      } else {
        verifyResults = processGpgResults([parsed]);
      }
    } catch (e) {
      core.warning(`Failed to parse auths output: ${stdout}`);
      // Fallback: verify one by one
      verifyResults = await verifyCommitsOneByOne(authsPath, commits, options);
    }
  } else {
    verifyResults = await verifyCommitsOneByOne(authsPath, commits, options);
  }

  // Filter out merge commits from verify results (they'll be in mergeResults)
  const mergeSet = new Set(mergeCommits);
  const nonMergeResults = verifyResults.filter(r => !mergeSet.has(r.commit));

  return [...nonMergeResults, ...mergeResults];
}

/**
 * Process results to handle GPG-signed commits gracefully.
 * GPG-signed commits are marked as skipped rather than failed.
 */
function processGpgResults(results: VerificationResult[]): VerificationResult[] {
  return results.map(result => {
    if (!result.valid && result.error &&
        result.error.toLowerCase().includes('gpg')) {
      return {
        ...result,
        valid: true,
        skipped: true,
        skipReason: 'GPG signature (not SSH)'
      };
    }
    if (!result.valid && result.error && !result.failureType) {
      return { ...result, failureType: classifyError(result.error) };
    }
    return result;
  });
}

/**
 * Verify commits one by one (fallback method)
 */
async function verifyCommitsOneByOne(
  authsPath: string,
  commits: string[],
  options: VerifyOptions
): Promise<VerificationResult[]> {
  const { allowedSignersPath, identityBundlePath } = options;
  const useIdentityBundle = identityBundlePath.length > 0;
  const results: VerificationResult[] = [];

  for (const commit of commits) {
    let stdout = '';
    let exitCode = 0;

    const cliArgs = ['verify'];
    if (useIdentityBundle) {
      cliArgs.push('--identity-bundle', identityBundlePath);
    } else {
      cliArgs.push('--allowed-signers', allowedSignersPath);
    }
    cliArgs.push('--json', commit);

    try {
      exitCode = await exec.exec(authsPath, cliArgs, {
        listeners: {
          stdout: (data: Buffer) => {
            stdout += data.toString();
          }
        },
        ignoreReturnCode: true
      });
    } catch {
      exitCode = 2;
    }

    if (stdout.trim()) {
      try {
        const result = JSON.parse(stdout.trim());
        results.push(...processGpgResults([result]));
        continue;
      } catch {
        // Fall through to default result
      }
    }

    const errMsg = exitCode !== 0 ? `Verification failed with exit code ${exitCode}` : undefined;
    results.push({
      commit,
      valid: exitCode === 0,
      error: errMsg,
      failureType: errMsg ? classifyError(errMsg) : undefined
    });
  }

  return results;
}

/**
 * Classify an artifact verification error into a structured failure type.
 */
export function classifyArtifactError(error: string): FailureType {
  const e = error.toLowerCase();
  if (e.includes('signature file') || e.includes('not found') || e.includes('no attestation'))
    return 'no_attestation';
  if (e.includes('not in allowed') || e.includes('unknown') || e.includes('no matching'))
    return 'unknown_signer';
  if (e.includes('invalid') || e.includes('corrupt') || e.includes('digest') || e.includes('mismatch'))
    return 'invalid_signature';
  return 'error';
}

/**
 * Verify a single artifact file using `auths artifact verify`.
 */
export async function verifyArtifact(
  authsPath: string,
  filePath: string,
  identityBundlePath: string,
  attestationDir?: string,
): Promise<ArtifactVerificationResult> {
  const cliArgs = ['artifact', 'verify', filePath, '--identity-bundle', identityBundlePath, '--json'];

  if (attestationDir) {
    const basename = path.basename(filePath);
    const sigPath = path.join(attestationDir, `${basename}.auths.json`);
    cliArgs.push('--signature', sigPath);
  }

  try {
    const result = await exec.getExecOutput(authsPath, cliArgs, {
      ignoreReturnCode: true,
      silent: true,
    });

    if (result.stdout.trim()) {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        return {
          file: parsed.file || filePath,
          valid: parsed.valid === true,
          digestMatch: parsed.digest_match,
          chainValid: parsed.chain_valid,
          capabilityValid: parsed.capability_valid,
          issuer: parsed.issuer,
          commitSha: parsed.commit_sha,
          commitVerified: parsed.commit_verified,
          error: parsed.error,
          failureType: parsed.error ? classifyArtifactError(parsed.error) : undefined,
        };
      } catch {
        return {
          file: filePath,
          valid: false,
          error: `Failed to parse CLI output: ${result.stdout.trim().substring(0, 200)}`,
          failureType: 'error',
        };
      }
    }

    return {
      file: filePath,
      valid: false,
      error: result.stderr.trim() || `CLI exited with code ${result.exitCode}`,
      failureType: 'error',
    };
  } catch (error) {
    return {
      file: filePath,
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error invoking auths CLI',
      failureType: 'error',
    };
  }
}

/**
 * Get list of commits in a range, optionally excluding merge commits
 */
export async function getCommitsInRange(
  commitRange: string,
  skipMerges: boolean = false
): Promise<string[]> {
  let stdout = '';
  const args = ['rev-list'];
  if (skipMerges) {
    args.push('--no-merges');
  }
  args.push(commitRange);

  await exec.exec('git', args, {
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString();
      }
    },
    ignoreReturnCode: true
  });

  return stdout.trim().split('\n').filter(line => line.length > 0);
}

/**
 * Get only merge commits in a range (for reporting as skipped)
 */
async function getMergeCommits(commitRange: string): Promise<string[]> {
  let stdout = '';

  await exec.exec('git', ['rev-list', '--merges', commitRange], {
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString();
      }
    },
    ignoreReturnCode: true
  });

  return stdout.trim().split('\n').filter(line => line.length > 0);
}

/**
 * Ensure auths CLI is available, downloading if necessary.
 * @param version - Specific version to use (e.g., "0.5.0"), or empty for latest
 */
export async function ensureAuthsInstalled(version: string): Promise<string | null> {
  const binaryName = getBinaryName();

  // Check if auths is in PATH (cross-platform)
  try {
    const authsInPath = await io.which('auths', false);
    if (authsInPath) {
      core.info(`Using auths from PATH: ${authsInPath}`);
      return authsInPath;
    }
  } catch {
    // Not found in PATH
  }

  // Determine the version for cache lookup
  const cacheVersion = version || 'latest';

  // Check tool cache
  const cachedPath = tc.find('auths', cacheVersion);
  if (cachedPath) {
    const binaryPath = path.join(cachedPath, binaryName);
    if (fs.existsSync(binaryPath)) {
      core.info(`Using cached auths: ${binaryPath}`);
      return binaryPath;
    }
  }

  // Determine download URL early (needed for cache key)
  const downloadUrl = getAuthsDownloadUrl(version);
  if (!downloadUrl) {
    core.warning(`Cannot determine auths download URL for this platform (${os.platform()}/${os.arch()})`);
    return null;
  }

  // Try cross-run cache (only for pinned versions — "latest" can change between runs)
  const useCrossRunCache = version.length > 0;
  const urlHash = crypto.createHash('sha256').update(downloadUrl).digest('hex').slice(0, 16);
  const cacheKey = `auths-bin-${os.platform()}-${os.arch()}-${urlHash}`;
  const cachePaths = [path.join(os.tmpdir(), 'auths-cache')];

  if (useCrossRunCache) {
    try {
      const hit = await cache.restoreCache(cachePaths, cacheKey);
      if (hit) {
        core.info(`Restored auths from cache (key: ${cacheKey})`);
        const restoredBinary = path.join(cachePaths[0], binaryName);
        if (fs.existsSync(restoredBinary)) {
          const cachedDir = await tc.cacheDir(cachePaths[0], 'auths', cacheVersion);
          return path.join(cachedDir, binaryName);
        }
      }
    } catch (e) {
      core.debug(`Cache restore failed (non-fatal): ${e}`);
    }
  }

  // Try to download from releases
  core.info('auths CLI not found, attempting to download...');

  try {
    core.info(`Downloading auths from: ${downloadUrl}`);
    const downloadPath = await tc.downloadTool(downloadUrl);

    // Verify SHA256 checksum
    await verifyChecksum(downloadUrl, downloadPath);

    // Extract if archive
    let extractedPath: string;
    if (downloadUrl.endsWith('.tar.gz')) {
      extractedPath = await tc.extractTar(downloadPath);
    } else if (downloadUrl.endsWith('.zip')) {
      extractedPath = await tc.extractZip(downloadPath);
    } else {
      extractedPath = downloadPath;
    }

    // Find the binary
    const binaryPath = path.join(extractedPath, binaryName);
    if (fs.existsSync(binaryPath)) {
      // Make executable (no-op on Windows)
      if (os.platform() !== 'win32') {
        fs.chmodSync(binaryPath, '755');
      }

      // Save to cross-run cache (best-effort, don't fail the action)
      if (useCrossRunCache) {
        try {
          fs.cpSync(extractedPath, cachePaths[0], { recursive: true });
          await cache.saveCache(cachePaths, cacheKey);
          core.info(`Saved auths to cache (key: ${cacheKey})`);
        } catch (e) {
          core.debug(`Cache save failed (non-fatal): ${e}`);
        }
      }

      // Cache it with the actual version (tool-cache for same-run reuse)
      const cachedDir = await tc.cacheDir(extractedPath, 'auths', cacheVersion);
      core.info(`Cached auths at: ${cachedDir}`);

      return path.join(cachedDir, binaryName);
    }

    core.warning(`Binary not found at expected path: ${binaryPath}`);
  } catch (error) {
    core.warning(`Failed to download auths: ${error}`);
  }

  return null;
}

/**
 * Verify SHA256 checksum of a downloaded file against a .sha256 file from the release.
 * Warns but continues if checksum file is not available (older releases).
 * Throws if checksum file exists but doesn't match (potential tampering).
 */
export async function verifyChecksum(downloadUrl: string, filePath: string): Promise<void> {
  const checksumUrl = `${downloadUrl}.sha256`;

  try {
    const checksumPath = await tc.downloadTool(checksumUrl);
    const checksumContent = fs.readFileSync(checksumPath, 'utf8').trim();
    // Format: "<hash>  <filename>" or just "<hash>"
    const expectedHash = checksumContent.split(/\s+/)[0].toLowerCase();

    const fileBuffer = fs.readFileSync(filePath);
    const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    if (actualHash !== expectedHash) {
      throw new Error(
        `SHA256 checksum mismatch for downloaded binary!\n` +
        `Expected: ${expectedHash}\n` +
        `Got:      ${actualHash}\n` +
        `This could indicate a compromised release. Do NOT use this binary.`
      );
    }

    core.info(`SHA256 checksum verified: ${actualHash.substring(0, 16)}...`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('checksum mismatch')) {
      throw error;
    }
    // Checksum file not found (older release) — warn but continue
    core.warning(
      'SHA256 checksum file not available for this release. ' +
      'Skipping verification. Consider upgrading to a release with checksums.'
    );
  }
}

/**
 * Get the platform-specific binary name
 */
export function getBinaryName(): string {
  return os.platform() === 'win32' ? 'auths.exe' : 'auths';
}

/**
 * Get download URL for auths binary.
 * @param version - Specific version (e.g., "0.5.0"), or empty for latest
 */
export function getAuthsDownloadUrl(version: string): string | null {
  const platform = os.platform();
  const arch = os.arch();

  // Map to release asset names
  const platformMap: Record<string, string> = {
    'linux': 'linux',
    'darwin': 'macos',
    'win32': 'windows'
  };

  const archMap: Record<string, string> = {
    'x64': 'x86_64',
    'arm64': 'aarch64'
  };

  const platformName = platformMap[platform];
  const archName = archMap[arch];

  if (!platformName || !archName) {
    return null;
  }

  const ext = platform === 'win32' ? '.zip' : '.tar.gz';
  const assetName = `auths-${platformName}-${archName}${ext}`;

  if (version) {
    return `https://github.com/${CLI_RELEASE_REPO}/releases/download/v${version}/${assetName}`;
  }

  return `https://github.com/${CLI_RELEASE_REPO}/releases/latest/download/${assetName}`;
}
