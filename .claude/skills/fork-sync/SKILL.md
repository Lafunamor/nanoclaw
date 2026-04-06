---
name: fork-sync
description: "Sync the Lafunamor fork with upstream (qwibitai/nanoclaw), rebase personal customizations on top, run security scan, and push. Also handles rebasing open PR branches. Triggers on 'sync fork', 'pull upstream', 'update from upstream', 'rebase fork', 'sync with upstream'."
---

# Fork Sync Skill

Syncs the Lafunamor fork of NanoClaw with upstream while preserving personal
customizations. Run this whenever upstream has new commits to merge in.

**Security rule:** NEVER push to any remote (origin or upstream) without running
`scripts/security-scan.sh` first. Block the push if findings are reported.

---

## Repository layout (always verify before acting)

```
remote: origin  → https://github.com/Lafunamor/nanoclaw.git  (our fork)
remote: upstream → https://github.com/qwibitai/nanoclaw.git  (source of truth)

branch: main         — upstream/main + personal customizations commit(s)
branch: feature/*    — clean branches based on upstream/main for PRs
```

Verify with:
```bash
git remote -v
git branch -vv
```

---

## Step 1 — Fetch upstream

```bash
git fetch upstream
```

Show what's new:
```bash
git log --oneline main..upstream/main
```

If there are 0 new commits, tell the user and stop — already up to date.

---

## Step 2 — Identify personal commits

Personal commits are commits on `main` that are NOT in `upstream/main`:

```bash
git log --oneline upstream/main..main
```

Record these commits (SHA, message). These will be rebased on top of the new upstream.

Typical structure: **one commit** titled something like
`chore: apply local customizations and personal integrations`.

If there are multiple personal commits, they will all be rebased in order.

---

## Step 3 — Rebase main onto upstream/main

```bash
git rebase upstream/main
```

This replays the personal commits on top of the new upstream HEAD.

**If rebase succeeds without conflicts:** go to Step 5.

**If rebase conflicts occur:** for each conflicted file:
1. Read the conflicted file (look for `<<<<<<<` markers)
2. Resolve: keep both changes where appropriate, or pick the upstream version if the personal change is no longer relevant
3. `git add <file>`
4. `git rebase --continue`

After resolving all conflicts, run:
```bash
npm run format:fix
npm run typecheck
```

Fix any TypeScript errors that arose from the merge before continuing.

---

## Step 4 — Verify the result

```bash
npm run typecheck
npm run build
```

If tests exist:
```bash
npm test
```

Fix any failures before proceeding.

---

## Step 5 — Security scan (MANDATORY before every push)

Always scan everything being pushed to the fork:

```bash
# Scan personal customization commits (delta above upstream/main)
./scripts/security-scan.sh --branch main
```

**If the scan reports findings:**
- Review each flagged line carefully
- If it's a false positive, assess whether the pattern needs tuning
- If it's real sensitive data: remove it from the commit, never push it
- Do NOT push until the scan is clean

**If the scan is clean:** proceed to Step 6.

---

## Step 6 — Push main to fork

```bash
git push origin main
```

If main diverged from origin/main (e.g. due to a previous force-reset workflow),
you may need:
```bash
git push --force-with-lease origin main
```

Use `--force-with-lease` (not `--force`) — it refuses if someone else has pushed
to the branch in the meantime.

---

## Step 7 — Rebase open PR branches onto new upstream/main

For each open PR branch (`feature/pid-lockfile`, `feature/whatsapp-resilience`,
`feature/cross-channel-messaging`, etc.):

```bash
# Check if the branch is still based cleanly on upstream/main
git log --oneline upstream/main..feature/<name>

# Rebase
git checkout feature/<name>
git rebase upstream/main
```

After rebasing each branch, run the security scan:
```bash
./scripts/security-scan.sh --branch feature/<name>
```

Then push (force-with-lease since history was rewritten):
```bash
git push --force-with-lease origin feature/<name>
```

GitHub will automatically update the open PR.

Return to main when done:
```bash
git checkout main
```

---

## Step 8 — Check open PRs for conflicts

After pushing rebased branches, check whether any PR now has merge conflicts
with upstream/main:

```bash
gh pr list --repo qwibitai/nanoclaw --author Lafunamor --state open
```

For each PR, check its status:
```bash
gh pr view <number> --repo qwibitai/nanoclaw
```

If upstream has merged something that supersedes a PR, consider closing it with
a comment explaining why.

---

## Security scan reference

The script `scripts/security-scan.sh` checks for:

| Check | What it catches |
|-------|----------------|
| API keys in assignments | `TOKEN=abc123`, `apiKey: "..."` |
| Vendor prefixes | `ghp_`, `sk-`, `xoxb-`, `AIza`, etc. |
| Private key material | PEM headers |
| Credentials in URLs | `://user:pass@host` |
| JWT tokens | `eyJ...` three-part tokens |
| .env-style secrets | `SECRET="hardcoded-value"` |
| Phone numbers (E.164) | `+49...`, `+1...` |
| Email addresses | `user@domain.com` |
| Private IPs | RFC-1918 ranges hardcoded |
| WhatsApp JIDs | Real-looking `1234567890@g.us` |
| SSH key data | SSH public key blobs |

False positive on a pattern you know is safe? Add `# nosec` inline on that line.

---

## Quick-reference: full sync in one pass

```bash
git fetch upstream
git log --oneline upstream/main..main          # see personal commits
git rebase upstream/main                       # rebase personal on top
npm run typecheck                              # verify
./scripts/security-scan.sh --branch main      # MANDATORY scan
git push --force-with-lease origin main       # push

# For each PR branch:
git checkout feature/<name>
git rebase upstream/main
./scripts/security-scan.sh --branch feature/<name>
git push --force-with-lease origin feature/<name>
git checkout main
```
