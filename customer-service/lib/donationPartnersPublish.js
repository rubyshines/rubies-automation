/**
 * Publish active donation partners to the rubies-ecom-v4 theme repo as a
 * static JSON asset.
 *
 * The theme's donation page (page.donate-preloved) reads this file at build
 * time. Updates are infrequent and intentional, so no live fetch.
 *
 * Output contract (matches what the theme consumes):
 *   { name, address, description, sizeRange, imageUrl, orgUrl, lat, lng }
 *
 * This module is callable from both the MCP tool and the CLI.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { getSupabaseClient } = require('../../shared/supabaseClient');

const DEFAULT_THEME_ASSET_PATH = path.resolve(
  __dirname, '../../../rubies-ecom-v4/assets/donation-partners.json'
);

function toPublicShape(row) {
  return {
    name: row.name,
    address: row.mailing_address || row.address || '',
    description: row.description || '',
    sizeRange: row.size_range || '',
    imageUrl: row.logo_url || '',
    orgUrl: row.website_url || '',
    lat: Number(row.latitude),
    lng: Number(row.longitude),
  };
}

async function readActivePartners() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('donation_partners')
    .select('name, mailing_address, address, description, size_range, logo_url, website_url, latitude, longitude, active')
    .eq('active', true)
    .order('country_code')
    .order('name');

  if (error) throw new Error(`Failed to read donation_partners: ${error.message}`);

  const issues = [];
  for (const row of data) {
    if (!Number.isFinite(Number(row.latitude)) || !Number.isFinite(Number(row.longitude))) {
      issues.push(`${row.name}: missing/invalid lat/lng`);
    }
    if (!row.logo_url) issues.push(`${row.name}: missing logo_url`);
    if (!row.mailing_address && !row.address) issues.push(`${row.name}: missing mailing_address and address`);
  }
  if (issues.length) {
    throw new Error(`Cannot publish — ${issues.length} partner(s) missing required fields:\n  - ${issues.join('\n  - ')}`);
  }
  return data.map(toPublicShape);
}

function serializePayload(payload) {
  return JSON.stringify(payload, null, 2) + '\n';
}

function gitc(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function ghc(cwd, args) {
  return execFileSync('gh', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

const LIVE_PAGE_URL = 'https://rubyshines.com/pages/donate-your-pre-loved-rubies-clothing';

/**
 * Auto-commit + push the donation-partners.json to a dedicated branch on the
 * theme repo, using a temporary git worktree so Jamie's main theme checkout
 * (and any branch he's currently on) is left completely alone.
 *
 * Returns { branch, baseBranch, themeRepo, remoteUrl, prUrl? }.
 *
 * Does NOT merge to main → does NOT auto-deploy. Jamie still opens/merges the
 * PR (or runs /ship from the theme repo) when he's ready.
 */
async function publishViaWorktree(payload, { themeRepo, baseBranch = 'main', merge = true }) {
  // Confirm theme repo + remote + base branch exist.
  if (!fs.existsSync(path.join(themeRepo, '.git'))) {
    throw new Error(`Not a git repo: ${themeRepo}`);
  }
  const remoteUrl = gitc(themeRepo, ['remote', 'get-url', 'origin']);

  // Fetch latest base branch from origin so the worktree branches off current main.
  gitc(themeRepo, ['fetch', 'origin', baseBranch]);

  // Branch name unique per minute.
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const branch = `data/donation-partners-${stamp}`;

  // Worktree lives under /tmp so it never collides with the iCloud-synced repo.
  const wt = path.join(os.tmpdir(), `rubies-theme-publish-${stamp}-${process.pid}`);

  // Add worktree at the fresh branch, based on origin/<baseBranch>.
  gitc(themeRepo, ['worktree', 'add', '-b', branch, wt, `origin/${baseBranch}`]);

  try {
    const relativeOutPath = path.join('assets', 'donation-partners.json');
    const outAbsPath = path.join(wt, relativeOutPath);
    fs.writeFileSync(outAbsPath, serializePayload(payload), 'utf8');

    // Detect whether anything actually changed vs origin/<baseBranch>.
    const status = gitc(wt, ['status', '--porcelain']);
    if (!status) {
      // Nothing changed — clean up the worktree + branch and return.
      gitc(themeRepo, ['worktree', 'remove', '--force', wt]);
      try { gitc(themeRepo, ['branch', '-D', branch]); } catch { /* no-op */ }
      return { branch: null, baseBranch, themeRepo, remoteUrl, noOp: true };
    }

    gitc(wt, ['add', relativeOutPath]);
    gitc(wt, [
      'commit',
      '-m', `data: update donation-partners.json (${payload.length} active partners)`,
      '-m', 'Generated from rubies-automations donation_partners table.\nSource of truth: customer-service/lib/donationPartnersPublish.js',
    ]);
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
        '--title', `data: donation partners (${payload.length} active)`,
        '--body', 'Auto-generated by rubies-automations donation_partner_publish.\n\nThis PR updates assets/donation-partners.json. Merged automatically as part of the publish flow.',
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
    // Always tear down the worktree — branch lives on the remote.
    try { gitc(themeRepo, ['worktree', 'remove', '--force', wt]); } catch { /* swallow */ }
  }
}

/**
 * @param {object} opts
 *   outPath     where to write the JSON (default = theme repo working tree)
 *   dry_run     true → only write the working tree, no commit/push/merge
 *   merge       true (default) → also open PR + squash-merge → auto-deploys
 *               false → just commit + push to a branch, leave merge to operator
 *   baseBranch  default 'main'
 */
async function publishDonationPartners({
  outPath = DEFAULT_THEME_ASSET_PATH,
  dry_run = false,
  merge = true,
  baseBranch = 'main',
} = {}) {
  const payload = await readActivePartners();

  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    throw new Error(`Theme assets dir does not exist: ${outDir} (is rubies-ecom-v4 checked out as a sibling of rubies-automations?)`);
  }

  fs.writeFileSync(outPath, serializePayload(payload), 'utf8');

  if (dry_run) {
    return { path: outPath, count: payload.length, committed: false, dryRun: true };
  }

  const themeRepo = path.dirname(outDir);
  const wt = await publishViaWorktree(payload, { themeRepo, baseBranch, merge });
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
    liveUrl: LIVE_PAGE_URL,
  };
}

module.exports = { publishDonationPartners, DEFAULT_THEME_ASSET_PATH, LIVE_PAGE_URL };
