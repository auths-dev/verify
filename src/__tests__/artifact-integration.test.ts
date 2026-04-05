/**
 * Integration tests for artifact verification in main.ts run() flow.
 *
 * Since run() is called at module load time, we use jest.isolateModules
 * to re-import the module with different mock configurations per test.
 */

// Shared mock state — reset per test
let mockInputs: Record<string, string> = {};
let mockMultilineInputs: Record<string, string[]> = {};
let mockOutputs: Record<string, string> = {};
let mockFailed: string[] = [];
let mockWarnings: string[] = [];
let mockGlobFiles: string[] = [];
let mockArtifactResults: any[] = [];
let mockVerifyCommitsResult: any[] = [];

jest.mock('@actions/github', () => ({
  context: {
    eventName: 'push',
    payload: { before: 'aaa', after: 'bbb' },
    repo: { owner: 'test', repo: 'test-repo' },
  },
  getOctokit: jest.fn(),
}));

jest.mock('@actions/exec', () => ({
  exec: jest.fn().mockImplementation(async (_cmd: string, _args: string[], options: any) => {
    // Mock git rev-list to return empty
    options?.listeners?.stdout?.(Buffer.from(''));
    return 0;
  }),
  getExecOutput: jest.fn(),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn((p: string) => {
      if (p.includes('bundle') || p.includes('allowed_signers')) return true;
      return actual.existsSync(p);
    }),
    readFileSync: jest.fn((p: string, encoding?: string) => {
      if (p.includes('bundle')) {
        return JSON.stringify({
          bundle_timestamp: new Date().toISOString(),
          max_valid_for_secs: 86400,
        });
      }
      return actual.readFileSync(p, encoding);
    }),
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
  };
});

jest.mock('@actions/core', () => ({
  getInput: jest.fn((name: string) => mockInputs[name] || ''),
  getMultilineInput: jest.fn((name: string) => mockMultilineInputs[name] || []),
  setOutput: jest.fn((name: string, value: string) => { mockOutputs[name] = value; }),
  setFailed: jest.fn((msg: string) => { mockFailed.push(msg); }),
  info: jest.fn(),
  warning: jest.fn((msg: string) => { mockWarnings.push(typeof msg === 'string' ? msg : ''); }),
  error: jest.fn(),
  debug: jest.fn(),
  summary: {
    addRaw: jest.fn().mockReturnThis(),
    write: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@actions/glob', () => ({
  create: jest.fn().mockImplementation(async () => ({
    glob: jest.fn().mockResolvedValue(mockGlobFiles),
  })),
}));

jest.mock('@actions/io', () => ({
  which: jest.fn().mockResolvedValue(''),
}));

jest.mock('@actions/tool-cache', () => ({
  find: jest.fn().mockReturnValue(''),
  downloadTool: jest.fn(),
  extractTar: jest.fn(),
  cacheDir: jest.fn(),
}));

jest.mock('@actions/cache', () => ({
  restoreCache: jest.fn(),
  saveCache: jest.fn(),
}));

// Mock verifier module
const mockVerifyCommits = jest.fn();
const mockEnsureAuthsInstalled = jest.fn();
const mockVerifyArtifact = jest.fn();
const mockRunPreflightChecks = jest.fn();

jest.mock('../verifier', () => {
  const actual = jest.requireActual('../verifier');
  return {
    ...actual,
    verifyCommits: (...args: any[]) => mockVerifyCommits(...args),
    ensureAuthsInstalled: (...args: any[]) => mockEnsureAuthsInstalled(...args),
    verifyArtifact: (...args: any[]) => mockVerifyArtifact(...args),
    runPreflightChecks: (...args: any[]) => mockRunPreflightChecks(...args),
  };
});

function resetMockState() {
  mockInputs = {
    'identity': '',
    'commit-range': 'HEAD^..HEAD',
    'fail-on-unsigned': 'true',
    'skip-merge-commits': 'true',
    'auths-version': '',
    'post-pr-comment': 'false',
    'github-token': '',
    'artifact-paths': '',
    'artifact-attestation-dir': '',
    'fail-on-unattested': 'true',
  };
  mockMultilineInputs = {
    'artifact-paths': [],
  };
  mockOutputs = {};
  mockFailed = [];
  mockWarnings = [];
  mockGlobFiles = [];
  mockArtifactResults = [];
  mockVerifyCommitsResult = [];

  mockRunPreflightChecks.mockResolvedValue(undefined);
  mockVerifyCommits.mockResolvedValue([]);
  mockEnsureAuthsInstalled.mockResolvedValue('/usr/bin/auths');
  mockVerifyArtifact.mockReset();
}

// Helper to run main.ts in isolation
async function runMain() {
  // Small delay to let the async run() complete
  return jest.isolateModulesAsync(async () => {
    require('../main');
    // Wait for the async run() to settle
    await new Promise(resolve => setTimeout(resolve, 50));
  });
}

describe('Artifact verification integration', () => {
  beforeEach(() => {
    resetMockState();
    jest.clearAllMocks();
  });

  it('does no artifact work when artifact-paths is empty', async () => {
    mockMultilineInputs['artifact-paths'] = [];

    await runMain();

    expect(mockVerifyArtifact).not.toHaveBeenCalled();
    expect(mockOutputs['artifact-results']).toBe('[]');
    expect(mockOutputs['artifacts-verified']).toBe('');
  });

  it('verifies artifacts when artifact-paths provided', async () => {
    mockMultilineInputs['artifact-paths'] = ['dist/*.tar.gz'];
    mockInputs['identity'] = '/tmp/bundle.json';
    mockGlobFiles = ['/workspace/dist/app.tar.gz'];

    mockVerifyArtifact.mockResolvedValue({
      file: '/workspace/dist/app.tar.gz',
      valid: true,
      issuer: 'did:auths:test',
    });

    // Set GITHUB_WORKSPACE
    const origWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = '/workspace';

    await runMain();

    process.env.GITHUB_WORKSPACE = origWorkspace;

    expect(mockVerifyArtifact).toHaveBeenCalledTimes(1);
    expect(mockOutputs['artifacts-verified']).toBe('true');

    const results = JSON.parse(mockOutputs['artifact-results']);
    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(true);
  });

  it('emits warning when artifact-paths matches no files', async () => {
    mockMultilineInputs['artifact-paths'] = ['nonexistent/*.tar.gz'];
    mockInputs['identity'] = '/tmp/bundle.json';
    mockGlobFiles = [];

    await runMain();

    expect(mockVerifyArtifact).not.toHaveBeenCalled();
    expect(mockWarnings).toContain('artifact-paths provided but no files matched');
  });

  it('fails when fail-on-unattested is true and artifact fails', async () => {
    mockMultilineInputs['artifact-paths'] = ['dist/*.tar.gz'];
    mockInputs['identity'] = '/tmp/bundle.json';
    mockGlobFiles = ['/workspace/dist/bad.tar.gz'];

    mockVerifyArtifact.mockResolvedValue({
      file: '/workspace/dist/bad.tar.gz',
      valid: false,
      error: 'Digest mismatch',
    });

    const origWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = '/workspace';

    await runMain();

    process.env.GITHUB_WORKSPACE = origWorkspace;

    expect(mockFailed).toContain('1 artifact(s) failed attestation verification');
  });

  it('does not fail when fail-on-unattested is false', async () => {
    mockMultilineInputs['artifact-paths'] = ['dist/*.tar.gz'];
    mockInputs['identity'] = '/tmp/bundle.json';
    mockInputs['fail-on-unattested'] = 'false';
    mockGlobFiles = ['/workspace/dist/bad.tar.gz'];

    mockVerifyArtifact.mockResolvedValue({
      file: '/workspace/dist/bad.tar.gz',
      valid: false,
      error: 'Digest mismatch',
    });

    const origWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = '/workspace';

    await runMain();

    process.env.GITHUB_WORKSPACE = origWorkspace;

    // Should NOT have a failure about artifacts
    const artifactFailures = mockFailed.filter(m => m.includes('artifact'));
    expect(artifactFailures).toHaveLength(0);
  });

  it('fails when no identity bundle provided for artifact verification', async () => {
    mockMultilineInputs['artifact-paths'] = ['dist/*.tar.gz'];
    // No identity bundle set — defaults to allowed-signers
    mockInputs['identity'] = '';
    mockGlobFiles = ['/workspace/dist/app.tar.gz'];

    await runMain();

    // Should hard-fail — silent skip would give false confidence
    const bundleErrors = mockFailed.filter(m => m.includes('identity bundle') || m.includes('Artifact verification requires'));
    expect(bundleErrors.length).toBeGreaterThan(0);
    expect(mockVerifyArtifact).not.toHaveBeenCalled();
  });

  it('handles partial success correctly', async () => {
    mockMultilineInputs['artifact-paths'] = ['dist/*'];
    mockInputs['identity'] = '/tmp/bundle.json';
    mockGlobFiles = ['/workspace/dist/good.tar.gz', '/workspace/dist/bad.tar.gz'];

    mockVerifyArtifact
      .mockResolvedValueOnce({
        file: '/workspace/dist/good.tar.gz',
        valid: true,
        issuer: 'did:auths:test',
      })
      .mockResolvedValueOnce({
        file: '/workspace/dist/bad.tar.gz',
        valid: false,
        error: 'No attestation found',
      });

    const origWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = '/workspace';

    await runMain();

    process.env.GITHUB_WORKSPACE = origWorkspace;

    expect(mockOutputs['artifacts-verified']).toBe('false');
    const results = JSON.parse(mockOutputs['artifact-results']);
    expect(results).toHaveLength(2);
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(false);
  });

  it('filters paths outside workspace', async () => {
    mockMultilineInputs['artifact-paths'] = ['**/*.tar.gz'];
    mockInputs['identity'] = '/tmp/bundle.json';
    mockGlobFiles = ['/workspace/dist/good.tar.gz', '/etc/passwd.tar.gz'];

    mockVerifyArtifact.mockResolvedValue({
      file: '/workspace/dist/good.tar.gz',
      valid: true,
    });

    const origWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = '/workspace';

    await runMain();

    process.env.GITHUB_WORKSPACE = origWorkspace;

    // Only the workspace file should be verified
    expect(mockVerifyArtifact).toHaveBeenCalledTimes(1);
    expect(mockWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Skipping path outside workspace')])
    );
  });

  it('deduplicates glob results', async () => {
    mockMultilineInputs['artifact-paths'] = ['dist/*.tar.gz', 'dist/app.tar.gz'];
    mockInputs['identity'] = '/tmp/bundle.json';
    // Glob returns the same file twice from two patterns
    mockGlobFiles = ['/workspace/dist/app.tar.gz', '/workspace/dist/app.tar.gz'];

    mockVerifyArtifact.mockResolvedValue({
      file: '/workspace/dist/app.tar.gz',
      valid: true,
    });

    const origWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = '/workspace';

    await runMain();

    process.env.GITHUB_WORKSPACE = origWorkspace;

    // Should only verify once despite duplicate
    expect(mockVerifyArtifact).toHaveBeenCalledTimes(1);
  });
});
