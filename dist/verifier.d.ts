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
export declare function classifyError(error: string): FailureType;
export interface VerifyOptions {
    allowedSignersPath: string;
    identityBundlePath: string;
    skipMergeCommits: boolean;
}
/**
 * Run pre-flight checks before verification.
 * Detects common issues and provides actionable error messages.
 */
export declare function runPreflightChecks(): Promise<void>;
/**
 * Verify commits in the given range using auths verify
 */
export declare function verifyCommits(commitRange: string, options: VerifyOptions): Promise<VerificationResult[]>;
/**
 * Classify an artifact verification error into a structured failure type.
 */
export declare function classifyArtifactError(error: string): FailureType;
/**
 * Verify a single artifact file using `auths artifact verify`.
 */
export declare function verifyArtifact(authsPath: string, filePath: string, identityBundlePath: string, attestationDir?: string): Promise<ArtifactVerificationResult>;
/**
 * Get list of commits in a range, optionally excluding merge commits
 */
export declare function getCommitsInRange(commitRange: string, skipMerges?: boolean): Promise<string[]>;
/**
 * Ensure auths CLI is available, downloading if necessary.
 * @param version - Specific version to use (e.g., "0.5.0"), or empty for latest
 */
export declare function ensureAuthsInstalled(version: string): Promise<string | null>;
/**
 * Verify SHA256 checksum of a downloaded file against a .sha256 file from the release.
 * Warns but continues if checksum file is not available (older releases).
 * Throws if checksum file exists but doesn't match (potential tampering).
 */
export declare function verifyChecksum(downloadUrl: string, filePath: string): Promise<void>;
/**
 * Get the platform-specific binary name
 */
export declare function getBinaryName(): string;
/**
 * Get download URL for auths binary.
 * @param version - Specific version (e.g., "0.5.0"), or empty for latest
 */
export declare function getAuthsDownloadUrl(version: string): string | null;
