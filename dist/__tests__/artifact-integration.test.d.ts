/**
 * Integration tests for artifact verification in main.ts run() flow.
 *
 * Since run() is called at module load time, we use jest.isolateModules
 * to re-import the module with different mock configurations per test.
 */
declare let mockInputs: Record<string, string>;
declare let mockMultilineInputs: Record<string, string[]>;
declare let mockOutputs: Record<string, string>;
declare let mockFailed: string[];
declare let mockWarnings: string[];
declare let mockGlobFiles: string[];
declare let mockArtifactResults: any[];
declare let mockVerifyCommitsResult: any[];
declare const mockVerifyCommits: jest.Mock<any, any, any>;
declare const mockEnsureAuthsInstalled: jest.Mock<any, any, any>;
declare const mockVerifyArtifact: jest.Mock<any, any, any>;
declare const mockRunPreflightChecks: jest.Mock<any, any, any>;
declare function resetMockState(): void;
declare function runMain(): Promise<void>;
