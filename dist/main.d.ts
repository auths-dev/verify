import { VerificationResult } from './verifier';
export interface ResolvedIdentity {
    mode: 'allowed-signers' | 'identity-bundle';
    allowedSignersPath: string;
    identityBundlePath: string;
    tempFile?: string;
}
export declare function resolveIdentity(input: string): ResolvedIdentity;
/**
 * Write a Markdown summary to $GITHUB_STEP_SUMMARY
 */
export declare function buildSummaryMarkdown(results: VerificationResult[], passed: number, skipped: number, failed: number, total: number): string;
/**
 * Determine the default commit range based on the GitHub event context.
 */
export declare function getDefaultCommitRange(): Promise<string>;
