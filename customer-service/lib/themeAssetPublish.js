/**
 * Shared theme-asset publisher — writes a generated JSON payload into the
 * rubies-ecom-v4 theme repo and lands it via a temporary git worktree + PR.
 *
 * Extracted from donationPartnersPublish.js and storeLocatorPublish.js, which
 * carried copy-pasted ~150-line publish flows that had already diverged on
 * branch cleanup. The finally block here keeps the correct ordering: remove
 * the worktree FIRST, then delete the local branch (a branch can't be deleted
 * while checked out in a worktree).
 *
 * Callers keep only their read/validate/shape logic and pass:
 *   payload          array — the JSON payload (also used for counts)
 *   relativeOutPath  e.g. 'assets/donation-partners.json'
 *   branchPrefix     e.g. 'data/donation-partners'
 *   commitTitle / commitBody / prTitle / prBody
 *   themeRepo        absolute path to the theme checkout
 *   baseBranch       default 'main'
 *   merge            true (default) → open PR + squash-merge (auto-deploys via
 *                    the Shopify GitHub integration); false → push branch only
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function serializePayload(payload) {
  return JSON.stringify(payload, null, 2) + '\n';
}

function gitc(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function ghc(cwd, args) {
  return execFileSync('gh', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

/**
 * Auto-commit + push the asset to a dedicated branch on the theme repo, using
 * a temporary git worktree so the main theme checkout (and any branch Jamie is
 * currently on) is left completely alone.
 *
 * Returns { branch, baseBranch, themeRepo, remoteUrl, merged?, prUrl?,
 * mergeError?, mergeWarning?, noOp? }.
 */
async function publishViaWorktree(payload, {
  themeRepo,
  relativeOutPath,
  branchPrefix,
  commitTitle,
  commitBody,
  prTitle,
  prBody,
  baseBranch = 'main',
  merge = true,
}) {
  if (!fs.existsSync(path.join(themeRepo, '.git'))) {
    throw new Error(`Not a git repo: ${themeRepo}`);
  }
  const remoteUrl = gitc(themeRepo, ['remote', 'get-url', 'origin']);

  // Fetch latest base branch from origin so the worktree branches off current main.
  gitc(themeRepo, ['fetch', 'origin', baseBranch]);

  // Branch name unique per minute.
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const branch = `${branchPrefix}-${stamp}`;

  // Worktree lives under /tmp so it never collides with the iCloud-synced repo.
  const wt = path.join(os.tmpdir(), `rubies-theme-publish-${stamp}-${process.pid}`);

  gitc(themeRepo, ['worktree', 'add', '-b', branch, wt, `origin/${baseBranch}`]);

  try {
    const outAbsPath = path.join(wt, relativeOutPath);
    fs.writeFileSync(outAbsPath, serializePayload(payload), 'utf8');

    // Detect whether anything actually changed vs origin/<baseBranch>.
    const status = gitc(wt, ['status', '--porcelain']);
    if (!status) {
      return { branch: null, baseBranch, themeRepo, remoteUrl, noOp: true };
    }

    gitc(wt, ['add', relativeOutPath]);
    gitc(wt, ['commit', '-m', commitTitle, '-m', commitBody]);
    gitc(wt, ['push', '-u', 'origin', branch]);

    if (!merge) {
      return { branch, baseBranch, themeRepo, remoteUrl, merged: false };
    }

    // Open PR + squash-merge + delete branch. Shopify GitHub integration
    // auto-pulls main within ~30s, so this is effectively the deploy step.
    let prUrl;
    try {
      prUrl = ghc(wt, [
        'pr', 'create',
        '--base', baseBranch,
        '--head', branch,
        '--title', prTitle,
        '--body', prBody,
      ]);
    } catch (e) {
      return { branch, baseBranch, themeRepo, remoteUrl, merged: false, mergeError: `pr create failed: ${e.message}` };
    }

    let mergeWarning = null;
    try {
      ghc(wt, ['pr', 'merge', prUrl, '--squash', '--delete-branch']);
    } catch (e) {
      // `gh pr merge --delete-branch` tries to fast-forward / switch the local
      // checkout to base after merging. If the operator has main checked out
      // in another worktree, that step errors AFTER the merge has actually
      // landed. Re-check the PR state authoritatively before reporting a
      // failure.
      try {
        const state = ghc(wt, ['pr', 'view', prUrl, '--json', 'state,mergedAt']);
        const parsed = JSON.parse(state);
        if (parsed.state === 'MERGED') {
          mergeWarning = `Merge succeeded but local cleanup hit a non-fatal error: ${e.message.split('\n').pop()}`;
        } else {
          return { branch, baseBranch, themeRepo, remoteUrl, merged: false, prUrl, mergeError: `pr merge failed (state=${parsed.state}): ${e.message}` };
        }
      } catch (verifyErr) {
        return { branch, baseBranch, themeRepo, remoteUrl, merged: false, prUrl, mergeError: `pr merge failed and state-check also failed: ${e.message}` };
      }
    }

    return { branch, baseBranch, themeRepo, remoteUrl, merged: true, prUrl, mergeWarning };
  } finally {
    // Remove worktree first, THEN delete the local branch — can't delete a
    // branch while it's checked out in a worktree. Branch lives on the remote
    // (or was never pushed on the no-op path).
    try { gitc(themeRepo, ['worktree', 'remove', '--force', wt]); } catch { /* swallow */ }
    try { gitc(themeRepo, ['branch', '-D', branch]); } catch { /* swallow */ }
  }
}

/**
 * Full publish orchestration shared by the theme-asset publishers: write the
 * payload into the theme working tree, then (unless dry_run) run the worktree
 * publish flow. Returns the standard result shape both MCP tools render.
 */
async function publishThemeAsset(payload, {
  outPath,
  dry_run = false,
  merge = true,
  baseBranch = 'main',
  liveUrl,
  ...worktreeOpts // relativeOutPath, branchPrefix, commitTitle, commitBody, prTitle, prBody
}) {
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    throw new Error(`Theme assets dir does not exist: ${outDir} (is rubies-ecom-v4 checked out as a sibling of rubies-automations?)`);
  }

  fs.writeFileSync(outPath, serializePayload(payload), 'utf8');

  if (dry_run) {
    return { path: outPath, count: payload.length, committed: false, dryRun: true };
  }

  const themeRepo = path.dirname(outDir);
  const wt = await publishViaWorktree(payload, { themeRepo, baseBranch, merge, ...worktreeOpts });
  return {
    path: outPath,
    count: payload.length,
    committed: !wt.noOp,
    merged: !!wt.merged,
    noOp: !!wt.noOp,
    branch: wt.branch,
    baseBranch: wt.baseBranch,
    themeRepo: wt.themeRepo,
    remoteUrl: wt.remoteUrl,
    prUrl: wt.prUrl,
    mergeError: wt.mergeError,
    mergeWarning: wt.mergeWarning,
    liveUrl,
  };
}

module.exports = { publishThemeAsset, publishViaWorktree, serializePayload };
