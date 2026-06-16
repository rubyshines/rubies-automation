#!/usr/bin/env node
/**
 * PreToolUse hook: block code edits to the main checkout while it sits on main/master.
 *
 * Per the worktree rule (feedback_technical_rules.md → "Code edits happen in worktrees,
 * not the main checkout"), any session editing code must work in a worktree. Worktrees live
 * on wt/* or sprint/* branches, so the check is simply: is the target file in a working tree
 * whose current branch is main (or master)? If yes, and it isn't an exempt memory/plan/config
 * file, block and tell the agent to create a worktree first.
 *
 * Exit 2 = block the tool call and feed stderr back to the agent. Exit 0 = allow.
 * Fail-open: anything unexpected (no path, parse error, not a git repo) allows the edit.
 */
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

function allow() { process.exit(0); }

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { allow(); }

let data;
try { data = JSON.parse(raw); } catch { allow(); }

const filePath = data && data.tool_input && data.tool_input.file_path;
if (!filePath) allow();

// Exempt: memory, plans, and anything under .claude/ (settings, hooks), plus CLAUDE.md.
// These are explicitly allowed on main by the worktree rule.
const exemptSubstrings = ['/.claude/'];
if (exemptSubstrings.some((s) => filePath.includes(s))) allow();
if (path.basename(filePath) === 'CLAUDE.md') allow();

// Find the branch of the working tree containing the file.
let dir = path.dirname(filePath);
// Walk up to the nearest existing directory (handles Write to a not-yet-created subdir).
while (dir && dir !== '/' && !fs.existsSync(dir)) dir = path.dirname(dir);

let branch = '';
try {
  branch = execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim();
} catch {
  allow(); // not a git repo — not our concern
}

if (branch === 'main' || branch === 'master') {
  process.stderr.write(
    `BLOCKED: ${filePath}\n` +
    `This file is in the main checkout, currently on branch '${branch}'. Per the worktree ` +
    `rule, code edits must happen in a worktree, never the main checkout (Railway deploys from ` +
    `main; concurrent sessions share this tree). Create one first:\n\n` +
    `  git worktree add ~/Code/rubies-repo/worktrees/<name> -b wt/<name>\n` +
    `  ln -sf "$(git rev-parse --show-toplevel)/.env" ~/Code/rubies-repo/worktrees/<name>/.env\n` +
    `  ln -sfn "$(git rev-parse --show-toplevel)/node_modules" ~/Code/rubies-repo/worktrees/<name>/node_modules\n\n` +
    `Then edit the file at its worktree path. (Memory, plans, .claude/* and CLAUDE.md are ` +
    `exempt and may be edited on main.)\n`
  );
  process.exit(2);
}

allow();
