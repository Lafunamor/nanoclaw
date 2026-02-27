#!/usr/bin/env bash
# security-scan.sh — scan a git diff for sensitive data before pushing
#
# Usage:
#   ./scripts/security-scan.sh                     # scan staged changes
#   ./scripts/security-scan.sh --branch BRANCH     # scan branch vs upstream/main
#   ./scripts/security-scan.sh --staged            # scan staged changes (default)
#   ./scripts/security-scan.sh --working           # scan all working tree changes
#   ./scripts/security-scan.sh --commit SHA        # scan a single commit
#
# Exit codes: 0 = clean, 1 = findings (block the push), 2 = usage error

set -euo pipefail

MODE="staged"
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)   MODE="branch";  TARGET="$2"; shift 2 ;;
    --staged)   MODE="staged";  shift ;;
    --working)  MODE="working"; shift ;;
    --commit)   MODE="commit";  TARGET="$2"; shift 2 ;;
    --help|-h)
      sed -n '/^# /p' "$0" | sed 's/^# //'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

# ── Produce the diff to scan ──────────────────────────────────────────────────
case "$MODE" in
  staged)
    DIFF=$(git diff --staged)
    DESCRIPTION="staged changes"
    ;;
  working)
    DIFF=$(git diff HEAD)
    DESCRIPTION="working tree changes"
    ;;
  branch)
    if [[ -z "$TARGET" ]]; then
      echo "ERROR: --branch requires a branch name" >&2; exit 2
    fi
    DIFF=$(git diff "upstream/main...${TARGET}")
    DESCRIPTION="branch '${TARGET}' vs upstream/main"
    ;;
  commit)
    if [[ -z "$TARGET" ]]; then
      echo "ERROR: --commit requires a SHA" >&2; exit 2
    fi
    DIFF=$(git show "$TARGET")
    DESCRIPTION="commit ${TARGET}"
    ;;
esac

if [[ -z "$DIFF" ]]; then
  echo "✓ Security scan: nothing to scan in ${DESCRIPTION}"
  exit 0
fi

echo "Security scan: checking ${DESCRIPTION} for sensitive data..."
echo ""

FINDINGS=0

# Helper: grep the diff for a pattern; print any + lines that match
# Lines containing '# nosec' or '// nosec' are always excluded.
check_pattern() {
  local label="$1"
  local pattern="$2"
  # Only scan added lines (lines starting with +, excluding the +++ header)
  local matches
  matches=$(echo "$DIFF" | grep -n '^+' | grep -v '^[0-9]*:+++' | grep -v 'nosec' | grep -iE "$pattern" || true)
  if [[ -n "$matches" ]]; then
    echo "  FAIL  [$label]"
    echo "$matches" | head -10 | sed 's/^/         /'
    FINDINGS=$((FINDINGS + 1))
  else
    echo "  ok    [$label]"
  fi
}

# ── Patterns ──────────────────────────────────────────────────────────────────

# Generic high-entropy secrets in assignments
check_pattern "API keys / tokens in assignments" \
  '(api[_-]?key|api[_-]?secret|auth[_-]?token|access[_-]?token|secret[_-]?key|client[_-]?secret)\s*[:=]\s*['"'"'"`][^'"'"'"`$\{]{8,}'

# Known vendor key prefixes
check_pattern "Known secret prefixes (ghp/sk-/xoxb/AIza/etc.)" \
  '(ghp_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}|xoxb-[0-9]+-[0-9]+-[A-Za-z0-9]+|xoxp-[0-9]+-[0-9]+-[0-9]+-[A-Za-z0-9]+|AIza[0-9A-Za-z\-_]{35}|AAAA[A-Za-z0-9_\-]{7}:|ya29\.[0-9A-Za-z\-_]+)'

# Private key headers
check_pattern "Private key material" \
  'BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY'

# Password in URL
check_pattern "Credentials in URLs" \
  '://[^/\s]+:[^@/\s]+@'

# JWT tokens
check_pattern "JWT tokens" \
  'eyJ[A-Za-z0-9+/]{10,}={0,2}\.[A-Za-z0-9+/]{10,}={0,2}\.[A-Za-z0-9+/\-_]{10,}'

# .env-style bare secrets (TOKEN=value, SECRET=value — not referencing env vars)
check_pattern ".env-style hardcoded secrets" \
  '^[+][^+]*(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET)\s*=\s*['"'"'"`]?[A-Za-z0-9+/\-_]{12,}'

# Personal phone numbers (E.164 format, not test numbers)
check_pattern "Phone numbers (E.164)" \
  '\+[1-9][0-9]{6,14}[^0-9]'

# Personal email addresses (rudimentary — catches real-looking addresses)
# The check_pattern helper is used with a pre-filtered diff that strips git SSH URL lines.
DIFF_NO_GIT_SSH=$(echo "$DIFF" | grep -v 'git@github\|git@gitlab\|git@bitbucket\|git@codeberg')
DIFF_ORIG=$DIFF
DIFF=$DIFF_NO_GIT_SSH
check_pattern "Email addresses" \
  '\b[A-Za-z0-9._%+\-]{3,}@[A-Za-z0-9.\-]{3,}\.[A-Za-z]{2,}\b'
DIFF=$DIFF_ORIG

# Hardcoded private/RFC-1918 IP addresses
check_pattern "Hardcoded private IP addresses" \
  '(192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]{1,3}\.[0-9]{1,3})'

# WhatsApp JIDs that look real (long numeric prefix before @g.us or @s.whatsapp.net)
check_pattern "Real-looking WhatsApp JIDs" \
  '[0-9]{10,}@(g\.us|s\.whatsapp\.net)'

# SSH host entries or known_hosts-style lines
check_pattern "SSH keys / known_hosts data" \
  '(ssh-(rsa|ed25519|ecdsa|dss) AAAA|ecdsa-sha2-nistp[0-9]+ AAAA)'

echo ""

# ── Result ────────────────────────────────────────────────────────────────────
if [[ "$FINDINGS" -gt 0 ]]; then
  echo "BLOCKED — $FINDINGS check(s) flagged. Review the lines above before pushing."
  echo ""
  echo "False positive? Add an inline comment '# nosec' on that line,"
  echo "or open scripts/security-scan.sh to tune the pattern."
  exit 1
else
  echo "✓ All checks passed — no sensitive data detected in ${DESCRIPTION}"
  exit 0
fi
