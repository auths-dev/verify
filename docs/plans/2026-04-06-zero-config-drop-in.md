# Zero-Config Drop-In (GitHub Action UX) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the verify action usable by first-time adopters with no configuration, by improving the step summary setup guide, README one-liner, badge, and Marketplace metadata.

**Architecture:** All four tasks are isolated changes — two TypeScript edits in `src/main.ts`, two Markdown edits in `README.md`, and one YAML edit in `action.yml`. No new files needed.

**Tech Stack:** TypeScript (`@actions/core`), Jest, GitHub Actions YAML, Markdown.

---

### Task 1: Improve unsigned-commit step summary with full setup guide

The `unsigned` failure path in `buildSummaryMarkdown` and `fixMessageForType` (both in `src/main.ts`) currently tells users to `brew install auths` and then re-sign. First-time users also need `auths init` and `auths git setup` before they can sign anything. Add those steps.

**Files:**
- Modify: `src/main.ts` — `buildSummaryMarkdown` (lines ~396-409) and `fixMessageForType` (lines ~310-321)
- Test: `src/__tests__/main.test.ts`

**Step 1: Write the failing test**

Add to `src/__tests__/main.test.ts` (import `buildSummaryMarkdown` — it is not currently exported, so first export it):

```typescript
// In main.ts, change:
//   function buildSummaryMarkdown(
// to:
//   export function buildSummaryMarkdown(

import { buildSummaryMarkdown } from '../main';

describe('buildSummaryMarkdown - unsigned failure', () => {
  it('includes auths init and auths git setup in the how-to-fix section', () => {
    const results = [{
      commit: 'abc12345def67890',
      valid: false,
      skipped: false,
      failureType: 'unsigned' as const,
      error: 'No signature found',
      signer: undefined,
      skipReason: undefined,
    }];
    const md = buildSummaryMarkdown(results, 0, 0, 1, 1);
    expect(md).toContain('auths init');
    expect(md).toContain('auths git setup');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/bordumb/workspace/repositories/auths-base/verify
npm test -- --testPathPattern="main.test" 2>&1 | tail -30
```

Expected: FAIL — `buildSummaryMarkdown` is not exported / test missing `auths init`.

**Step 3: Export `buildSummaryMarkdown` from `src/main.ts`**

Change line 342 in `src/main.ts`:
```typescript
// Before:
function buildSummaryMarkdown(
// After:
export function buildSummaryMarkdown(
```

**Step 4: Update the `unsigned` case in `buildSummaryMarkdown` (~line 400)**

Replace the existing `unsigned` case block inside `buildSummaryMarkdown` with:

```typescript
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
```

**Step 5: Update the `unsigned` case in `fixMessageForType` (~line 310)**

Replace the existing `unsigned` case return value in `fixMessageForType`:

```typescript
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
```

**Step 6: Run tests to verify they pass**

```bash
npm test -- --testPathPattern="main.test" 2>&1 | tail -30
```

Expected: PASS.

**Step 7: Run all tests to confirm no regressions**

```bash
npm test 2>&1 | tail -20
```

Expected: All tests pass.

**Step 8: Commit**

```bash
git add src/main.ts src/__tests__/main.test.ts
git commit -m "feat: expand unsigned-commit step summary with full auths setup guide"
```

---

### Task 2: Add README one-liner install block

The README already has a Quickstart section (line 7) but the epic wants a dedicated, copy-pasteable workflow YAML for the most common case: "verify all PR commits."

**Files:**
- Modify: `README.md`

**Step 1: Add the one-liner workflow block**

Insert the following after the existing Quickstart section (after line 14 in README.md, before `## Features`):

```markdown
## One-Liner Install

Add this file to your repo to start enforcing signed commits on every PR:

```yaml
# .github/workflows/verify.yml
name: Verify Commits
on: [pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: auths-dev/verify@v1
        with:
          fail-on-unsigned: true
```

That's it. No token or configuration needed — the action reads `.auths/allowed_signers` automatically.
```

**Step 2: Verify the markdown renders correctly (manual spot-check)**

Open `README.md` and confirm the YAML block is properly fenced and the surrounding text reads naturally.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add one-liner install workflow block to README"
```

---

### Task 3: Add "Verified with Auths" badge to README

**Files:**
- Modify: `README.md` (top of file, line 1)

**Step 1: Add badge after the title**

Insert after `# Auths Verify Action` (line 1):

```markdown
[![Verified with Auths](https://img.shields.io/badge/Verified%20with-Auths-4B9CD3?logo=github&logoColor=white)](https://github.com/auths-dev/verify)
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add Verified with Auths badge to README"
```

---

### Task 4: Update action.yml for GitHub Marketplace

The `action.yml` already has basic branding. For Marketplace publication it needs a richer description with supply-chain framing, a category hint, and cleaner author/branding.

**Files:**
- Modify: `action.yml`

**Step 1: Update the `description` field in `action.yml`**

Replace the current description (line 3):
```yaml
description: 'Verify commit signatures and artifact attestations using Auths identity keys'
```
With:
```yaml
description: >
  Protect your supply chain by enforcing cryptographic commit signatures on every PR.
  Verifies that every commit is signed by an authorized developer using Auths identity keys.
  Zero configuration needed — reads .auths/allowed_signers automatically.
  Classifies failures (unsigned, unknown key, corrupted signature) with copy-pasteable fix commands
  and posts a GitHub Step Summary with a "How to fix" guide.
```

**Step 2: Update the `author` field**

```yaml
author: 'auths-dev'
```

**Step 3: Verify branding is Marketplace-compatible**

The existing branding block is already correct:
```yaml
branding:
  icon: 'shield'
  color: 'green'
```
No change needed — `shield` + `green` maps to the Security category aesthetic on Marketplace.

**Step 4: Commit**

```bash
git add action.yml
git commit -m "feat: update action.yml description for GitHub Marketplace — supply-chain framing"
```

---

## Final Verification

```bash
npm test 2>&1 | tail -20
```

All tests should pass. Then build:

```bash
npm run build 2>&1 | tail -10
```

No build errors expected.
