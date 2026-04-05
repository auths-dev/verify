import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveIdentity } from '../main';

describe('resolveIdentity', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    tmpFiles.length = 0;
  });

  it('returns allowed-signers default when input is empty', () => {
    const result = resolveIdentity('');
    expect(result.mode).toBe('allowed-signers');
    expect(result.allowedSignersPath).toBe('.auths/allowed_signers');
    expect(result.identityBundlePath).toBe('');
    expect(result.tempFile).toBeUndefined();
  });

  it('detects CiToken JSON (version + verify_bundle)', () => {
    const ciToken = JSON.stringify({
      version: 1,
      verify_bundle: { identity_did: 'did:auths:test', public_key: 'ssh-ed25519 AAAA...' },
    });

    const result = resolveIdentity(ciToken);
    expect(result.mode).toBe('identity-bundle');
    expect(result.identityBundlePath).toBeTruthy();
    expect(result.tempFile).toBe(result.identityBundlePath);

    // Temp file should contain the verify_bundle content
    const written = JSON.parse(fs.readFileSync(result.tempFile!, 'utf8'));
    expect(written.identity_did).toBe('did:auths:test');

    tmpFiles.push(result.tempFile!);
  });

  it('detects raw identity bundle JSON (identity_did)', () => {
    const bundle = JSON.stringify({
      identity_did: 'did:auths:user',
      public_key: 'ssh-ed25519 AAAA...',
      bundle_timestamp: new Date().toISOString(),
      max_valid_for_secs: 86400,
    });

    const result = resolveIdentity(bundle);
    expect(result.mode).toBe('identity-bundle');
    expect(result.tempFile).toBe(result.identityBundlePath);

    tmpFiles.push(result.tempFile!);
  });

  it('detects file path to identity bundle JSON', () => {
    const bundlePath = path.join(os.tmpdir(), `test-bundle-${Date.now()}.json`);
    fs.writeFileSync(bundlePath, JSON.stringify({ identity_did: 'did:auths:file-test' }));
    tmpFiles.push(bundlePath);

    const result = resolveIdentity(bundlePath);
    expect(result.mode).toBe('identity-bundle');
    expect(result.identityBundlePath).toBe(bundlePath);
    expect(result.tempFile).toBeUndefined();
  });

  it('detects file path to allowed-signers text file', () => {
    const sigPath = path.join(os.tmpdir(), `test-signers-${Date.now()}`);
    fs.writeFileSync(sigPath, 'alice@example.com ssh-ed25519 AAAA...\n');
    tmpFiles.push(sigPath);

    const result = resolveIdentity(sigPath);
    expect(result.mode).toBe('allowed-signers');
    expect(result.allowedSignersPath).toBe(sigPath);
    expect(result.identityBundlePath).toBe('');
  });

  it('throws on JSON without recognized fields', () => {
    const badJson = JSON.stringify({ unrecognized: true });
    expect(() => resolveIdentity(badJson)).toThrow('does not look like an identity bundle or CI token');
  });

  it('throws on non-existent file path', () => {
    expect(() => resolveIdentity('/nonexistent/path/to/file')).toThrow('not valid JSON and file not found');
  });

  it('throws on whitespace-only input', () => {
    expect(() => resolveIdentity('  ')).toThrow('not valid JSON and file not found');
  });
});
