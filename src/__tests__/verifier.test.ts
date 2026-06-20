import { getAuthsDownloadUrl, getBinaryName, getCommitsInRange, verifyChecksum, ensureAuthsInstalled, verifyArtifact, classifyArtifactError, ArtifactVerificationResult, processGpgResults, VerificationResult } from '../verifier';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Mock os module for cross-platform testing
jest.mock('os', () => {
  const realOs = jest.requireActual('os');
  return {
    platform: jest.fn(),
    arch: jest.fn(),
    homedir: jest.fn(() => '/home/test'),
    tmpdir: jest.fn(() => realOs.tmpdir()),
  };
});

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  getInput: jest.fn(() => ''),
}));

jest.mock('@actions/exec', () => ({
  exec: jest.fn(),
  getExecOutput: jest.fn(),
}));

jest.mock('@actions/io', () => ({
  which: jest.fn(),
}));

jest.mock('@actions/tool-cache', () => ({
  downloadTool: jest.fn(),
  extractTar: jest.fn(),
  extractZip: jest.fn(),
  cacheDir: jest.fn(),
  find: jest.fn(),
}));

jest.mock('@actions/cache', () => ({
  restoreCache: jest.fn(),
  saveCache: jest.fn(),
}));

const mockOs = require('os');
const mockExec = require('@actions/exec');
const mockTc = require('@actions/tool-cache');
const mockCache = require('@actions/cache');
const mockIo = require('@actions/io');
const mockCore = require('@actions/core');

describe('getAuthsDownloadUrl', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns Linux x86_64 tar.gz URL for a pinned version', () => {
    mockOs.platform.mockReturnValue('linux');
    mockOs.arch.mockReturnValue('x64');

    const url = getAuthsDownloadUrl('0.5.0');
    expect(url).toBe(
      'https://github.com/auths-dev/auths/releases/download/v0.5.0/auths-linux-x86_64.tar.gz'
    );
  });

  it('returns macOS aarch64 tar.gz URL for a pinned version', () => {
    mockOs.platform.mockReturnValue('darwin');
    mockOs.arch.mockReturnValue('arm64');

    const url = getAuthsDownloadUrl('0.5.0');
    expect(url).toBe(
      'https://github.com/auths-dev/auths/releases/download/v0.5.0/auths-macos-aarch64.tar.gz'
    );
  });

  it('returns Windows x86_64 zip URL for a pinned version', () => {
    mockOs.platform.mockReturnValue('win32');
    mockOs.arch.mockReturnValue('x64');

    const url = getAuthsDownloadUrl('0.5.0');
    expect(url).toBe(
      'https://github.com/auths-dev/auths/releases/download/v0.5.0/auths-windows-x86_64.zip'
    );
  });

  it('returns versioned URL when version specified', () => {
    mockOs.platform.mockReturnValue('linux');
    mockOs.arch.mockReturnValue('x64');

    const url = getAuthsDownloadUrl('0.5.0');
    expect(url).toBe(
      'https://github.com/auths-dev/auths/releases/download/v0.5.0/auths-linux-x86_64.tar.gz'
    );
  });

  it('returns null for unsupported platform', () => {
    mockOs.platform.mockReturnValue('freebsd');
    mockOs.arch.mockReturnValue('x64');

    const url = getAuthsDownloadUrl('');
    expect(url).toBeNull();
  });

  it('returns null for unsupported architecture', () => {
    mockOs.platform.mockReturnValue('linux');
    mockOs.arch.mockReturnValue('s390x');

    const url = getAuthsDownloadUrl('');
    expect(url).toBeNull();
  });

  it('returns macOS x86_64 URL for a pinned version', () => {
    mockOs.platform.mockReturnValue('darwin');
    mockOs.arch.mockReturnValue('x64');

    const url = getAuthsDownloadUrl('0.5.0');
    expect(url).toBe(
      'https://github.com/auths-dev/auths/releases/download/v0.5.0/auths-macos-x86_64.tar.gz'
    );
  });

  it('returns Linux aarch64 URL for a pinned version', () => {
    mockOs.platform.mockReturnValue('linux');
    mockOs.arch.mockReturnValue('arm64');

    const url = getAuthsDownloadUrl('0.5.0');
    expect(url).toBe(
      'https://github.com/auths-dev/auths/releases/download/v0.5.0/auths-linux-aarch64.tar.gz'
    );
  });

  it('returns null when no version is pinned (no latest fallback)', () => {
    mockOs.platform.mockReturnValue('linux');
    mockOs.arch.mockReturnValue('x64');

    expect(getAuthsDownloadUrl('')).toBeNull();
  });
});

describe('getBinaryName', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns auths.exe on Windows', () => {
    mockOs.platform.mockReturnValue('win32');
    expect(getBinaryName()).toBe('auths.exe');
  });

  it('returns auths on Linux', () => {
    mockOs.platform.mockReturnValue('linux');
    expect(getBinaryName()).toBe('auths');
  });

  it('returns auths on macOS', () => {
    mockOs.platform.mockReturnValue('darwin');
    expect(getBinaryName()).toBe('auths');
  });
});

describe('getCommitsInRange', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('calls git rev-list without --no-merges when skipMerges is false', async () => {
    mockExec.exec.mockImplementation(async (_cmd: string, args: string[], options: any) => {
      const data = Buffer.from('abc123\ndef456\n');
      options?.listeners?.stdout?.(data);
      return 0;
    });

    const commits = await getCommitsInRange('HEAD~2..HEAD', false);
    expect(commits).toEqual(['abc123', 'def456']);
    expect(mockExec.exec).toHaveBeenCalledWith(
      'git',
      ['rev-list', 'HEAD~2..HEAD'],
      expect.any(Object)
    );
  });

  it('calls git rev-list with --no-merges when skipMerges is true', async () => {
    mockExec.exec.mockImplementation(async (_cmd: string, args: string[], options: any) => {
      const data = Buffer.from('abc123\n');
      options?.listeners?.stdout?.(data);
      return 0;
    });

    const commits = await getCommitsInRange('HEAD~2..HEAD', true);
    expect(commits).toEqual(['abc123']);
    expect(mockExec.exec).toHaveBeenCalledWith(
      'git',
      ['rev-list', '--no-merges', 'HEAD~2..HEAD'],
      expect.any(Object)
    );
  });

  it('returns empty array for empty output', async () => {
    mockExec.exec.mockImplementation(async (_cmd: string, _args: string[], options: any) => {
      const data = Buffer.from('');
      options?.listeners?.stdout?.(data);
      return 0;
    });

    const commits = await getCommitsInRange('HEAD~0..HEAD', false);
    expect(commits).toEqual([]);
  });
});

describe('verifyChecksum', () => {
  const testDir = path.join(require('os').tmpdir(), 'auths-test-checksum');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    jest.resetAllMocks();
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('passes when checksum matches', async () => {
    // Create a test file
    const testFile = path.join(testDir, 'test.tar.gz');
    const content = 'test binary content';
    fs.writeFileSync(testFile, content);

    // Compute its hash
    const hash = crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');

    // Create checksum file
    const checksumFile = path.join(testDir, 'test.tar.gz.sha256');
    fs.writeFileSync(checksumFile, `${hash}  test.tar.gz\n`);

    // Mock tc.downloadTool to return the checksum file path
    mockTc.downloadTool.mockResolvedValue(checksumFile);

    // Should not throw
    await expect(verifyChecksum('https://example.com/test.tar.gz', testFile)).resolves.toBeUndefined();
  });

  it('throws when checksum does not match', async () => {
    const testFile = path.join(testDir, 'test.tar.gz');
    fs.writeFileSync(testFile, 'real content');

    const checksumFile = path.join(testDir, 'test.tar.gz.sha256');
    fs.writeFileSync(checksumFile, 'deadbeef00000000000000000000000000000000000000000000000000000000  test.tar.gz\n');

    mockTc.downloadTool.mockResolvedValue(checksumFile);

    await expect(verifyChecksum('https://example.com/test.tar.gz', testFile))
      .rejects.toThrow('checksum mismatch');
  });

  it('fails closed when the checksum file is not available', async () => {
    const testFile = path.join(testDir, 'test.tar.gz');
    fs.writeFileSync(testFile, 'content');

    // Mock download failure (404 / network) for the .sha256 — must refuse to run.
    mockTc.downloadTool.mockRejectedValue(new Error('HTTP 404'));

    await expect(verifyChecksum('https://example.com/test.tar.gz', testFile))
      .rejects.toThrow('Refusing to run an unverified binary');
  });
});

describe('processGpgResults', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  const gitReturning = (raw: string) =>
    mockExec.exec.mockImplementation(async (_cmd: string, _args: string[], opts: any) => {
      opts?.listeners?.stdout?.(Buffer.from(raw));
      return 0;
    });

  it('does not flip a real failure to valid just because the error text contains "gpg"', async () => {
    gitReturning('tree 0000\nauthor a <a@x> 1 +0000\n\nmsg\n'); // not pgp-signed
    const results: VerificationResult[] = [
      { commit: 'deadbeef', valid: false, error: 'invalid signature (gpg parser noise in a real failure)' }
    ];

    const [out] = await processGpgResults(results);

    expect(out.valid).toBe(false);
    expect(out.skipped).toBeFalsy();
  });

  it('skips a commit positively identified as PGP-signed', async () => {
    gitReturning('tree 0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n abc\n -----END PGP SIGNATURE-----\n\nmsg\n');
    const results: VerificationResult[] = [
      { commit: 'cafebabe', valid: false, error: 'no auths trailer' }
    ];

    const [out] = await processGpgResults(results);

    expect(out.valid).toBe(true);
    expect(out.skipped).toBe(true);
    expect(out.skipReason).toMatch(/gpg/i);
  });

  it('does not skip a failing SSH-signed commit (in scope, must stay failed)', async () => {
    gitReturning('tree 0000\ngpgsig -----BEGIN SSH SIGNATURE-----\n abc\n -----END SSH SIGNATURE-----\n\nmsg\n');
    const results: VerificationResult[] = [
      { commit: 'feedface', valid: false, error: 'signature verification failed' }
    ];

    const [out] = await processGpgResults(results);

    expect(out.valid).toBe(false);
    expect(out.skipped).toBeFalsy();
  });
});

describe('ensureAuthsInstalled - cross-run caching', () => {
  const realTmpdir = require('os').tmpdir();
  const cachePath = path.join(realTmpdir, 'auths-cache');

  beforeEach(() => {
    jest.resetAllMocks();
    // Default: not in PATH, not in tool-cache
    mockIo.which.mockResolvedValue('');
    mockTc.find.mockReturnValue('');
    mockOs.platform.mockReturnValue('linux');
    mockOs.arch.mockReturnValue('x64');
    mockOs.tmpdir.mockReturnValue(realTmpdir);
    // Clean up cache path
    if (fs.existsSync(cachePath)) {
      fs.rmSync(cachePath, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(cachePath)) {
      fs.rmSync(cachePath, { recursive: true });
    }
  });

  it('restores from cache on hit and re-verifies the binary', async () => {
    // Set up: cache restore returns a key hit with a binary on disk
    fs.mkdirSync(cachePath, { recursive: true });
    const cachedBinary = path.join(cachePath, 'auths');
    fs.writeFileSync(cachedBinary, 'binary-content');

    // A matching release checksum so the re-verification passes.
    const checksumFile = path.join(realTmpdir, 'auths-cache-ok.sha256');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(cachedBinary)).digest('hex');
    fs.writeFileSync(checksumFile, `${hash}  auths\n`);

    mockCache.restoreCache.mockResolvedValue('auths-bin-linux-x64-abc123');
    mockTc.downloadTool.mockResolvedValue(checksumFile);
    mockTc.cacheDir.mockResolvedValue('/tool-cache/auths/0.5.0');

    const result = await ensureAuthsInstalled('0.5.0');

    expect(mockCache.restoreCache).toHaveBeenCalledTimes(1);
    expect(mockTc.cacheDir).toHaveBeenCalledWith(cachePath, 'auths', '0.5.0');
    // The cached binary is re-verified against the release checksum before use.
    expect(mockTc.downloadTool).toHaveBeenCalled();
    expect(result).toBe('/tool-cache/auths/0.5.0/auths');

    if (fs.existsSync(checksumFile)) fs.rmSync(checksumFile);
  });

  it('re-verifies a cache hit and rejects a tampered binary (not trusted blind)', async () => {
    // A cross-run cache hit whose restored binary does NOT match the release checksum.
    fs.mkdirSync(cachePath, { recursive: true });
    fs.writeFileSync(path.join(cachePath, 'auths'), 'tampered-binary');

    mockCache.restoreCache.mockResolvedValue('auths-bin-linux-x64-abc123');
    mockTc.cacheDir.mockResolvedValue('/tool-cache/auths/0.5.0');

    // The release .sha256 does not match the tampered cached binary.
    const checksumFile = path.join(realTmpdir, 'auths-cache-tampered.sha256');
    fs.writeFileSync(
      checksumFile,
      'deadbeef00000000000000000000000000000000000000000000000000000000  auths\n'
    );
    mockTc.downloadTool.mockResolvedValue(checksumFile);

    await expect(ensureAuthsInstalled('0.5.0')).rejects.toThrow(/checksum mismatch/i);

    if (fs.existsSync(checksumFile)) fs.rmSync(checksumFile);
  });

  it('re-verifies a tool-cache hit and rejects a tampered binary', async () => {
    const toolCacheDir = path.join(realTmpdir, 'auths-toolcache');
    fs.mkdirSync(toolCacheDir, { recursive: true });
    fs.writeFileSync(path.join(toolCacheDir, 'auths'), 'tampered-binary');
    mockTc.find.mockReturnValue(toolCacheDir);

    const checksumFile = path.join(realTmpdir, 'auths-toolcache-tampered.sha256');
    fs.writeFileSync(
      checksumFile,
      'deadbeef00000000000000000000000000000000000000000000000000000000  auths\n'
    );
    mockTc.downloadTool.mockResolvedValue(checksumFile);

    await expect(ensureAuthsInstalled('0.5.0')).rejects.toThrow(/checksum mismatch/i);

    if (fs.existsSync(toolCacheDir)) fs.rmSync(toolCacheDir, { recursive: true });
    if (fs.existsSync(checksumFile)) fs.rmSync(checksumFile);
  });

  it('downloads and saves to cache on miss', async () => {
    const extractedDir = path.join(realTmpdir, 'auths-extracted');
    fs.mkdirSync(extractedDir, { recursive: true });
    fs.writeFileSync(path.join(extractedDir, 'auths'), 'binary-content');

    // A real download file + matching .sha256 so the (now fail-closed) checksum passes.
    const dlFile = path.join(realTmpdir, 'auths-dl.tar.gz');
    fs.writeFileSync(dlFile, 'binary-bytes');
    const sumFile = `${dlFile}.sha256`;
    const dlHash = crypto.createHash('sha256').update(fs.readFileSync(dlFile)).digest('hex');
    fs.writeFileSync(sumFile, `${dlHash}  auths.tar.gz\n`);

    mockCache.restoreCache.mockResolvedValue(undefined);
    mockTc.downloadTool.mockImplementation(async (url: string) => (url.endsWith('.sha256') ? sumFile : dlFile));
    mockTc.extractTar.mockResolvedValue(extractedDir);
    mockCache.saveCache.mockResolvedValue(1);
    mockTc.cacheDir.mockResolvedValue('/tool-cache/auths/0.5.0');

    const result = await ensureAuthsInstalled('0.5.0');

    expect(mockCache.restoreCache).toHaveBeenCalledTimes(1);
    expect(mockTc.downloadTool).toHaveBeenCalled();
    expect(mockCache.saveCache).toHaveBeenCalledTimes(1);
    expect(result).toBe('/tool-cache/auths/0.5.0/auths');

    // Clean up
    if (fs.existsSync(extractedDir)) {
      fs.rmSync(extractedDir, { recursive: true });
    }
    [dlFile, sumFile].forEach(f => { if (fs.existsSync(f)) fs.rmSync(f); });
  });

  it('continues on cache restore failure', async () => {
    const extractedDir = path.join(realTmpdir, 'auths-extracted-err');
    fs.mkdirSync(extractedDir, { recursive: true });
    fs.writeFileSync(path.join(extractedDir, 'auths'), 'binary-content');

    const dlFile = path.join(realTmpdir, 'auths-dl-err.tar.gz');
    fs.writeFileSync(dlFile, 'binary-bytes');
    const sumFile = `${dlFile}.sha256`;
    const dlHash = crypto.createHash('sha256').update(fs.readFileSync(dlFile)).digest('hex');
    fs.writeFileSync(sumFile, `${dlHash}  auths.tar.gz\n`);

    mockCache.restoreCache.mockRejectedValue(new Error('Cache service unavailable'));
    mockTc.downloadTool.mockImplementation(async (url: string) => (url.endsWith('.sha256') ? sumFile : dlFile));
    mockTc.extractTar.mockResolvedValue(extractedDir);
    mockCache.saveCache.mockResolvedValue(1);
    mockTc.cacheDir.mockResolvedValue('/tool-cache/auths/0.5.0');

    const result = await ensureAuthsInstalled('0.5.0');

    // Should fall through to download
    expect(mockTc.downloadTool).toHaveBeenCalled();
    expect(result).toBe('/tool-cache/auths/0.5.0/auths');

    if (fs.existsSync(extractedDir)) {
      fs.rmSync(extractedDir, { recursive: true });
    }
    [dlFile, sumFile].forEach(f => { if (fs.existsSync(f)) fs.rmSync(f); });
  });

  it('refuses to run when no version is pinned (no latest fallback)', async () => {
    // Not in PATH (mocked empty in beforeEach), no version → fail closed before any download.
    await expect(ensureAuthsInstalled('')).rejects.toThrow("'auths-version' input must be pinned");
    expect(mockTc.downloadTool).not.toHaveBeenCalled();
  });
});

describe('classifyArtifactError', () => {
  it('classifies missing signature file as no_attestation', () => {
    expect(classifyArtifactError('Failed to read signature file "foo.auths.json": not found')).toBe('no_attestation');
  });

  it('classifies not found as no_attestation', () => {
    expect(classifyArtifactError('Attestation not found for artifact')).toBe('no_attestation');
  });

  it('classifies unknown signer', () => {
    expect(classifyArtifactError('Signer not in allowed list: unknown identity')).toBe('unknown_signer');
  });

  it('classifies invalid/corrupt signatures', () => {
    expect(classifyArtifactError('Invalid attestation signature')).toBe('invalid_signature');
  });

  it('classifies digest mismatch', () => {
    expect(classifyArtifactError('Digest mismatch: expected abc got def')).toBe('invalid_signature');
  });

  it('defaults to error for unrecognized messages', () => {
    expect(classifyArtifactError('Something totally unexpected happened')).toBe('error');
  });
});

describe('verifyArtifact', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns valid result on exit code 0 with valid JSON', async () => {
    const cliOutput = {
      file: '/workspace/dist/app.tar.gz',
      valid: true,
      digest_match: true,
      chain_valid: true,
      capability_valid: true,
      issuer: 'did:auths:test-user',
    };

    mockExec.getExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(cliOutput),
      stderr: '',
    });

    const result = await verifyArtifact('/usr/bin/auths', '/workspace/dist/app.tar.gz', '/tmp/bundle.json');

    expect(result.valid).toBe(true);
    expect(result.file).toBe('/workspace/dist/app.tar.gz');
    expect(result.digestMatch).toBe(true);
    expect(result.chainValid).toBe(true);
    expect(result.issuer).toBe('did:auths:test-user');
    expect(result.error).toBeUndefined();

    expect(mockExec.getExecOutput).toHaveBeenCalledWith(
      '/usr/bin/auths',
      ['artifact', 'verify', '/workspace/dist/app.tar.gz', '--identity-bundle', '/tmp/bundle.json', '--json'],
      expect.objectContaining({ ignoreReturnCode: true, silent: true })
    );
  });

  it('returns invalid result on exit code 1', async () => {
    const cliOutput = {
      file: '/workspace/dist/app.tar.gz',
      valid: false,
      digest_match: false,
      error: 'Digest mismatch',
    };

    mockExec.getExecOutput.mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify(cliOutput),
      stderr: '',
    });

    const result = await verifyArtifact('/usr/bin/auths', '/workspace/dist/app.tar.gz', '/tmp/bundle.json');

    expect(result.valid).toBe(false);
    expect(result.digestMatch).toBe(false);
    expect(result.error).toBe('Digest mismatch');
    expect(result.failureType).toBe('invalid_signature');
  });

  it('returns error result on exit code 2', async () => {
    const cliOutput = {
      file: '/workspace/dist/app.tar.gz',
      valid: false,
      error: 'Failed to read signature file "app.tar.gz.auths.json": No such file',
    };

    mockExec.getExecOutput.mockResolvedValue({
      exitCode: 2,
      stdout: JSON.stringify(cliOutput),
      stderr: '',
    });

    const result = await verifyArtifact('/usr/bin/auths', '/workspace/dist/app.tar.gz', '/tmp/bundle.json');

    expect(result.valid).toBe(false);
    expect(result.failureType).toBe('no_attestation');
  });

  it('handles JSON parse failure gracefully', async () => {
    mockExec.getExecOutput.mockResolvedValue({
      exitCode: 2,
      stdout: 'Not valid JSON at all',
      stderr: '',
    });

    const result = await verifyArtifact('/usr/bin/auths', '/workspace/dist/app.tar.gz', '/tmp/bundle.json');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Failed to parse CLI output');
    expect(result.failureType).toBe('error');
  });

  it('handles empty stdout with stderr', async () => {
    mockExec.getExecOutput.mockResolvedValue({
      exitCode: 2,
      stdout: '',
      stderr: 'auths: command not found',
    });

    const result = await verifyArtifact('/usr/bin/auths', '/workspace/dist/app.tar.gz', '/tmp/bundle.json');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('auths: command not found');
    expect(result.failureType).toBe('error');
  });

  it('handles exec exception', async () => {
    mockExec.getExecOutput.mockRejectedValue(new Error('spawn ENOENT'));

    const result = await verifyArtifact('/usr/bin/auths', '/workspace/dist/app.tar.gz', '/tmp/bundle.json');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('spawn ENOENT');
    expect(result.failureType).toBe('error');
  });

  it('constructs --signature flag when attestationDir provided', async () => {
    mockExec.getExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ file: '/workspace/dist/app.tar.gz', valid: true }),
      stderr: '',
    });

    await verifyArtifact('/usr/bin/auths', '/workspace/dist/app.tar.gz', '/tmp/bundle.json', '/attestations');

    expect(mockExec.getExecOutput).toHaveBeenCalledWith(
      '/usr/bin/auths',
      [
        'artifact', 'verify', '/workspace/dist/app.tar.gz',
        '--identity-bundle', '/tmp/bundle.json',
        '--json',
        '--signature', expect.stringContaining('app.tar.gz.auths.json'),
      ],
      expect.any(Object)
    );
  });

  it('does not include --signature when no attestationDir', async () => {
    mockExec.getExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ file: '/workspace/dist/app.tar.gz', valid: true }),
      stderr: '',
    });

    await verifyArtifact('/usr/bin/auths', '/workspace/dist/app.tar.gz', '/tmp/bundle.json');

    const callArgs = mockExec.getExecOutput.mock.calls[0][1];
    expect(callArgs).not.toContain('--signature');
  });
});
