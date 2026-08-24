const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * The two git hooks decide WHICH directory a command runs in by reading `cd` out
 * of the command string. Both took the last `cd` anywhere in the command, which
 * is wrong whenever the command changes directory again AFTER the git verb — and
 * that is the everyday shape:
 *
 *   cd <worktree> && git push origin HEAD:main && cd <main checkout> && git pull
 *
 * memory-closeout-check then evaluated origin/main..HEAD in the read-only mirror,
 * where it is empty by definition, and blocked a push that DID carry a memory
 * commit. block-main-checkout-git had the same flaw with a worse failure mode:
 * `cd <main> && git commit && cd <worktree>` resolved to the worktree and allowed
 * a commit in the main checkout, the one thing it exists to stop.
 *
 * Built on a throwaway repo rather than this one: a hook test that reads ambient
 * repo state passes or fails for reasons that have nothing to do with the hooks.
 */
const HOOKS = path.join(__dirname, '..', '..', '.claude', 'hooks');

let TMP, MAIN, WORKTREE;
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooktest-'));
  const origin = path.join(TMP, 'origin.git');
  MAIN = path.join(TMP, 'main');
  WORKTREE = path.join(TMP, 'wt');

  git(['init', '--bare', '-b', 'main', origin], TMP);
  git(['clone', origin, MAIN], TMP);
  git(['config', 'user.email', 't@t.t'], MAIN);
  git(['config', 'user.name', 'T'], MAIN);
  fs.writeFileSync(path.join(MAIN, 'base.txt'), 'base\n');
  git(['add', '-A'], MAIN);
  git(['commit', '-m', 'base'], MAIN);
  git(['push', 'origin', 'main'], MAIN);

  // A worktree carrying a code change AND a memory change — the shape a correct
  // close-out produces.
  git(['worktree', 'add', WORKTREE, '-b', 'wt/x', 'origin/main'], MAIN);
  git(['config', 'user.email', 't@t.t'], WORKTREE);
  git(['config', 'user.name', 'T'], WORKTREE);
  fs.mkdirSync(path.join(WORKTREE, '.claude', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(WORKTREE, '.claude', 'memory', 'domain_x.md'), 'note\n');
  fs.writeFileSync(path.join(WORKTREE, 'code.js'), 'x\n');
  git(['add', '-A'], WORKTREE);
  git(['commit', '-m', 'code + memory'], WORKTREE);
});

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

/** @returns {{ code, stderr }} code 0 = allowed, 2 = blocked. */
function runHook(hook, command, cwd) {
  const payload = JSON.stringify({ cwd: cwd || MAIN, tool_input: { command } });
  try {
    execFileSync('node', [path.join(HOOKS, hook)], { input: payload, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, stderr: '' };
  } catch (err) {
    return { code: err.status, stderr: err.stderr || '' };
  }
}

// ── memory-closeout-check ───────────────────────────────────────────────────

test('a push carrying a memory commit is allowed when the command cds away afterwards', () => {
  // The exact shape that misfired all session.
  const cmd = `cd ${WORKTREE} && git push origin HEAD:main && cd ${MAIN} && git pull --ff-only`;
  const r = runHook('memory-closeout-check.js', cmd);
  assert.equal(r.code, 0, `should be allowed, got: ${r.stderr}`);
});

test('the same push with no trailing cd is allowed too', () => {
  assert.equal(runHook('memory-closeout-check.js', `cd ${WORKTREE} && git push origin HEAD:main`).code, 0);
});

test('a push with no memory commit in its range is still blocked', () => {
  // From the main checkout, origin/main..HEAD is empty — no memory commit.
  const r = runHook('memory-closeout-check.js', `cd ${MAIN} && git push origin HEAD:main && cd ${WORKTREE} && git log`);
  assert.equal(r.code, 2, 'the gate must still fire when there really is no memory commit');
  assert.match(r.stderr, /memory close-out gate/);
});

test('a branch push is ignored entirely', () => {
  assert.equal(runHook('memory-closeout-check.js', `cd ${MAIN} && git push origin HEAD:wt/foo`).code, 0);
  assert.equal(runHook('memory-closeout-check.js', `cd ${MAIN} && git status`).code, 0);
});

test('the explicit override still works', () => {
  assert.equal(runHook('memory-closeout-check.js', `cd ${MAIN} && MEMORY_REVIEWED=1 git push origin HEAD:main`).code, 0);
});

// ── block-main-checkout-git ─────────────────────────────────────────────────

test('a trailing cd cannot launder a commit made in the main checkout', () => {
  const cmd = `cd ${MAIN} && git commit -m x && cd ${WORKTREE} && git log`;
  assert.equal(runHook('block-main-checkout-git.js', cmd).code, 2);
});

test('committing in a worktree is allowed even when the command cds back afterwards', () => {
  const cmd = `cd ${WORKTREE} && git commit -m x && cd ${MAIN} && git pull`;
  assert.equal(runHook('block-main-checkout-git.js', cmd).code, 0);
});

test('mirror-refresh and rollback verbs still pass in the main checkout', () => {
  for (const verb of ['git fetch origin', 'git pull --ff-only', 'git status', 'git reset --hard HEAD~1', 'git push origin main']) {
    assert.equal(runHook('block-main-checkout-git.js', `cd ${MAIN} && ${verb}`).code, 0, verb);
  }
});

// A verb has to be in SUBCOMMAND POSITION. Matching it anywhere after `git`
// treats `-` and `.` as word boundaries, so read-only commands that merely
// contain a verb were blocked. `git merge-base` is the one that surfaced it.
test('read-only commands that merely contain a mutating verb are allowed', () => {
  const readOnly = [
    'git merge-base --is-ancestor abc HEAD',
    'git merge-tree abc def',
    'git commit-graph write',
    'git config merge.ff false',
    'git log --merge',
    'git log --no-merges --oneline',
    'git branch --merged main',
    'git cherry origin/main',
    'git show --stat HEAD',
  ];
  for (const cmd of readOnly) {
    assert.equal(runHook('block-main-checkout-git.js', `cd ${MAIN} && ${cmd}`).code, 0, cmd);
  }
});

test('the real verbs are still blocked in the main checkout', () => {
  for (const cmd of [
    'git commit -m x',
    'git merge origin/main',
    'git rebase origin/main',
    'git cherry-pick abc123',
    'git -c user.name=T commit -m x',   // a global option before the verb
    'git --no-pager commit -m x',
  ]) {
    assert.equal(runHook('block-main-checkout-git.js', `cd ${MAIN} && ${cmd}`).code, 2, cmd);
  }
});

// `git -C <dir>` relocates a command exactly like a cd, and the hook could not
// see it: the shell stayed in a worktree while git committed in the mirror.
test('git -C into the main checkout is blocked from anywhere', () => {
  const cmd = `cd ${WORKTREE} && git -C ${MAIN} commit -m x`;
  assert.equal(runHook('block-main-checkout-git.js', cmd).code, 2);
});

test('git -C into a worktree is allowed even when the shell sits in the mirror', () => {
  const cmd = `cd ${MAIN} && git -C ${WORKTREE} commit -m x`;
  assert.equal(runHook('block-main-checkout-git.js', cmd).code, 0);
});

test('git -C with a read-only verb is untouched', () => {
  assert.equal(runHook('block-main-checkout-git.js', `git -C ${MAIN} pull --ff-only`).code, 0);
  assert.equal(runHook('block-main-checkout-git.js', `git -C ${MAIN} worktree remove ${WORKTREE}`).code, 0);
});

test('a separator with no surrounding spaces still tokenises', () => {
  assert.equal(runHook('block-main-checkout-git.js', `cd ${MAIN}&&git commit -m x`).code, 2);
});

// ── command text is not all instructions ────────────────────────────────────
// A commit message documenting the worktree protocol contains example commands.
// Reading those as real ones blocked a legitimate commit and, worse, could move
// which tree the hook thinks it is protecting.

const { stripLiterals } = require('../../.claude/hooks/lib/commandText');

test('a heredoc commit message cannot smuggle a cd into the hook', () => {
  const stripped = stripLiterals([
    "cd /repo/wt && git commit -F - <<'EOF'",
    'hooks: fix the thing',
    '',
    '  cd /somewhere/else && git push origin HEAD:main',
    'EOF',
  ].join('\n'));
  assert.ok(stripped.includes('cd /repo/wt'), 'the real cd survives');
  assert.ok(!stripped.includes('/somewhere/else'), 'the message body does not');
});

test('a -m message cannot smuggle one either', () => {
  const stripped = stripLiterals('cd /repo/wt && git commit -m "see cd /elsewhere for context"');
  assert.ok(stripped.includes('cd /repo/wt'));
  assert.ok(!stripped.includes('/elsewhere'));
});

test('a quoted cd target is preserved', () => {
  assert.ok(stripLiterals('cd "/repo/with space" && git commit -m "x"').includes('/repo/with space'));
  assert.ok(stripLiterals("cd '/repo/other space' && git status").includes('/repo/other space'));
});

test('a commit whose message documents the protocol is still allowed from a worktree', () => {
  const cmd = `cd ${WORKTREE} && git commit -F - <<'EOF'\nfix\n\n  cd ${MAIN} && git pull --ff-only\nEOF`;
  assert.equal(runHook('block-main-checkout-git.js', cmd).code, 0,
    'the example in the message must not decide where the commit runs');
});

test('a real main-checkout commit is still blocked when the message mentions a worktree', () => {
  const cmd = `cd ${MAIN} && git commit -m "moved work to ${WORKTREE}"`;
  assert.equal(runHook('block-main-checkout-git.js', cmd).code, 2);
});
