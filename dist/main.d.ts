export interface ResolvedIdentity {
    mode: 'allowed-signers' | 'identity-bundle';
    allowedSignersPath: string;
    identityBundlePath: string;
    tempFile?: string;
}
export declare function resolveIdentity(input: string): ResolvedIdentity;
/**
 * Determine the default commit range based on the GitHub event context.
 */
export declare function getDefaultCommitRange(): Promise<string>;
