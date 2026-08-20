#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook: block history-mutating git commands in the MAIN checkout.
 *
 * The worktree rule keeps the shared `main` checkout out of integration entirely:
 *   - branch every worktree off `origin/main` (after a fetch), not local HEAD
 *   - land work by pushing the worktree branch straight to `origin/main`
 *   - the local `main` checkout is a READ-ONLY MIRROR of the remote — nobody
 *     ever commits/merges/rebases into it
 *
 * Why: if a session commits or fast-forward-merges into the local `main` checkout
 * and doesn't push immediately, local `main` ends up ahead of `origin/main`. The
 * next session then branches its worktree off that ahead-of-remote `main`
 * (inheriting the unpushed commit) and stacks its own work on top — so a single
 * push deploys another session's in-flight work. Taking local `main` out of
 * integration removes the coupling.
 *
 * This hook enforces that by blocking `git commit | merge | rebase | cherry-pick`
 * when the command's working tree IS the main checkout (i.e. NOT a linked worktree)
 * and it sits on main/master. Linked worktrees (wt/*, sprint/*) are unaffected.
 * Read-only refresh of the mirror (`git fetch`, `git pull --ff-only`) and rollback
 * (`git reset` + push) are intentionally NOT blocked.
 *
 * Exit 2 = block + feed stderr back to the agent. Exit 0 = allow. Fail-open on
 * anything unexpected (no command, parse error, not a git repo).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { stripLiterals } = require('./lib/commandText');

function allow() { process.exit(0); }

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { allow(); }

let data;
try { data = JSON.parse(raw); } catch { allow(); }

const rawCommand = data && data.tool_input && data.tool_input.command;
if (!rawCommand || typeof rawCommand !== 'string') allow();
// See memory-closeout-check: quoted strings and heredoc bodies are data, not
// instructions, and reading them as instructions moves this hook's mind about
// which tree the command runs in.
const command = stripLiterals(rawCommand);

// Only care about history-mutating git verbs. `reset`, `pull`, `fetch`, `push`
// are deliberately allowed (mirror refresh + rollback escape hatch).
const MUTATING = /\bgit\b[^\n;&|]*?\b(commit|merge|rebase|cherry-pick)\b/;
const mutatingMatch = MUTATING.exec(command);
if (!mutatingMatch) allow();

// Resolve the directory the MUTATING command runs in: the last `cd` BEFORE it,
// not the last `cd` in the whole command. Taking the final one is wrong in both
// directions, and one of them is a hole rather than an annoyance:
//   cd <main> && git commit && cd <worktree>   → resolved to the worktree and
//   ALLOWED a commit in the main checkout, which is the single thing this hook
//   exists to stop.
// The mirror case (cd <worktree> && git commit && cd <main>) merely blocked
// legitimate work, which is how the flaw was noticed.
const cwd = (data && data.cwd) || process.cwd();
let dir = cwd;
const expandHome = (p) =>
  p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
const cdRe = /(?:^|&&|;|\|)\s*cd\s+("([^"]+)"|'([^']+)'|([^\s&;|]+))/g;
let m, lastCd = null;
while ((m = cdRe.exec(command)) !== null) {
  if (m.index < mutatingMatch.index) lastCd = m;
}
if (lastCd) {
  const target = expandHome(lastCd[2] || lastCd[3] || lastCd[4]);
  dir = path.isAbsolute(target) ? target : path.resolve(cwd, target);
}

// Walk up to the nearest existing directory (defensive).
while (dir && dir !== '/' && !fs.existsSync(dir)) dir = path.dirname(dir);

let gitDir, commonDir, branch;
try {
  const out = execSync('git rev-parse --git-dir --git-common-dir --abbrev-ref HEAD', {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim().split('\n');
  gitDir = path.resolve(dir, out[0]);
  commonDir = path.resolve(dir, out[1]);
  branch = (out[2] || '').trim();
} catch {
  allow(); // not a git repo — not our concern
}

// In the main checkout, --git-dir === --git-common-dir. In a linked worktree they
// differ (git-dir points at .git/worktrees/<name>). Only block the main checkout.
const isMainCheckout = gitDir === commonDir;
const onMain = branch === 'main' || branch === 'master';

if (isMainCheckout && onMain) {
  process.stderr.write(
    `BLOCKED: history-mutating git command in the MAIN checkout (on '${branch}').\n` +
    `The local main checkout is a READ-ONLY MIRROR of origin/main — never commit, ` +
    `merge, rebase, or cherry-pick into it. Do your work in a worktree and push it ` +
    `straight to origin/main:\n\n` +
    `  git fetch origin\n` +
    `  git worktree add ~/Code/rubies-repo/worktrees/<name> -b wt/<name> origin/main\n` +
    `  ln -sf "$(git rev-parse --show-toplevel)/.env" ~/Code/rubies-repo/worktrees/<name>/.env\n` +
    `  ln -sfn "$(git rev-parse --show-toplevel)/node_modules" ~/Code/rubies-repo/worktrees/<name>/node_modules\n` +
    `  # ...edit + commit inside the worktree, run tests, then land it:\n` +
    `  cd ~/Code/rubies-repo/worktrees/<name>\n` +
    `  git fetch origin && git rebase origin/main && git push origin HEAD:main\n\n` +
    `Refresh the read-only mirror with 'git pull --ff-only' (allowed). ` +
    `Rollback (git reset + push) is also allowed.\n`
  );
  process.exit(2);
}

allow();
