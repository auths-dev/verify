#!/usr/bin/env bash
#
# CI Release Signing Setup (One-Time)
#
# Creates a limited-capability device key for GitHub Actions to sign
# release artifacts. Your root identity stays on your machine.
#
# Prerequisites:
#   - auths CLI installed and initialized (auths init)
#   - gh CLI installed and authenticated (gh auth login)
#
# Usage:
#   bash scripts/ci-setup.sh          # interactive setup
#   just ci-setup                     # same thing via justfile
#
set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
BOLD='\033[1m'
DIM='\033[2m'
YELLOW='\033[1;33m'
RESET='\033[0m'

echo ""
echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║${RESET}${BOLD}           CI Release Signing Setup (One-Time)              ${RESET}${CYAN}║${RESET}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "This creates a limited-capability device for GitHub Actions to sign"
echo "release artifacts. Your root identity stays on your machine."
echo ""

# --- Step 1: Verify identity exists ---
if ! auths status > /dev/null 2>&1; then
    echo "ERROR: No auths identity found. Run 'auths init' first." >&2
    exit 1
fi

# --- Step 2: Read identity info ---
ID_OUTPUT=$(auths id show)
IDENTITY_DID=$(echo "$ID_OUTPUT" | grep "Controller DID:" | awk '{print $3}')
if [ -z "$IDENTITY_DID" ]; then
    echo "ERROR: Could not parse Controller DID from 'auths id show'" >&2
    exit 1
fi

KEY_OUTPUT=$(auths key list)
IDENTITY_KEY_ALIAS=$(echo "$KEY_OUTPUT" | grep '^-' | head -1 | awk '{print $2}')
if [ -z "$IDENTITY_KEY_ALIAS" ]; then
    echo "ERROR: Could not parse key alias from 'auths key list'" >&2
    exit 1
fi

echo -e "${BOLD}Identity:${RESET}  ${CYAN}${IDENTITY_DID}${RESET}"
echo -e "${BOLD}Key alias:${RESET} ${CYAN}${IDENTITY_KEY_ALIAS}${RESET}"
echo ""

# --- Step 3: Check for existing CI device key ---
REUSE=0
if echo "$KEY_OUTPUT" | grep -q "ci-release-device"; then
    echo -e "${DIM}Found existing ci-release-device key — will reuse it.${RESET}"
    REUSE=1
fi

# --- Step 4: Prompt for passphrase ---
echo -e "${BOLD}Choose a passphrase for the CI device key.${RESET}"
echo -e "${DIM}This will be stored as AUTHS_CI_PASSPHRASE in GitHub Secrets.${RESET}"
echo ""

read -rsp "CI device passphrase: " CI_PASS
echo ""
read -rsp "Confirm passphrase: " CI_PASS_CONFIRM
echo ""

if [ "$CI_PASS" != "$CI_PASS_CONFIRM" ]; then
    echo "ERROR: Passphrases do not match" >&2
    exit 1
fi

# --- Step 5: Generate seed + import key (or reuse existing) ---
TMPDIR_WORK=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK"' EXIT

if [ "$REUSE" -eq 0 ]; then
    echo ""
    echo -e "${DIM}Generating CI device key...${RESET}"

    # Generate a fresh 32-byte Ed25519 seed
    SEED_PATH="$TMPDIR_WORK/ci-device-seed.bin"
    dd if=/dev/urandom of="$SEED_PATH" bs=32 count=1 2>/dev/null
    chmod 600 "$SEED_PATH"

    # Import the seed into platform keychain
    echo -e "${DIM}Importing key into platform keychain:${RESET}"
    auths key import \
        --alias ci-release-device \
        --seed-file "$SEED_PATH" \
        --controller-did "$IDENTITY_DID"

    echo -e "${GREEN}✓${RESET} CI device key imported into platform keychain"
fi

# Create CI file keychain
KEYCHAIN_PATH="$TMPDIR_WORK/ci-keychain.enc"
if [ "$REUSE" -eq 0 ]; then
    echo -e "${DIM}Creating CI file keychain...${RESET}"
else
    echo -e "${DIM}Reusing existing ci-release-device key — regenerating CI file keychain...${RESET}"
fi

AUTHS_PASSPHRASE="$CI_PASS" auths key copy-backend \
    --alias ci-release-device \
    --dst-backend file \
    --dst-file "$KEYCHAIN_PATH"

KEYCHAIN_B64=$(base64 < "$KEYCHAIN_PATH" | tr -d '\n')
echo -e "${GREEN}✓${RESET} CI file keychain created"

# --- Step 6: Derive device DID ---
DEVICE_PUB=$(auths key export \
    --alias ci-release-device \
    --passphrase "$CI_PASS" \
    --format pub)

DEVICE_DID=$(auths debug util pubkey-to-did "$DEVICE_PUB")
echo -e "${GREEN}✓${RESET} Device DID: ${CYAN}${DEVICE_DID}${RESET}"

# --- Step 7: Link device (if not already linked) ---
DEVICES_OUTPUT=$(auths device list 2>/dev/null || echo "")
if echo "$DEVICES_OUTPUT" | grep -q "$DEVICE_DID"; then
    echo -e "${GREEN}✓${RESET} CI device already linked — skipping"
else
    echo ""
    echo -e "${DIM}Linking CI device to identity...${RESET}"
    AUTHS_PASSPHRASE="$CI_PASS" auths device link \
        --key "$IDENTITY_KEY_ALIAS" \
        --device-key ci-release-device \
        --device-did "$DEVICE_DID" \
        --note "GitHub Actions release signer" \
        --capabilities sign_release
    echo -e "${GREEN}✓${RESET} CI device linked"
fi

# --- Step 8: Package identity repo (for release signing) ---
AUTHS_DIR="${HOME}/.auths"
echo -e "${DIM}Packaging identity repo...${RESET}"

if ! git -C "$AUTHS_DIR" rev-parse --git-dir > /dev/null 2>&1; then
    echo "ERROR: ~/.auths does not appear to be a git repository. Run 'auths init' first." >&2
    exit 1
fi
echo -e "  ${GREEN}✓${RESET} ~/.auths is a valid git repo"

# Build tar.gz of ~/.auths, excluding *.sock files
BUNDLE_PATH="$TMPDIR_WORK/identity-bundle.tar.gz"
tar -czf "$BUNDLE_PATH" \
    --exclude='*.sock' \
    -C "$(dirname "$AUTHS_DIR")" \
    "$(basename "$AUTHS_DIR")"

IDENTITY_BUNDLE_B64=$(base64 < "$BUNDLE_PATH" | tr -d '\n')

# --- Step 8b: Export identity bundle JSON (for CI artifact verification) ---
echo -e "${DIM}Exporting identity bundle JSON (1-year TTL)...${RESET}"
BUNDLE_JSON_PATH="$TMPDIR_WORK/identity-bundle.json"
auths id export-bundle \
    --alias ci-release-device \
    --output "$BUNDLE_JSON_PATH" \
    --max-age-secs 31536000

IDENTITY_BUNDLE_JSON=$(cat "$BUNDLE_JSON_PATH")
echo -e "${GREEN}✓${RESET} Identity bundle JSON exported (expires in 1 year)"

# --- Step 9: Set GitHub secrets ---
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  Setting GitHub Secrets:${RESET}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

REPO=$(git remote get-url origin | sed 's/.*github\.com[:/]//' | sed 's/\.git$//')
if [ -z "$REPO" ] || ! echo "$REPO" | grep -q '/'; then
    echo "ERROR: Could not extract owner/repo from git remote URL" >&2
    exit 1
fi

GH_OK=1

if ! gh auth status > /dev/null 2>&1; then
    GH_OK=0
fi

if [ "$GH_OK" -eq 1 ]; then
    echo -e "${DIM}Setting secrets via gh CLI...${RESET}"

    echo -n "$CI_PASS" | gh secret set AUTHS_CI_PASSPHRASE --repo "$REPO" || GH_OK=0
    echo -n "$KEYCHAIN_B64" | gh secret set AUTHS_CI_KEYCHAIN --repo "$REPO" || GH_OK=0
    echo -n "$IDENTITY_BUNDLE_B64" | gh secret set AUTHS_CI_IDENTITY_BUNDLE --repo "$REPO" || GH_OK=0
    echo -n "$IDENTITY_BUNDLE_JSON" | gh secret set AUTHS_CI_IDENTITY_BUNDLE_JSON --repo "$REPO" || GH_OK=0
fi

if [ "$GH_OK" -eq 1 ]; then
    echo -e "${GREEN}✓${RESET} All 4 secrets set on ${CYAN}${REPO}${RESET}"
else
    echo -e "${YELLOW}Could not set secrets automatically.${RESET}"
    echo -e "${DIM}Try: gh auth login then re-run, or add manually:${RESET}"
    echo -e "${DIM}  Repository → Settings → Secrets → Actions → New secret${RESET}"
    echo ""
    echo -e "${BOLD}AUTHS_CI_PASSPHRASE${RESET}"
    echo "$CI_PASS"
    echo ""
    echo -e "${BOLD}AUTHS_CI_KEYCHAIN${RESET}"
    echo "$KEYCHAIN_B64"
    echo ""
    echo -e "${BOLD}AUTHS_CI_IDENTITY_BUNDLE${RESET}"
    echo "$IDENTITY_BUNDLE_B64"
    echo ""
    echo -e "${BOLD}AUTHS_CI_IDENTITY_BUNDLE_JSON${RESET}"
    echo "$IDENTITY_BUNDLE_JSON"
fi

echo ""
echo -e "${BOLD}To revoke CI access at any time:${RESET}"
echo -e "  ${CYAN}auths device revoke --device-did ${DEVICE_DID} --key ${IDENTITY_KEY_ALIAS}${RESET}"
echo ""
