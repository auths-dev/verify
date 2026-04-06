import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as glob from '@actions/glob';
import { verifyCommits, verifyArtifact, VerifyOptions, VerificationResult, ArtifactVerificationResult, FailureType, ensureAuthsInstalled, runPreflightChecks } from './verifier';

export interface ResolvedIdentity {
  mode: 'allowed-signers' | 'identity-bundle';
  allowedSignersPath: string;
  identityBundlePath: string;
  tempFile?: string;
}

export function resolveIdentity(input: string): ResolvedIdentity {
  // Empty → default to allowed-signers file
  if (!input) {
    return {
      mode: 'allowed-signers',
      allowedSignersPath: '.auths/allowed_signers',
      identityBundlePath: '',
    };
  }

  const trimmed = input.trim();

  // Try parsing as JSON
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);

      // CiToken format (has version + verify_bundle)
      if (parsed.version && parsed.verify_bundle) {
        const bundlePath = path.join(os.tmpdir(), `auths-bundle-${Date.now()}.json`);
        fs.writeFileSync(bundlePath, JSON.stringify(parsed.verify_bundle));
        return { mode: 'identity-bundle', allowedSignersPath: '', identityBundlePath: bundlePath, tempFile: bundlePath };
      }

      // Raw identity bundle JSON (has identity_did)
      if (parsed.identity_did) {
        const bundlePath = path.join(os.tmpdir(), `auths-bundle-${Date.now()}.json`);
        fs.writeFileSync(bundlePath, trimmed);
        return { mode: 'identity-bundle', allowedSignersPath: '', identityBundlePath: bundlePath, tempFile: bundlePath };
      }

      throw new Error('JSON input does not look like an identity bundle or CI token');
    } catch (e) {
      if (e instanceof SyntaxError) {
        // Not valid JSON — fall through to file path
      } else {
        throw e;
      }
    }
  }

  // File path — check if it looks like an allowed-signers file or a bundle
  if (fs.existsSync(trimmed)) {
    try {
      const content = fs.readFileSync(trimmed, 'utf8').trim();
      if (content.startsWith('{')) {
        return { mode: 'identity-bundle', allowedSignersPath: '', identityBundlePath: trimmed };
      }
    } catch { /* not readable as text */ }
    // Default: treat as allowed-signers path
    return { mode: 'allowed-signers', allowedSignersPath: trimmed, identityBundlePath: '' };
  }

  // Doesn't exist as a file — assume it's inline JSON that failed to parse
  throw new Error(`Invalid identity input: not valid JSON and file not found at "${trimmed}"`);
}

async function run(): Promise<void> {
  let tempBundlePath = '';

  try {
    // Run pre-flight checks (shallow clone, ssh-keygen)
    await runPreflightChecks();

    // Get inputs
    const identityInput = core.getInput('token');
    let commitRange = core.getInput('commits');
    const failOnUnsigned = core.getInput('fail-on-unsigned') === 'true';
    const skipMergeCommits = core.getInput('skip-merge-commits') !== 'false';
    const artifactPathPatterns = core.getMultilineInput('files');
    const artifactAttestationDir = core.getInput('artifact-attestation-dir');
    const failOnUnattested = core.getInput('fail-on-unattested') !== 'false';

    // Resolve identity (auto-detects format)
    const resolved = resolveIdentity(identityInput);
    const resolvedBundlePath = resolved.identityBundlePath;
    tempBundlePath = resolved.tempFile || '';

    // Determine commit range if not provided
    if (!commitRange) {
      commitRange = await getDefaultCommitRange();
    }

    // Enforce bundle TTL before invoking CLI verification
    if (resolvedBundlePath) {
      const bundleContent = fs.readFileSync(resolvedBundlePath, 'utf8');
      const bundleJson = JSON.parse(bundleContent);
      const ageSeconds = (Date.now() - new Date(bundleJson.bundle_timestamp).getTime()) / 1000;
      if (ageSeconds > bundleJson.max_valid_for_secs) {
        core.error(
          `Bundle expired: ${Math.round(ageSeconds)}s old, max ${bundleJson.max_valid_for_secs}s. ` +
          `Refresh with: auths id export-bundle --alias <ALIAS> --output bundle.json --max-age-secs ${bundleJson.max_valid_for_secs}`
        );
        core.setFailed('Stale identity bundle — verification aborted');
        return;
      }
    }

    // Auto-detect verification mode
    const hasArtifactPaths = artifactPathPatterns.length > 0;
    const verifyCommitsMode = !(hasArtifactPaths && resolved.mode === 'identity-bundle' && !fs.existsSync('.auths/allowed_signers'));

    // Commit verification
    let allVerified = true;
    if (verifyCommitsMode) {
      core.info(`Verifying commits in range: ${commitRange}`);
      core.info(`Verification mode: ${resolved.mode}`);
      if (skipMergeCommits) {
        core.info('Merge commits will be skipped');
      }

      // Build options
      const options: VerifyOptions = {
        allowedSignersPath: resolved.allowedSignersPath,
        identityBundlePath: resolvedBundlePath,
        skipMergeCommits,
      };

      // Run verification
      const results = await verifyCommits(commitRange, options);

      // Calculate statistics
      const total = results.length;
      const skipped = results.filter(r => r.skipped).length;
      const passed = results.filter(r => r.valid && !r.skipped).length;
      const failed = results.filter(r => !r.valid).length;
      allVerified = failed === 0;

      // Set outputs
      core.setOutput('verified', allVerified.toString());
      core.setOutput('results', JSON.stringify(results));
      core.setOutput('total', total.toString());
      core.setOutput('passed', passed.toString());
      core.setOutput('failed', failed.toString());

      // Log results
      core.info('');
      core.info('=== Verification Results ===');
      for (const result of results) {
        if (result.skipped) {
          core.info(`\u2192 ${result.commit} - skipped (${result.skipReason})`);
        } else if (result.valid) {
          const signer = result.signer || 'N/A';
          core.info(`\u2713 ${result.commit} - signed by ${signer}`);
        } else {
          const error = result.error || 'unknown error';
          core.warning(`\u2717 ${result.commit} - ${error}`);
        }
      }

      core.info('');
      core.info(`Total: ${total}, Passed: ${passed}, Skipped: ${skipped}, Failed: ${failed}`);

      // Write GitHub Step Summary
      await writeStepSummary(results, passed, skipped, failed, total);

      // Per-failure-type guidance whenever any commit fails
      if (failed > 0) {
        const failedResults = results.filter(r => !r.valid);
        // Determine dominant failure type (most common)
        const typeCounts: Record<string, number> = {};
        for (const r of failedResults) {
          const t = r.failureType ?? 'error';
          typeCounts[t] = (typeCounts[t] ?? 0) + 1;
        }
        const dominantType = (Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0]) as FailureType;
        const firstFailed = failedResults[0];
        core.warning(fixMessageForType(dominantType, firstFailed.commit, failed));
      }

      // Opt-in PR comment
      const postPrComment = core.getInput('post-pr-comment') === 'true';
      if (postPrComment && github.context.eventName === 'pull_request') {
        const token = core.getInput('github-token', { required: true });
        const octokit = github.getOctokit(token);
        const prNumber = github.context.payload.pull_request!.number;
        const commentBody = buildPrCommentBody(results, passed, skipped, failed, total);
        await octokit.rest.issues.createComment({
          ...github.context.repo,
          issue_number: prNumber,
          body: commentBody,
        });
      }

      // Fail if required
      if (!allVerified && failOnUnsigned) {
        core.setFailed(`${failed} commit(s) failed signature verification`);
      }
    } else {
      // Skipping commit verification (artifact-only mode)
      core.info('Skipping commit verification (artifact-only mode)');
      core.setOutput('verified', '');
      core.setOutput('results', '[]');
      core.setOutput('total', '0');
      core.setOutput('passed', '0');
      core.setOutput('failed', '0');
    }

    // Artifact verification (when artifact-paths is provided)
    const artifactResults: ArtifactVerificationResult[] = [];
    if (hasArtifactPaths) {
      const version = core.getInput('auths-version') || '';
      const authsPath = await ensureAuthsInstalled(version);
      if (!authsPath) {
        throw new Error('Failed to find or install auths CLI for artifact verification');
      }

      // Require identity bundle for artifact verification
      if (!resolvedBundlePath) {
        throw new Error(
          'Artifact verification requires an identity bundle. ' +
          'The allowed-signers mode is not supported for artifact verification.'
        );
      } else {
        const patterns = artifactPathPatterns.join('\n');
        const globber = await glob.create(patterns, { followSymbolicLinks: false });
        let files = await globber.glob();

        // Workspace containment check
        const workspace = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
        files = files.filter(f => {
          const resolvedPath = path.resolve(f);
          if (!resolvedPath.startsWith(workspace + path.sep) && resolvedPath !== workspace) {
            core.warning(`Skipping path outside workspace: ${f}`);
            return false;
          }
          return true;
        });

        // Deduplicate
        files = [...new Set(files)];

        if (files.length === 0) {
          core.warning('files provided but no artifacts matched');
        }

        for (const file of files) {
          core.info(`Verifying artifact: ${path.basename(file)}`);
          const result = await verifyArtifact(
            authsPath, file, resolvedBundlePath,
            artifactAttestationDir || undefined
          );
          artifactResults.push(result);

          if (result.valid) {
            core.info(`\u2713 ${path.basename(file)} - verified${result.issuer ? ` (issuer: ${result.issuer})` : ''}`);
          } else {
            core.warning(`\u2717 ${path.basename(file)} - ${result.error || 'verification failed'}`);
          }
        }
      }
    }

    // Set artifact outputs
    const allArtifactsVerified = artifactResults.length > 0 && artifactResults.every(r => r.valid);
    core.setOutput('artifacts-verified', artifactResults.length > 0 ? allArtifactsVerified.toString() : '');
    core.setOutput('artifact-results', JSON.stringify(artifactResults));

    // Write artifact step summary
    if (artifactResults.length > 0) {
      await writeArtifactStepSummary(artifactResults);
    }

    // Fail on unattested artifacts
    if (failOnUnattested && artifactResults.some(r => !r.valid)) {
      const artifactFailCount = artifactResults.filter(r => !r.valid).length;
      core.setFailed(`${artifactFailCount} artifact(s) failed attestation verification`);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unexpected error occurred');
    }
  } finally {
    // Clean up temp bundle file
    if (tempBundlePath && fs.existsSync(tempBundlePath)) {
      fs.unlinkSync(tempBundlePath);
    }
  }
}

/**
 * Return a human-readable fix message for the dominant failure type.
 */
function fixMessageForType(type: FailureType, commit: string, failedCount: number): string {
  const plural = failedCount > 1;
  const amendCmd = plural
    ? `git rebase HEAD~${failedCount} --exec 'git commit --amend --no-edit -S'\ngit push --force-with-lease`
    : `git commit --amend --no-edit -S\ngit push --force-with-lease`;

  switch (type) {
    case 'unsigned':
      return [
        `Commit ${commit.slice(0, 8)} is not signed. To sign future commits:`,
        ``,
        `1. Install auths:`,
        `   macOS:  brew install auths`,
        `   Linux:  See https://github.com/auths-dev/auths/releases/latest`,
        ``,
        `2. Set up signing:`,
        `   auths init`,
        `   auths git setup`,
        ``,
        `3. Re-sign and push:`,
        `   ${amendCmd}`,
        ``,
        `Quickstart: https://github.com/auths-dev/auths#quickstart`,
      ].join('\n');

    case 'unknown_signer':
      return [
        `Commit ${commit.slice(0, 8)} is signed but the key is not in the allowed signers.`,
        `Ask a maintainer to add your public key, or check your allowed-signers file.`,
        ``,
        `Export your public key:  auths key export --format pub`,
      ].join('\n');

    case 'invalid_signature':
      return `Commit ${commit.slice(0, 8)} has a corrupted or invalid signature. Re-sign it:\n  ${amendCmd}`;

    default:
      return `Commit ${commit.slice(0, 8)} failed verification. See details above.`;
  }
}

/**
 * Write a Markdown summary to $GITHUB_STEP_SUMMARY
 */
export function buildSummaryMarkdown(
  results: VerificationResult[],
  passed: number,
  skipped: number,
  failed: number,
  total: number
): string {
  const lines: string[] = [];
  lines.push('## Auths Commit Verification');
  lines.push('');
  lines.push('| Commit | Status | Details |');
  lines.push('|--------|--------|---------|');

  for (const result of results) {
    const shortSha = `\`${result.commit.substring(0, 8)}\``;

    if (result.skipped) {
      lines.push(`| ${shortSha} | Skipped | ${result.skipReason || 'N/A'} |`);
    } else if (result.valid) {
      const signer = result.signer || 'verified';
      lines.push(`| ${shortSha} | \u2705 Verified | Signed by ${signer} |`);
    } else {
      const error = result.error || 'No signature found';
      lines.push(`| ${shortSha} | \u274c Failed | ${error} |`);
    }
  }

  lines.push('');
  const resultEmoji = failed === 0 ? '\u2705' : '\u274c';
  let resultLine = `**Result:** ${resultEmoji} ${passed}/${total} commits verified`;
  if (skipped > 0) {
    resultLine += ` (${skipped} skipped)`;
  }
  lines.push(resultLine);
  lines.push('');

  if (failed > 0) {
    const failedResults = results.filter(r => !r.valid);
    const typeCounts: Record<string, number> = {};
    for (const r of failedResults) {
      const t = r.failureType ?? 'error';
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    }
    const dominantType = (Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0]) as FailureType;
    const firstFailed = failedResults[0];
    const plural = failed > 1;
    const amendCmd = plural
      ? `git rebase HEAD~${failed} --exec 'git commit --amend --no-edit -S'\ngit push --force-with-lease`
      : `git commit --amend --no-edit -S\ngit push --force-with-lease`;

    lines.push('---');
    lines.push('### How to fix');
    lines.push('');

    switch (dominantType) {
      case 'unsigned':
        lines.push(`Commit \`${firstFailed.commit.slice(0, 8)}\` is not signed. To sign future commits:`);
        lines.push('');
        lines.push('**1. Install auths**');
        lines.push('');
        lines.push('macOS: `brew install auths`');
        lines.push('Linux: Download from [releases](https://github.com/auths-dev/auths/releases/latest)');
        lines.push('');
        lines.push('**2. Set up signing**');
        lines.push('');
        lines.push('```bash');
        lines.push('auths init');
        lines.push('auths git setup');
        lines.push('```');
        lines.push('');
        lines.push('**3. Re-sign and push**');
        lines.push('');
        lines.push('```bash');
        lines.push(amendCmd);
        lines.push('```');
        lines.push('');
        lines.push('[Quickstart →](https://github.com/auths-dev/auths#quickstart)');
        break;
      case 'unknown_signer':
        lines.push(`Commit \`${firstFailed.commit.slice(0, 8)}\` is signed but the key is not in the allowed signers.`);
        lines.push('Ask a maintainer to add your public key, or check your allowed-signers file.');
        lines.push('');
        lines.push('Export your public key:');
        lines.push('```');
        lines.push('auths key export --format pub');
        lines.push('```');
        break;
      case 'invalid_signature':
        lines.push(`Commit \`${firstFailed.commit.slice(0, 8)}\` has a corrupted or invalid signature. Re-sign it:`);
        lines.push('```');
        lines.push(amendCmd);
        lines.push('```');
        break;
      default:
        lines.push(`Commit \`${firstFailed.commit.slice(0, 8)}\` failed verification. See the Actions log for details.`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function writeStepSummary(
  results: VerificationResult[],
  passed: number,
  skipped: number,
  failed: number,
  total: number
): Promise<void> {
  if (results.length === 0) {
    return;
  }
  const summary = buildSummaryMarkdown(results, passed, skipped, failed, total);
  await core.summary.addRaw(summary).write();
}

function buildPrCommentBody(
  results: VerificationResult[],
  passed: number,
  skipped: number,
  failed: number,
  total: number
): string {
  return buildSummaryMarkdown(results, passed, skipped, failed, total);
}

/**
 * Determine the default commit range based on the GitHub event context.
 */
export async function getDefaultCommitRange(): Promise<string> {
  const context = github.context;

  if (context.eventName === 'pull_request') {
    const pr = context.payload.pull_request;
    if (pr) {
      return `${pr.base.sha}..${pr.head.sha}`;
    }
  }

  if (context.eventName === 'push') {
    const before = context.payload.before;
    const after = context.payload.after;
    if (before && after) {
      if (before === '0000000000000000000000000000000000000000') {
        let stdout = '';
        try {
          await exec.exec('git', ['rev-list', after, '--not', '--remotes'], {
            listeners: {
              stdout: (data: Buffer) => {
                stdout += data.toString();
              }
            },
            ignoreReturnCode: true
          });
          const commits = stdout.trim().split('\n').filter(l => l.length > 0);
          if (commits.length > 0) {
            const oldest = commits[commits.length - 1];
            return `${oldest}^..${after}`;
          }
        } catch {
          // Fall through to single commit
        }
        return `${after}^..${after}`;
      }
      return `${before}..${after}`;
    }
  }

  return 'HEAD^..HEAD';
}

function buildArtifactSummaryMarkdown(results: ArtifactVerificationResult[]): string {
  const lines: string[] = [];
  const passed = results.filter(r => r.valid).length;
  const failed = results.filter(r => !r.valid).length;

  lines.push('## Auths Artifact Verification');
  lines.push('');
  lines.push('| Artifact | Status | Details |');
  lines.push('|----------|--------|---------|');

  for (const result of results) {
    const name = path.basename(result.file);
    if (result.valid) {
      const issuer = result.issuer || 'verified';
      lines.push(`| \`${name}\` | \u2705 Verified | Signed by ${issuer} |`);
    } else {
      const error = result.error || 'Verification failed';
      lines.push(`| \`${name}\` | \u274c Failed | ${error} |`);
    }
  }

  lines.push('');
  const emoji = failed === 0 ? '\u2705' : '\u274c';
  lines.push(`**Result:** ${emoji} ${passed}/${results.length} artifacts verified`);
  lines.push('');

  return lines.join('\n');
}

async function writeArtifactStepSummary(results: ArtifactVerificationResult[]): Promise<void> {
  if (results.length === 0) return;
  const summary = buildArtifactSummaryMarkdown(results);
  await core.summary.addRaw(summary).write();
}

run();
