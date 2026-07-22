#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook: memory close-out gate on pushes to main.
 *
 * The rule (feedback_collaboration.md): memory updates ship in the same push
 * as the code they document — never as an afterthought. Sessions kept
 * forgetting the close-out question ("is memory updated?"), so this hook asks
 * it deterministically at the exact moment it matters: a push that lands on
 * origin/main.
 *
 * Behavior: when the command pushes to main (git push … main / HEAD:main) and
 * the outgoing range (origin/main..HEAD in the command's working tree) touches
 * NO .claude/memory/ path, block with a reminder. Two legitimate ways through:
 *   - the push already includes a memory commit → allowed automatically
 *   - the change genuinely needs no memory update → after running the memory
 *     close-out (propose deltas to Jamie or confirm none needed), re-run the
 *     same command prefixed with MEMORY_REVIEWED=1
 * The prefix is per-invocation and visible in shell history, so the assertion
 * "I checked, no memory needed" is explicit and auditable, never ambient.
 *
 * Exit 2 = block + feed stderr back to the agent. Exit 0 = allow. Fail-open on
 * anything unexpected (no command, parse error, not a git repo).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function allow() { process.exit(0); }

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { allow(); }

let data;
try { data = JSON.parse(raw); } catch { allow(); }

const command = data && data.tool_input && data.tool_input.command;
if (!command || typeof command !== 'string') allow();

// Only pushes that land on main (worktree-protocol `HEAD:main`, or a direct
// `git push origin main`). Branch pushes (PR flows, memory PRs) pass through.
const PUSH_TO_MAIN = /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\b(HEAD:main|HEAD:master|origin\s+main\b|origin\s+master\b)/;
if (!PUSH_TO_MAIN.test(command)) allow();

// Explicit, per-invocation override after the close-out check has been done.
if (/\bMEMORY_REVIEWED=1\b/.test(command)) allow();

// Resolve the effective directory the git command runs in (same convention as
// block-main-checkout-git.js): honour the LAST `cd <path>` in the command.
let dir = (data && data.cwd) || process.cwd();
const cdMatches = [...command.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)];
if (cdMatches.length) {
  let target = cdMatches[cdMatches.length - 1][1].replace(/^["']|["']$/g, '');
  if (target.startsWith('~')) target = path.join(os.homedir(), target.slice(1));
  dir = path.isAbsolute(target) ? target : path.resolve(dir, target);
}

let touched;
try {
  touched = execSync('git log --name-only --format= origin/main..HEAD', {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  allow(); // not a git repo / no upstream — fail open
}

if (/^\.claude\/memory\//m.test(touched)) allow();

process.stderr.write(
  'BLOCKED: memory close-out gate — this push to main contains no .claude/memory/ commit.\n' +
  'Per feedback_collaboration.md, memory updates ship in the same push as the code they document.\n' +
  'Before pushing, run the close-out: does this change alter what exists, how it works, a key\n' +
  'decision, or initiative progress? \n' +
  '  - If yes: propose the memory delta to Jamie, commit it on this branch, then push.\n' +
  '  - If genuinely no memory update is needed: re-run the SAME push command prefixed with\n' +
  '    MEMORY_REVIEWED=1 (e.g. `MEMORY_REVIEWED=1 git push origin HEAD:main`).\n'
);
process.exit(2);
