Merge the current branch's PR to `main`, let Railway auto-deploy, stop this branch's preview, clean up.
Return the PR + live URL.

**Trigger phrases**: `/ship`, "ship it," "this is ready," "merge it," "ready to go."

The goal: make shipping one step. Jamie works on a worktree branch, tests with `/preview`, then `/ship`. Don't
make him think about PRs, tokens, or worktrees.

## GitHub auth
The default `gh` login already sees this repo (`rubyshines/rubies-automation`) — verify once with
`gh repo view rubyshines/rubies-automation --json nameWithOwner`. If that ever fails (wrong default login),
fall back to a token from `.env`: `GH_TOKEN="$(grep -E '^(GH_TOKEN|GITHUB_TOKEN)=' .env | head -1 | cut -d= -f2-)" gh ...`.
(The git remote uses the SSH host alias `github.com-rubies`; `gh` uses its own HTTPS auth, so plain `gh` is fine.)

## Preconditions
1. On a non-`main` branch (a `wt/<name>` worktree under `~/Code/rubies-repo/worktrees/<name>`) with ≥1 commit
   ahead of `origin/main`. If on `main`, refuse — nothing to ship (the main checkout is a read-only mirror).
2. Working tree committed. If there are uncommitted **feature** changes, commit them first with the standard
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. **Stage only the feature
   files** — `git add <paths>`, **never `git add -A`** — a worktree holds preview scaffolding (the
   `node_modules`/`.env` symlinks, copied `.claude/commands/*.md`) that must not land in the PR.
3. **Tests green**: `node --test customer-service/test/*.test.js` — all pass before shipping. (Rebase on
   `origin/main` first if behind, then re-run — see step 1 below.)

## Procedure
1. **Sync + push**: `git fetch origin && git rebase origin/main` (resolve nothing automatically — on conflict,
   stop and surface the files). Re-run the test suite after the rebase. Then `git push -u origin HEAD`.
2. **PR** (reuse if one already exists for the branch, else create):
   - `gh pr view --json number,url 2>/dev/null` to check.
   - If none: draft a title from the branch name + recent commits (≤70 chars, `feat:`/`fix:`/`chore:` style) and
     a short body (summary bullets + one-line test plan). Show Jamie, then
     `gh pr create --base main --title "<title>" --body "<body>"`.
3. **Merge**: `gh pr merge <num> --squash --delete-branch`
   - Merging to `main` trips a one-time auto-mode approval prompt (a deliberate guardrail). Jamie approves it in
     the moment, or has standing approval configured. If it hard-blocks, tell Jamie to approve or run the one
     command himself — do **NOT** edit settings to bypass it, and do **NOT** fall back to `git push origin
     HEAD:main` (direct push to the default branch is separately blocked by design).
   - On merge **conflict**: stop, surface the conflicting files, don't auto-resolve.
4. **Deploy**: Railway auto-deploys `main` — the `cs-dashboard` service (ops.rubyshines.com), the
   `webhook-server`, and the crons all redeploy from the merge. Live in ~1–2 min.
5. **Stop this branch's preview** (if one is running) — frees its `ra-N` ngrok domain and releases the worktree
   dir so removal is clean. Identify it by the preview server's working directory so other sessions' previews
   are never touched. **Never** use a broad `pkill ngrok` / `pkill node`.
   ```bash
   ROOT="$(git rev-parse --show-toplevel)"
   for pf in /tmp/preview-*.pids; do
     [ -e "$pf" ] || continue
     spid=$(sed -n 's/.*server_pid=\([0-9]*\).*/\1/p' "$pf")
     npid=$(sed -n 's/.*ngrok_pid=\([0-9]*\).*/\1/p' "$pf")
     aport=$(sed -n 's/.*app_port=\([0-9]*\).*/\1/p' "$pf")
     [ -n "$spid" ] && [ "$(lsof -a -d cwd -p "$spid" -Fn 2>/dev/null | sed -n 's/^n//p')" = "$ROOT" ] || continue
     kill "$spid" "$npid" 2>/dev/null
     rm -f "$pf" /tmp/preview-"$aport".*
     echo "🛑 Stopped preview on port $aport (freed its ngrok domain)"
   done
   ```
6. **Cleanup** — remove this worktree from the **main checkout** (you can't remove a worktree from inside it):
   ```bash
   git -C ~/Code/rubies-repo/rubies-automations fetch origin
   git -C ~/Code/rubies-repo/rubies-automations pull --ff-only        # refresh the read-only mirror
   git -C ~/Code/rubies-repo/rubies-automations worktree remove ~/Code/rubies-repo/worktrees/<name>
   ```
   (`--delete-branch` in step 3 already removed the remote branch; the local `wt/<name>` goes with the worktree.)
7. **Report**:
   ```
   ✅ Shipped — PR #<n> squash-merged to main
   PR:   <url>
   Live: https://ops.rubyshines.com  (Railway deploying — ~1–2 min)
   ```

## Notes
- The branch-protection hooks (`block-main-checkout-git.js`) block direct commits/merges on the **main
  checkout**, not `gh pr merge` (a remote op) — so `/ship` works from any worktree branch.
- This is the whole workflow: **worktree off `origin/main` → build → `/preview` → `/ship`.** Landing is a
  squash-merge PR, never a direct push to `main`.
